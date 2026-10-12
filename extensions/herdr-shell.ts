import { promises as fs } from "node:fs";
import net from "node:net";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { formatSize, truncateTail, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  createHerdrClient, extractPaneId, extractWorkspaceId, formatHerdrError, getRecord, getString,
  isNotFound, parseVersion, supportsTabShell, type HerdrClient,
} from "./herdr-client.ts";
import { HerdrEventSubscriber, type HerdrEventEnvelope } from "./herdr-events.ts";
import { sendTerminalViewerCommand, terminalViewerCommand, waitForTerminalViewerSocket } from "./excalidraw-terminal-viewer.ts";
import { createPlanBoardEndpoint, planBoardCommand, sendPlanBoardCommand, waitForPlanBoardSocket } from "./plan-board-process.ts";
import { validatePlanBoardSnapshot, type PlanBoardSnapshot } from "./plan-board.ts";
import {
  readHerdrBindings, removeHerdrBinding, upsertHerdrBinding, updateHerdrBindings,
  type HerdrBinding, type HerdrBindingRole,
} from "./herdr-state.ts";

const DEFAULT_OUTPUT_LINES = 80;
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_BYTES = 24 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
const SHELL_READY_TIMEOUT_MS = 6_000;
const READY_POLL_MS = 100;
const NOTES_READY_TIMEOUT_MS = 5_000;
const NOTES_ROLE: HerdrBindingRole = "notes-viewer";
const SHELL_ROLE: HerdrBindingRole = "generic-shell";
export const VISUALIZATION_VIEWER_ROLE: HerdrBindingRole = "visualization-viewer";
const TERMINAL_VIEWER_READY_TIMEOUT_MS = 6_000;
const TERMINAL_VIEWER_ENTRY = fileURLToPath(new URL("./excalidraw-terminal-viewer.ts", import.meta.url));
export const PLAN_BOARD_ROLE: HerdrBindingRole = "plan-board";
const PLAN_BOARD_READY_TIMEOUT_MS = 6_000;
const PLAN_BOARD_ENTRY = fileURLToPath(new URL("./plan-board-process.ts", import.meta.url));

const HerdrShellParameters = Type.Object({
  action: StringEnum(["open", "run", "read_output", "status", "close"] as const, { description: "Operation to perform in the managed Herdr side-by-side pane" }),
  command: Type.Optional(Type.String({ description: "Shell command for open/run. Use for long-running servers, watchers, and processes." })),
  cwd: Type.Optional(Type.String({ description: "Working directory, relative to the current Pi project or absolute. Defaults to the current Pi directory." })),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OUTPUT_LINES, description: "Maximum recent output lines for read_output (default 80, maximum 500)." })),
});
type HerdrShellInput = Static<typeof HerdrShellParameters>;

export interface HerdrContext { workspaceId: string; parentTabId?: string; paneId?: string; }
interface HerdrNotesViewerRequest {
  role: typeof NOTES_ROLE;
  command?: string;
  cwd: string;
  socket: string;
  signal?: AbortSignal;
  respond: (result: { ok: boolean; error?: string; binding?: HerdrBinding; existing?: boolean }) => void;
}
export interface HerdrTerminalViewerRequest {
  role: typeof VISUALIZATION_VIEWER_ROLE;
  cwd: string;
  socket: string;
  scene: Record<string, unknown>;
  signal?: AbortSignal;
  respond: (result: { ok: boolean; error?: string; binding?: HerdrBinding; existing?: boolean; revision?: number }) => void;
}
interface HerdrTerminalViewerStatusRequest {
  role: typeof VISUALIZATION_VIEWER_ROLE;
  cwd: string;
  signal?: AbortSignal;
  respond: (result: { ok: boolean; error?: string; status?: "ready" | "closed"; binding?: HerdrBinding; revision?: number }) => void;
}
export interface HerdrPlanBoardRequest {
  role: typeof PLAN_BOARD_ROLE;
  cwd: string;
  socket: string;
  snapshot: PlanBoardSnapshot;
  signal?: AbortSignal;
  respond: (result: { ok: boolean; error?: string; binding?: HerdrBinding; existing?: boolean; revision?: number }) => void;
}
interface HerdrPlanBoardStatusRequest {
  role: typeof PLAN_BOARD_ROLE;
  cwd: string;
  signal?: AbortSignal;
  respond: (result: { ok: boolean; error?: string; status?: "ready" | "closed"; binding?: HerdrBinding; revision?: number }) => void;
}
interface PaneInspection { pane: Record<string, unknown>; terminalId?: string; shellReady: boolean; }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Carry an explicit scene only across updates in the same Plan Board scope. */
export function preservePlanBoardScene(current: PlanBoardSnapshot | undefined, next: PlanBoardSnapshot): PlanBoardSnapshot {
  if (!current || current.status === "cleared" || next.status === "cleared" || next.scene) return next;
  const sameScope = ["repository", "branch", "root", "sessionId"].every((key) => current.identity[key as keyof typeof current.identity] === next.identity[key as keyof typeof next.identity]);
  return sameScope && current.scene ? { ...next, scene: current.scene } : next;
}

function describeCommand(command: string | undefined): string {
  if (!command) return "interactive shell";
  const firstLine = command.split(/\r?\n/, 1)[0] ?? command;
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}
function toolResult(text: string, details: Record<string, unknown> = {}) { return { content: [{ type: "text" as const, text }], details }; }
function bindingDetails(binding: HerdrBinding) { return { paneId: binding.paneId, ownerPaneId: binding.ownerPaneId, terminalId: binding.terminalId, workspaceId: binding.workspaceId, parentTabId: binding.parentTabId, role: binding.role }; }

export function truncateHerdrOutput(output: string, maxLines: number) {
  const sanitized = output.replace(/\r\n?/g, "\n").replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const result = truncateTail(sanitized, { maxLines, maxBytes: MAX_OUTPUT_BYTES });
  const marker = result.truncated ? `\n\n[Recent output truncated by ${result.truncatedBy ?? "limit"}: showing ${result.outputLines}/${result.totalLines} lines and ${formatSize(result.outputBytes)}/${formatSize(result.totalBytes)}. Inspect the Herdr pane for the complete requested window.]` : "";
  return { text: `${result.content}${marker}`, truncation: { truncated: result.truncated, truncatedBy: result.truncatedBy, totalLines: result.totalLines, totalBytes: result.totalBytes, outputLines: result.outputLines, outputBytes: result.outputBytes, maxLines: result.maxLines, maxBytes: result.maxBytes } };
}

async function resolveWorkingDirectory(ctx: ExtensionContext, requestedCwd: string | undefined): Promise<string> {
  const candidate = resolve(ctx.cwd, requestedCwd ?? ".");
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isDirectory()) throw new Error(`Working directory is not a directory: ${candidate}`);
    return await fs.realpath(candidate);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Working directory")) throw error;
    throw new Error(`Working directory is unavailable: ${candidate}`);
  }
}

export function extractCurrentContext(value: unknown): HerdrContext | undefined {
  const result = getRecord(value, "result") ?? value;
  const pane = getRecord(result, "pane");
  const workspaceId = getString(pane, "workspace_id", "workspaceId") ?? extractWorkspaceId(value);
  const parentTabId = getString(pane, "tab_id", "tabId") ?? getString(result, "tab_id", "tabId");
  const paneId = extractPaneId(value);
  // A tab is part of the scope. Never collapse an unscoped response into a
  // generic "current" binding, which could cross-contaminate tabs.
  if (!workspaceId || !parentTabId || !paneId) return undefined;
  return { workspaceId, parentTabId, paneId };
}

/** Always ask Herdr for the caller's live context; inherited pane IDs can be stale after moves. */
export async function getHerdrContext(client: HerdrClient): Promise<HerdrContext> {
  const current = await client.run(["pane", "current", "--current"], { timeout: 5_000 });
  const context = extractCurrentContext(current);
  if (!context) throw new Error("Could not determine the current live Herdr pane and tab. Reattach Pi to a Herdr pane and retry.");
  return context;
}

export function herdrShellBindingKey(context: HerdrContext, cwd: string, role = SHELL_ROLE): string {
  if (!context.parentTabId) throw new Error("Cannot bind a Herdr pane without its parent tab identifier.");
  if (!context.paneId) throw new Error("Cannot bind a Herdr pane without its owning Pi pane identifier.");
  return `${role}|${context.workspaceId}|${context.parentTabId}|${context.paneId}|${cwd}`;
}
function bindingKey(context: HerdrContext, cwd: string, role = SHELL_ROLE): string {
  return herdrShellBindingKey(context, cwd, role);
}
function isLegacyGenericShellBinding(binding: HerdrBinding, context: HerdrContext, cwd: string): boolean {
  return binding.role === SHELL_ROLE && binding.ownerPaneId === undefined &&
    binding.workspaceId === context.workspaceId && binding.parentTabId === context.parentTabId && binding.cwd === cwd;
}
function notesBindingKey(root: string): string { return `${NOTES_ROLE}|${root}`; }
async function ensureSupportedHerdr(client: HerdrClient): Promise<string> {
  const raw = await client.runText(["--version"], { timeout: 3_000 });
  const version = parseVersion(raw);
  if (!version || !supportsTabShell(version)) throw new Error(`Herdr ${raw || "version is unknown"} does not support the tab/pane controls required by herdr_shell. Upgrade Herdr to 0.7.5 or newer.`);
  return raw;
}
function paneRecord(value: unknown): Record<string, unknown> | undefined { const pane = getRecord(value, "pane") ?? value; return isRecord(pane) ? pane : undefined; }
function listedPanes(value: unknown): Record<string, unknown>[] {
  const panes = getRecord(value, "panes")?.items ?? (isRecord(value) ? value.panes : undefined);
  return Array.isArray(panes) ? panes.filter(isRecord) : [];
}
function bindingScopeMatches(pane: Record<string, unknown>, binding: HerdrBinding): boolean {
  if (getString(pane, "workspace_id", "workspaceId") !== binding.workspaceId) return false;
  const tabId = getString(pane, "tab_id", "tabId");
  if (binding.parentTabId !== undefined && tabId !== binding.parentTabId) return false;
  const cwd = getString(pane, "cwd");
  return cwd === undefined || cwd === binding.cwd;
}
export function hasLostGenericShellOwnership(binding: HerdrBinding, inspection: PaneInspection): boolean {
  return binding.role === SHELL_ROLE && binding.terminalId !== undefined && inspection.terminalId !== undefined && binding.terminalId !== inspection.terminalId;
}
function processInfoRecord(value: unknown): Record<string, unknown> | undefined { const info = getRecord(value, "process_info") ?? value; return isRecord(info) ? info : undefined; }
export function isShellForeground(info: Record<string, unknown>): boolean {
  const shellPid = info.shell_pid;
  const processes = info.foreground_processes;
  if (typeof shellPid !== "number" || !Array.isArray(processes)) return false;
  // Herdr's process_info is authoritative: only the pane's own shell may receive pane.run.
  return processes.some((process) => isRecord(process) && process.pid === shellPid);
}
export async function getPaneProcessInfo(client: HerdrClient, paneId: string, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
  return processInfoRecord(await client.run(["pane", "process-info", "--pane", paneId], { timeout: 5_000, signal }));
}

function processContainsNvim(info: Record<string, unknown>, socket: string): boolean {
  const processes = info.foreground_processes;
  if (!Array.isArray(processes)) return false;
  return processes.some((process) => {
    if (!isRecord(process)) return false;
    const name = typeof process.name === "string" ? process.name.toLowerCase() : "";
    const argv = Array.isArray(process.argv) ? process.argv.filter((part): part is string => typeof part === "string").join(" ") : "";
    const cmdline = typeof process.cmdline === "string" ? process.cmdline : "";
    return (name === "nvim" || name === "neovim" || argv.includes("nvim") || cmdline.includes("nvim")) && (argv.includes(socket) || cmdline.includes(socket));
  });
}

export function processContainsTerminalViewer(info: Record<string, unknown>, socket: string, executable = process.execPath, entry = TERMINAL_VIEWER_ENTRY): boolean {
  const processes = info.foreground_processes;
  if (!Array.isArray(processes)) return false;
  return processes.some((process) => {
    if (!isRecord(process) || !Array.isArray(process.argv)) return false;
    const argv = process.argv.filter((part): part is string => typeof part === "string");
    // Do not accept a look-alike script or a shell command containing the
    // viewer name. Herdr ownership requires the exact launch argv we emit.
    return argv.length === 5 && argv[0] === executable && argv[1] === "--experimental-strip-types" && argv[2] === entry && argv[3] === "--socket" && argv[4] === socket;
  });
}

export function processContainsPlanBoard(info: Record<string, unknown>, socket: string, executable = process.execPath, entry = PLAN_BOARD_ENTRY): boolean {
  const processes = info.foreground_processes;
  if (!Array.isArray(processes)) return false;
  return processes.some((process) => {
    if (!isRecord(process) || !Array.isArray(process.argv)) return false;
    const argv = process.argv.filter((part): part is string => typeof part === "string");
    return argv.length === 5 && argv[0] === executable && argv[1] === "--experimental-strip-types" && argv[2] === entry && argv[3] === "--socket" && argv[4] === socket;
  });
}

async function paneExists(client: HerdrClient, paneId: string, signal?: AbortSignal): Promise<boolean> {
  try { return extractPaneId(paneRecord(await client.run(["pane", "get", paneId], { timeout: 5_000, signal }))) === paneId; }
  catch (error) { if (isNotFound(error)) return false; throw error; }
}

async function inspectBinding(client: HerdrClient, binding: HerdrBinding, signal?: AbortSignal): Promise<PaneInspection | undefined> {
  try {
    // list verifies that the pane still belongs to the recorded topology; get
    // supplies the current record rather than accepting an ID's mere existence.
    const listed = await client.run(["pane", "list"], { timeout: 5_000, signal });
    const listedPane = listedPanes(listed).find((pane) => getString(pane, "pane_id", "paneId", "id") === binding.paneId);
    if (!listedPane) return undefined;
    const got = paneRecord(await client.run(["pane", "get", binding.paneId], { timeout: 5_000, signal }));
    if (!got || extractPaneId(got) !== binding.paneId) return undefined;
    const terminalId = getString(got, "terminal_id", "terminalId");
    if (!bindingScopeMatches(got, binding)) return undefined;
    const info = await getPaneProcessInfo(client, binding.paneId, signal);
    return { pane: got, terminalId, shellReady: !!info && isShellForeground(info) };
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function createPane(client: HerdrClient, context: HerdrContext, cwd: string, signal?: AbortSignal): Promise<{ paneId: string; workspaceId: string; terminalId?: string }> {
  const split = (target: string[]) => ["pane", "split", ...target, "--direction", "right", "--cwd", cwd, "--no-focus"];
  let created: unknown;
  try { created = await client.run(split(context.paneId ? ["--pane", context.paneId] : ["--current"]), { timeout: COMMAND_TIMEOUT_MS, signal }); }
  catch (error) {
    if (!context.paneId || !isNotFound(error)) throw error;
    try { created = await client.run(split(["--current"]), { timeout: COMMAND_TIMEOUT_MS, signal }); }
    catch (fallback) { throw new AggregateError([error, fallback], `Herdr caller pane ${context.paneId} was unavailable and the current pane fallback failed: ${formatHerdrError(fallback)}`); }
  }
  const paneId = extractPaneId(created);
  if (!paneId) throw new Error("Herdr created a pane but did not return its pane identifier.");
  const pane = paneRecord(created);
  return { paneId, workspaceId: extractWorkspaceId(created) ?? context.workspaceId, terminalId: getString(pane, "terminal_id", "terminalId") };
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Herdr operation was cancelled.");
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => done(signal?.reason instanceof Error ? signal.reason : new Error("Herdr operation was cancelled."));
    function done(error?: Error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    }
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function closeCreatedPane(client: HerdrClient, paneId: string): Promise<void> {
  // Cleanup must still run after the caller's AbortSignal fired.
  try { await client.run(["pane", "close", paneId], { timeout: COMMAND_TIMEOUT_MS }); }
  catch (error) { if (!isNotFound(error)) throw error; }
}

async function waitForShellReady(client: HerdrClient, binding: HerdrBinding, signal?: AbortSignal): Promise<PaneInspection> {
  const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const inspection = await inspectBinding(client, binding, signal);
    if (inspection?.shellReady) return inspection;
    await wait(READY_POLL_MS, signal);
  }
  throw new Error(`New Herdr pane ${binding.paneId} did not reach an interactive shell prompt within ${SHELL_READY_TIMEOUT_MS / 1_000} seconds.`);
}

async function createOwnedPane(client: HerdrClient, context: HerdrContext, cwd: string, role: HerdrBindingRole, key: string, signal?: AbortSignal): Promise<HerdrBinding> {
  const created = await createPane(client, context, cwd, signal);
  const now = new Date().toISOString();
  const provisional: HerdrBinding = {
    key,
    role,
    workspaceId: created.workspaceId,
    parentTabId: context.parentTabId,
    ...((role === SHELL_ROLE || role === VISUALIZATION_VIEWER_ROLE || role === PLAN_BOARD_ROLE) && context.paneId ? { ownerPaneId: context.paneId } : {}),
    paneId: created.paneId,
    terminalId: created.terminalId,
    cwd,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const inspection = await waitForShellReady(client, provisional, signal);
    const binding = { ...provisional, ...(inspection.terminalId ? { terminalId: inspection.terminalId } : {}) };
    await upsertHerdrBinding(binding);
    return binding;
  } catch (error) {
    try { await closeCreatedPane(client, created.paneId); }
    catch (closeError) { throw new AggregateError([error, closeError], `Herdr pane ${created.paneId} was created but could not be adopted or closed.`); }
    throw error;
  }
}

async function getOrCreateShellPane(client: HerdrClient, context: HerdrContext, cwd: string, signal?: AbortSignal, onCreated?: (binding: HerdrBinding) => void): Promise<HerdrBinding> {
  const bindings = await readHerdrBindings();
  const key = bindingKey(context, cwd);
  // Version-3 records created before per-agent ownership have no owner pane
  // identity. Never adopt one for the current agent; retire only the state
  // record and leave the live pane untouched so a running process is safe.
  for (const legacy of [...bindings.values()].filter((binding) => isLegacyGenericShellBinding(binding, context, cwd))) {
    await removeHerdrBinding(legacy.key, legacy.paneId);
  }
  const existing = bindings.get(key);
  if (existing?.role === SHELL_ROLE) {
    const inspected = await inspectBinding(client, existing, signal);
    if (inspected && hasLostGenericShellOwnership(existing, inspected)) {
      // A terminal reconstructed by Herdr is no longer ours. Leave the live
      // pane alone, discard only our stale record, and create a distinct pane.
      await removeHerdrBinding(key, existing.paneId);
    } else if (inspected?.shellReady) {
      return existing;
    } else if (inspected || await paneExists(client, existing.paneId, signal)) {
      // Preserve ownership rather than silently orphaning a managed pane a
      // human is using for an editor, agent, or foreground server.
      throw new Error(`Managed Herdr pane ${existing.paneId} is busy or no longer matches its recorded scope; it remains bound and was not changed.`);
    } else {
      await removeHerdrBinding(key, existing.paneId);
    }
  }
  const created = await createOwnedPane(client, context, cwd, SHELL_ROLE, key, signal);
  onCreated?.(created);
  return created;
}

export interface HerdrPaneReplacement { binding: HerdrBinding; created: boolean; }

export async function runPaneCommandWithRecovery(client: HerdrClient, binding: HerdrBinding, command: string, recreate: () => Promise<HerdrPaneReplacement>, signal?: AbortSignal, verifyShell?: (candidate: HerdrBinding) => Promise<boolean>, discardReplacement?: (candidate: HerdrBinding) => Promise<void>): Promise<HerdrBinding> {
  if (verifyShell && !await verifyShell(binding)) throw new Error(`Herdr pane ${binding.paneId} is busy with a non-shell foreground process; no command was sent.`);
  try { await client.run(["pane", "run", binding.paneId, command], { timeout: COMMAND_TIMEOUT_MS, signal }); return binding; }
  catch (error) {
    if (!isNotFound(error)) throw error;
    let replacement: HerdrBinding;
    let replacementCreated: boolean;
    try {
      const recreated = await recreate();
      replacement = recreated.binding;
      replacementCreated = recreated.created;
    } catch (recreateError) { throw new AggregateError([error, recreateError], `Herdr pane ${binding.paneId} disappeared and could not be recreated: ${formatHerdrError(recreateError)}`); }
    try {
      if (verifyShell && !await verifyShell(replacement)) throw new Error(`Herdr replacement pane ${replacement.paneId} is busy with a non-shell foreground process; no command was sent.`);
      await client.run(["pane", "run", replacement.paneId, command], { timeout: COMMAND_TIMEOUT_MS, signal });
      return replacement;
    } catch (retryError) {
      try { if (replacementCreated) await discardReplacement?.(replacement); }
      catch (closeError) { throw new AggregateError([error, retryError, closeError], `Herdr pane ${binding.paneId} disappeared; replacement pane ${replacement.paneId} could not run the command or be closed.`); }
      throw new AggregateError([error, retryError], `Herdr pane ${binding.paneId} disappeared; replacement pane ${replacement.paneId} could not run the command: ${formatHerdrError(retryError)}`);
    }
  }
}

export function discoveredNotesBinding(key: string, root: string, pane: Record<string, unknown>, paneId: string, now = new Date().toISOString()): HerdrBinding {
  // A viewer may be launched from a different cwd than the Notes root.
  // Persist that actual Herdr scope so later inspection can reuse it.
  return { key, role: NOTES_ROLE, workspaceId: getString(pane, "workspace_id", "workspaceId") ?? "unknown", parentTabId: getString(pane, "tab_id", "tabId"), paneId, terminalId: getString(pane, "terminal_id", "terminalId"), cwd: getString(pane, "cwd") ?? root, createdAt: now, updatedAt: now };
}

async function findNotesViewer(client: HerdrClient, root: string, socket: string, signal?: AbortSignal): Promise<HerdrBinding | undefined> {
  throwIfAborted(signal);
  const key = notesBindingKey(root);
  const saved = (await readHerdrBindings()).get(key);
  if (saved?.role === NOTES_ROLE) {
    try {
      const inspection = await inspectBinding(client, saved, signal);
      if (inspection) {
        const info = await getPaneProcessInfo(client, saved.paneId, signal);
        if (info && processContainsNvim(info, socket)) {
          const current = inspection.terminalId && inspection.terminalId !== saved.terminalId
            ? { ...saved, terminalId: inspection.terminalId, updatedAt: new Date().toISOString() }
            : saved;
          if (current !== saved) await upsertHerdrBinding(current);
          return current;
        }
      }
      if (inspection || await paneExists(client, saved.paneId, signal)) {
        throw new Error(`Managed Notes pane ${saved.paneId} is still live but is not the expected Neovim viewer; it remains bound and was not changed.`);
      }
    } catch (error) { if (!isNotFound(error)) throw error; }
    await removeHerdrBinding(key, saved.paneId);
  }
  const listed = await client.run(["pane", "list"], { timeout: 5_000, signal });
  for (const value of listedPanes(listed)) {
    const paneId = extractPaneId(value);
    if (!paneId) continue;
    const info = await getPaneProcessInfo(client, paneId, signal);
    if (!info || !processContainsNvim(info, socket)) continue;
    const binding = discoveredNotesBinding(key, root, value, paneId);
    await upsertHerdrBinding(binding);
    return binding;
  }
  return undefined;
}

async function notesSocketAcceptsConnections(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const socket = net.createConnection({ path });
    const done = (ready: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    timer = setTimeout(() => done(false), 500);
    timer.unref();
    socket.unref();
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function waitForNotesSocket(socket: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + NOTES_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      if ((await fs.lstat(socket)).isSocket() && await notesSocketAcceptsConnections(socket)) return;
    } catch { /* Neovim has not created a usable socket yet. */ }
    await wait(READY_POLL_MS, signal);
  }
  throw new Error(`Neovim did not expose a usable socket within ${NOTES_READY_TIMEOUT_MS / 1_000} seconds.`);
}

async function openNotesViewer(client: HerdrClient, request: HerdrNotesViewerRequest): Promise<{ binding: HerdrBinding; existing: boolean }> {
  throwIfAborted(request.signal);
  const live = await findNotesViewer(client, request.cwd, request.socket, request.signal);
  if (live) return { binding: live, existing: true };
  if (!request.command) throw new Error("Neovim is live but its Herdr pane could not be identified. Open the viewer again to create a managed replacement.");
  const herdrContext = await getHerdrContext(client);
  const key = notesBindingKey(request.cwd);
  const binding = await createOwnedPane(client, herdrContext, request.cwd, NOTES_ROLE, key, request.signal);
  try {
    await client.run(["pane", "run", binding.paneId, request.command], { timeout: COMMAND_TIMEOUT_MS, signal: request.signal });
    await waitForNotesSocket(request.socket, request.signal);
    return { binding, existing: false };
  } catch (error) {
    // This binding was created by this request. Never close a pane discovered
    // from existing state, but clean up an unadoptable new Notes viewer.
    try { await closeBinding(client, binding); }
    catch (closeError) { throw new AggregateError([error, closeError], `New Notes pane ${binding.paneId} failed to launch and could not be closed.`); }
    throw error;
  }
}

async function closeBinding(client: HerdrClient, binding: HerdrBinding, signal?: AbortSignal): Promise<void> {
  try { await client.run(["pane", "close", binding.paneId], { timeout: COMMAND_TIMEOUT_MS, signal }); }
  catch (error) { if (!isNotFound(error)) throw error; }
  await removeHerdrBinding(binding.key, binding.paneId);
}

async function viewerSocketIsLive(socket: string): Promise<boolean> {
  try {
    await sendTerminalViewerCommand(socket, { op: "ping" }, 500);
    return true;
  } catch { return false; }
}

async function openTerminalViewer(client: HerdrClient, request: HerdrTerminalViewerRequest): Promise<{ binding: HerdrBinding; existing: boolean; revision: number }> {
  throwIfAborted(request.signal);
  const context = await getHerdrContext(client);
  const key = bindingKey(context, request.cwd, VISUALIZATION_VIEWER_ROLE);
  const saved = (await readHerdrBindings()).get(key);
  if (saved?.role === VISUALIZATION_VIEWER_ROLE) {
    const inspection = await inspectBinding(client, saved, request.signal);
    if (inspection) {
      const info = await getPaneProcessInfo(client, saved.paneId, request.signal);
      if (saved.socket && processContainsTerminalViewer(info ?? {}, saved.socket)) {
        // Existing viewers are already initialized. Read their revision first,
        // then use the normal stale-update fence; set_scene is initial-only.
        try {
          const current = await sendTerminalViewerCommand(saved.socket, { op: "get" });
          if (typeof current.revision !== "number" || !Number.isSafeInteger(current.revision) || current.revision < 1) throw new Error("Managed visualization viewer returned an invalid revision.");
          const updated = await sendTerminalViewerCommand(saved.socket, { op: "update", revision: current.revision, scene: request.scene });
          return { binding: saved, existing: true, revision: updated.revision ?? current.revision + 1 };
        } catch {
          // The exact viewer can outlive its socket (listener failure, deleted
          // socket, or a replaced path). Reverify before reclaiming the pane so
          // a human takeover is never closed, then start the replacement with
          // this scene as revision one.
          const reverified = await getPaneProcessInfo(client, saved.paneId, request.signal);
          if (saved.socket && processContainsTerminalViewer(reverified ?? {}, saved.socket)) {
            await closeBinding(client, saved, request.signal);
          } else {
            await removeHerdrBinding(key, saved.paneId);
          }
        }
      } else {
        const socketLive = saved.socket ? await viewerSocketIsLive(saved.socket) : false;
        if (inspection.shellReady && !socketLive) {
          // q leaves a verified dedicated pane at its shell prompt. It is safe to
          // reclaim that pane; a non-shell foreground process is never touched.
          await closeBinding(client, saved, request.signal);
        } else {
          // The recorded pane is still live but no longer runs our exact viewer
          // (owner loss, q/restart race, or human takeover). Never send input to
          // it; retire only our binding and create a fresh dedicated pane.
          await removeHerdrBinding(key, saved.paneId);
        }
      }
    } else {
      // A stale topology binding is not permission to adopt a replacement or a
      // generic/Notes pane. Leave any live pane untouched and create our own.
      await removeHerdrBinding(key, saved.paneId);
    }
  }
  const binding = await createOwnedPane(client, context, request.cwd, VISUALIZATION_VIEWER_ROLE, key, request.signal);
  const adopted = { ...binding, socket: request.socket, updatedAt: new Date().toISOString() };
  try {
    // This command is assembled from fixed executable/script arguments. It is
    // never taken from model input; the socket is validated and shell-quoted.
    await client.run(["pane", "run", binding.paneId, terminalViewerCommand(request.socket)], { timeout: COMMAND_TIMEOUT_MS, signal: request.signal });
    await waitForTerminalViewerSocket(request.socket, TERMINAL_VIEWER_READY_TIMEOUT_MS, request.signal);
    await sendTerminalViewerCommand(request.socket, { op: "set_scene", revision: 1, scene: request.scene });
    await upsertHerdrBinding(adopted);
    return { binding: adopted, existing: false, revision: 1 };
  } catch (error) {
    try { await closeBinding(client, binding); }
    catch (closeError) { throw new AggregateError([error, closeError], `New visualization viewer pane ${binding.paneId} failed to launch and could not be closed.`); }
    throw error;
  }
}

async function statusTerminalViewer(client: HerdrClient, request: HerdrTerminalViewerStatusRequest): Promise<{ status: "ready" | "closed"; binding?: HerdrBinding; revision?: number }> {
  throwIfAborted(request.signal);
  const context = await getHerdrContext(client);
  const key = bindingKey(context, request.cwd, VISUALIZATION_VIEWER_ROLE);
  const binding = (await readHerdrBindings()).get(key);
  if (!binding || binding.role !== VISUALIZATION_VIEWER_ROLE) return { status: "closed" };
  const inspection = await inspectBinding(client, binding, request.signal);
  if (!inspection) {
    if (!await paneExists(client, binding.paneId, request.signal)) await removeHerdrBinding(key, binding.paneId);
    return { status: "closed", binding };
  }
  const info = await getPaneProcessInfo(client, binding.paneId, request.signal);
  if (!binding.socket || !processContainsTerminalViewer(info ?? {}, binding.socket)) return { status: "closed", binding };
  try {
    const current = await sendTerminalViewerCommand(binding.socket, { op: "ping" });
    return { status: "ready", binding, revision: current.revision };
  } catch { return { status: "closed", binding }; }
}

async function closeTerminalViewer(client: HerdrClient, request: { cwd: string; socket: string; signal?: AbortSignal }): Promise<{ closed: boolean; binding?: HerdrBinding }> {
  const context = await getHerdrContext(client);
  const key = bindingKey(context, request.cwd, VISUALIZATION_VIEWER_ROLE);
  const binding = (await readHerdrBindings()).get(key);
  if (!binding || binding.role !== VISUALIZATION_VIEWER_ROLE) return { closed: false };
  const inspection = await inspectBinding(client, binding, request.signal);
  if (!inspection) { if (!(await paneExists(client, binding.paneId, request.signal))) await removeHerdrBinding(key, binding.paneId); return { closed: false, binding }; }
  const info = await getPaneProcessInfo(client, binding.paneId, request.signal);
  if (binding.socket && processContainsTerminalViewer(info ?? {}, binding.socket)) {
    await sendTerminalViewerCommand(binding.socket, { op: "close" }).catch(() => undefined);
    await closeBinding(client, binding, request.signal);
    return { closed: true, binding };
  }
  // The viewer may have exited through q. Reclaim only a verified pane that is
  // back at its shell prompt and whose private socket is no longer responsive.
  if (inspection.shellReady && (!binding.socket || !await viewerSocketIsLive(binding.socket))) {
    await closeBinding(client, binding, request.signal);
    return { closed: true, binding };
  }
  // Do not close a pane that may now belong to a human or another tool. Retire
  // only our stale record so a future open creates a dedicated replacement.
  await removeHerdrBinding(key, binding.paneId);
  return { closed: false, binding };
}

async function cleanupGeneratedPlanBoardSocket(socket: string): Promise<void> {
  const directory = dirname(socket);
  if (dirname(directory) !== tmpdir() || !basename(directory).startsWith("pi-plan-board-")) return;
  await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

async function openPlanBoard(client: HerdrClient, request: HerdrPlanBoardRequest): Promise<{ binding: HerdrBinding; existing: boolean; revision: number }> {
  throwIfAborted(request.signal);
  const snapshot = validatePlanBoardSnapshot(request.snapshot);
  const context = await getHerdrContext(client);
  const key = bindingKey(context, request.cwd, PLAN_BOARD_ROLE);
  const saved = (await readHerdrBindings()).get(key);
  if (saved?.role === PLAN_BOARD_ROLE) {
    const inspection = await inspectBinding(client, saved, request.signal);
    if (inspection && saved.socket && processContainsPlanBoard(await getPaneProcessInfo(client, saved.paneId, request.signal) ?? {}, saved.socket)) {
      try {
        const current = await sendPlanBoardCommand(saved.socket, { op: "get" });
        if (typeof current.revision !== "number" || current.revision < 1) throw new Error("Managed Plan Board returned an invalid revision.");
        const nextSnapshot = validatePlanBoardSnapshot(preservePlanBoardScene(current.snapshot, snapshot));
        const updated = await sendPlanBoardCommand(saved.socket, { op: "update", revision: current.revision, snapshot: nextSnapshot });
        const binding = { ...saved, updatedAt: new Date().toISOString() };
        await upsertHerdrBinding(binding);
        return { binding, existing: true, revision: updated.revision ?? current.revision + 1 };
      } catch {
        const info = await getPaneProcessInfo(client, saved.paneId, request.signal);
        if (saved.socket && processContainsPlanBoard(info ?? {}, saved.socket)) {
          await closeBinding(client, saved, request.signal);
          await cleanupGeneratedPlanBoardSocket(saved.socket);
        } else await removeHerdrBinding(key, saved.paneId);
      }
    } else if (inspection) {
      if (inspection.shellReady) {
        await closeBinding(client, saved, request.signal);
        if (saved.socket) await cleanupGeneratedPlanBoardSocket(saved.socket);
      } else await removeHerdrBinding(key, saved.paneId);
    } else {
      const paneStillExists = await paneExists(client, saved.paneId, request.signal);
      await removeHerdrBinding(key, saved.paneId);
      if (!paneStillExists && saved.socket) await cleanupGeneratedPlanBoardSocket(saved.socket);
    }
  }
  let endpoint: Awaited<ReturnType<typeof createPlanBoardEndpoint>> | undefined;
  let socket = request.socket;
  let binding: HerdrBinding | undefined;
  try {
    // Endpoint creation and pane creation share one cleanup boundary. A pane
    // creation failure must not strand the private directory under /tmp.
    endpoint = request.socket ? undefined : await createPlanBoardEndpoint();
    socket = endpoint?.socket ?? request.socket;
    binding = await createOwnedPane(client, context, request.cwd, PLAN_BOARD_ROLE, key, request.signal);
    const adopted = { ...binding, socket, updatedAt: new Date().toISOString() };
    await client.run(["pane", "run", binding.paneId, planBoardCommand(socket)], { timeout: COMMAND_TIMEOUT_MS, signal: request.signal });
    await waitForPlanBoardSocket(socket, PLAN_BOARD_READY_TIMEOUT_MS, request.signal);
    await sendPlanBoardCommand(socket, { op: "set_snapshot", revision: 1, snapshot });
    await upsertHerdrBinding(adopted);
    return { binding: adopted, existing: false, revision: 1 };
  } catch (error) {
    if (binding) {
      try { await closeBinding(client, binding); }
      catch (closeError) {
        await endpoint?.cleanup();
        throw new AggregateError([error, closeError], `New Plan Board pane ${binding.paneId} failed to launch and could not be closed.`);
      }
    }
    await endpoint?.cleanup();
    throw error;
  }
}

async function updatePlanBoard(client: HerdrClient, request: HerdrPlanBoardRequest): Promise<{ binding: HerdrBinding; revision: number; recovered?: boolean }> {
  const snapshot = validatePlanBoardSnapshot(request.snapshot);
  const context = await getHerdrContext(client);
  const key = bindingKey(context, request.cwd, PLAN_BOARD_ROLE);
  const binding = (await readHerdrBindings()).get(key);
  if (!binding || binding.role !== PLAN_BOARD_ROLE || !binding.socket) throw new Error("No active Plan Board exists for this scope.");
  const inspection = await inspectBinding(client, binding, request.signal);
  const info = inspection ? await getPaneProcessInfo(client, binding.paneId, request.signal) : undefined;
  if (!inspection || !processContainsPlanBoard(info ?? {}, binding.socket)) {
    // Cleanup is safe only after the pane is gone or a verified shell has been
    // closed. A process-identity mismatch may be a human takeover; retain its
    // socket directory until that process is independently terminated.
    if (!inspection) {
      const paneStillExists = await paneExists(client, binding.paneId, request.signal);
      await removeHerdrBinding(key, binding.paneId);
      if (!paneStillExists) await cleanupGeneratedPlanBoardSocket(binding.socket);
    } else if (inspection.shellReady) {
      await closeBinding(client, binding, request.signal);
      await cleanupGeneratedPlanBoardSocket(binding.socket);
    } else {
      await removeHerdrBinding(key, binding.paneId);
    }
    const recovered = await openPlanBoard(client, { ...request, socket: "" });
    return { binding: recovered.binding, revision: recovered.revision, recovered: true };
  }
  try {
    const current = await sendPlanBoardCommand(binding.socket, { op: "get" });
    if (typeof current.revision !== "number" || current.revision < 1) throw new Error("Managed Plan Board returned an invalid revision.");
    const nextSnapshot = validatePlanBoardSnapshot(preservePlanBoardScene(current.snapshot, snapshot));
    const updated = await sendPlanBoardCommand(binding.socket, { op: "update", revision: current.revision, snapshot: nextSnapshot });
    const next = { ...binding, updatedAt: new Date().toISOString() };
    await upsertHerdrBinding(next);
    return { binding: next, revision: updated.revision ?? current.revision + 1 };
  } catch {
    const recovered = await openPlanBoard(client, { ...request, socket: "" });
    return { binding: recovered.binding, revision: recovered.revision, recovered: true };
  }
}

async function statusPlanBoard(client: HerdrClient, request: HerdrPlanBoardStatusRequest): Promise<{ status: "ready" | "closed"; binding?: HerdrBinding; revision?: number }> {
  const context = await getHerdrContext(client);
  const key = bindingKey(context, request.cwd, PLAN_BOARD_ROLE);
  const binding = (await readHerdrBindings()).get(key);
  if (!binding || binding.role !== PLAN_BOARD_ROLE || !binding.socket) return { status: "closed" };
  const inspection = await inspectBinding(client, binding, request.signal);
  const info = inspection ? await getPaneProcessInfo(client, binding.paneId, request.signal) : undefined;
  if (!inspection || !processContainsPlanBoard(info ?? {}, binding.socket)) return { status: "closed", binding };
  try {
    const current = await sendPlanBoardCommand(binding.socket, { op: "ping" });
    return { status: "ready", binding, revision: current.revision };
  } catch { return { status: "closed", binding }; }
}

async function closePlanBoard(client: HerdrClient, request: { cwd: string; signal?: AbortSignal }): Promise<{ closed: boolean; binding?: HerdrBinding }> {
  const context = await getHerdrContext(client);
  const key = bindingKey(context, request.cwd, PLAN_BOARD_ROLE);
  const binding = (await readHerdrBindings()).get(key);
  if (!binding || binding.role !== PLAN_BOARD_ROLE) return { closed: false };
  const inspection = await inspectBinding(client, binding, request.signal);
  const info = inspection ? await getPaneProcessInfo(client, binding.paneId, request.signal) : undefined;
  if (inspection && binding.socket && processContainsPlanBoard(info ?? {}, binding.socket)) {
    await sendPlanBoardCommand(binding.socket, { op: "close" }).catch(() => undefined);
    await closeBinding(client, binding, request.signal);
    if (binding.socket) await cleanupGeneratedPlanBoardSocket(binding.socket);
    return { closed: true, binding };
  }
  if (inspection?.shellReady) { await closeBinding(client, binding, request.signal); if (binding.socket) await cleanupGeneratedPlanBoardSocket(binding.socket); return { closed: true, binding }; }
  if (!inspection && !(await paneExists(client, binding.paneId, request.signal)) && binding.socket) await cleanupGeneratedPlanBoardSocket(binding.socket);
  await removeHerdrBinding(key, binding.paneId);
  return { closed: false, binding };
}

function formatStatus(binding: HerdrBinding, pane: unknown, output: string): string {
  const record = paneRecord(pane) ?? {};
  const lines = [`Herdr side-by-side pane: ${binding.paneId}`, `Role: ${binding.role}`, `Workspace: ${binding.workspaceId}`, `Cwd: ${binding.cwd}`, `Herdr status: ${getString(record, "agent_status") ?? "unknown"}`, `Foreground cwd: ${getString(record, "foreground_cwd") ?? binding.cwd}`, `Last command: ${describeCommand(binding.lastCommand)}`];
  if (output.trim()) lines.push("", "Recent output:", output.trimEnd());
  return lines.join("\n");
}

async function executeAction(client: HerdrClient, input: HerdrShellInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<ReturnType<typeof toolResult>> {
  if (ctx.mode !== "tui" || process.env.HERDR_ENV !== "1") throw new Error("herdr_shell requires Pi to run inside a Herdr-managed pane (HERDR_ENV=1).");
  const cwd = await resolveWorkingDirectory(ctx, input.cwd);
  const herdrVersion = await ensureSupportedHerdr(client);
  const context = await getHerdrContext(client);
  const key = bindingKey(context, cwd);
  const existing = (await readHerdrBindings()).get(key);
  if (input.action === "close") {
    const inspected = existing?.role === SHELL_ROLE ? await inspectBinding(client, existing, signal) : undefined;
    if (existing && inspected && hasLostGenericShellOwnership(existing, inspected)) {
      return toolResult(`Managed Herdr pane ${existing.paneId} has a different terminal after Herdr restarted. It is no longer owned, remains untouched, and was not closed.`, { action: input.action, cwd, ...bindingDetails(existing) });
    }
    if (!existing || !inspected) {
      if (existing && await paneExists(client, existing.paneId, signal)) {
        return toolResult(`Managed Herdr pane ${existing.paneId} could not be verified for this scope, so it remains bound and no pane was closed.`, { action: input.action, cwd, ...bindingDetails(existing) });
      }
      if (existing) await removeHerdrBinding(key, existing.paneId);
      return toolResult(`No live managed Herdr side-by-side shell exists for ${cwd}; no pane was closed.`, { action: input.action, cwd });
    }
    await closeBinding(client, existing, signal);
    return toolResult(`Closed managed Herdr shell pane ${existing.paneId} for ${cwd}.`, { action: input.action, cwd, ...bindingDetails(existing) });
  }
  if (input.action === "status" || input.action === "read_output") {
    const inspected = existing?.role === SHELL_ROLE ? await inspectBinding(client, existing, signal) : undefined;
    if (existing && inspected && hasLostGenericShellOwnership(existing, inspected)) {
      return toolResult(`Managed Herdr pane ${existing.paneId} has a different terminal after Herdr restarted. It is no longer owned and was not read. Open or run will create a fresh managed pane.`, { action: input.action, cwd, ...bindingDetails(existing) });
    }
    if (!existing || !inspected) {
      if (existing && await paneExists(client, existing.paneId, signal)) {
        return toolResult(`Managed Herdr pane ${existing.paneId} could not be verified for this scope, so it remains bound and was not read.`, { action: input.action, cwd, ...bindingDetails(existing) });
      }
      if (existing) await removeHerdrBinding(key, existing.paneId);
      return toolResult(`No live managed Herdr side-by-side shell exists for ${cwd}.`, { action: input.action, cwd });
    }
    const lines = input.action === "read_output" ? Math.min(input.lines ?? DEFAULT_OUTPUT_LINES, MAX_OUTPUT_LINES) : 20;
    const output = await client.runText(["pane", "read", existing.paneId, "--source", "recent-unwrapped", "--format", "text", "--lines", String(lines)], { timeout: COMMAND_TIMEOUT_MS, signal });
    const bounded = truncateHerdrOutput(output, lines);
    if (input.action === "read_output") return toolResult(bounded.text || "(no recent output)", { action: input.action, cwd, lines, herdrVersion, ...bindingDetails(existing), truncation: bounded.truncation });
    return toolResult(formatStatus(existing, inspected.pane, bounded.text), { action: input.action, cwd, herdrVersion, ...bindingDetails(existing), truncation: bounded.truncation });
  }
  if (input.action === "run" && !input.command) throw new Error("herdr_shell run requires a command. Use open without a command to create an interactive shell pane.");
  let binding = await getOrCreateShellPane(client, context, cwd, signal);
  if (input.command) {
    // getOrCreateShellPane verified foreground ownership immediately before this run.
    let replacementCreatedPaneId: string | undefined;
    binding = await runPaneCommandWithRecovery(client, binding, input.command, async () => {
      await removeHerdrBinding(binding.key, binding.paneId);
      // Set this only from the creation callback. A concurrent Pi session may
      // have adopted an existing binding while recovery was in flight, and its
      // human pane must never become retry-cleanup collateral.
      const replacement = await getOrCreateShellPane(client, context, cwd, signal, (created) => { replacementCreatedPaneId = created.paneId; });
      return { binding: replacement, created: replacement.paneId === replacementCreatedPaneId };
    }, signal, async (candidate) => !!(await inspectBinding(client, candidate, signal))?.shellReady, async (candidate) => {
      if (candidate.paneId === replacementCreatedPaneId) await closeBinding(client, candidate);
    });
    binding = { ...binding, lastCommand: input.command, updatedAt: new Date().toISOString() };
    await upsertHerdrBinding(binding);
    return toolResult(`Started command in Herdr side-by-side pane ${binding.paneId} without waiting for it to exit: ${describeCommand(input.command)}\nUse herdr_shell read_output to inspect recent stdout/stderr.`, { action: input.action, cwd, command: describeCommand(input.command), herdrVersion, ...bindingDetails(binding) });
  }
  return toolResult(`Opened interactive shell in Herdr side-by-side pane ${binding.paneId}.`, { action: input.action, cwd, herdrVersion, ...bindingDetails(binding) });
}

/** Apply a point-in-time pane list without clobbering records written later. */
export function reconcileLivePaneSnapshot(bindings: Map<string, HerdrBinding>, live: Map<string, Record<string, unknown>>, snapshotTakenAt: number): HerdrBinding[] {
  const orphaned: HerdrBinding[] = [];
  for (const [key, binding] of bindings) {
    // The snapshot cannot say anything about a binding persisted after it was
    // collected. Leave it to the next pass rather than deleting a new pane.
    const updatedAt = Date.parse(binding.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt >= snapshotTakenAt) continue;
    const pane = live.get(binding.paneId);
    const ownerMissing = binding.ownerPaneId !== undefined && !live.has(binding.ownerPaneId);
    if (!pane || !bindingScopeMatches(pane, binding)) {
      bindings.delete(key);
      continue;
    }
    if (ownerMissing && (binding.role === VISUALIZATION_VIEWER_ROLE || binding.role === PLAN_BOARD_ROLE)) {
      // Keep the record until an async process-identity check can reclaim only
      // a dedicated viewer pane. Missing owner events must not orphan it.
      orphaned.push(binding);
      continue;
    }
    if (ownerMissing) {
      bindings.delete(key);
      continue;
    }
    const terminalId = getString(pane, "terminal_id", "terminalId");
    // Notes ownership is proven by its Nvim socket on every reuse. A generic
    // shell terminal ID is an ownership fence: keep the old ID so a later run
    // creates a fresh managed pane instead of adopting a restored human pane.
    if (binding.role === NOTES_ROLE && terminalId && terminalId !== binding.terminalId) {
      bindings.set(key, { ...binding, terminalId, updatedAt: new Date().toISOString() });
    }
  }
  return orphaned;
}

async function reclaimOrphanedPlanBoard(client: HerdrClient, binding: HerdrBinding): Promise<void> {
  const inspection = await inspectBinding(client, binding);
  if (!inspection) {
    const paneStillExists = await paneExists(client, binding.paneId);
    await removeHerdrBinding(binding.key, binding.paneId);
    if (!paneStillExists && binding.socket) await cleanupGeneratedPlanBoardSocket(binding.socket);
    return;
  }
  const info = await getPaneProcessInfo(client, binding.paneId);
  if (binding.socket && processContainsPlanBoard(info ?? {}, binding.socket)) {
    await sendPlanBoardCommand(binding.socket, { op: "close" }).catch(() => undefined);
    await closeBinding(client, binding);
    await cleanupGeneratedPlanBoardSocket(binding.socket);
    return;
  }
  if (inspection.shellReady) {
    await closeBinding(client, binding);
    if (binding.socket) await cleanupGeneratedPlanBoardSocket(binding.socket);
  } else await removeHerdrBinding(binding.key, binding.paneId);
}

async function reclaimOrphanedVisualization(client: HerdrClient, binding: HerdrBinding): Promise<void> {
  const inspection = await inspectBinding(client, binding);
  if (!inspection) {
    // The pane may have been repurposed or moved. Either way the owner-scoped
    // record is stale; never close an unverified pane.
    await removeHerdrBinding(binding.key, binding.paneId);
    return;
  }
  const info = await getPaneProcessInfo(client, binding.paneId);
  if (binding.socket && processContainsTerminalViewer(info ?? {}, binding.socket)) {
    await sendTerminalViewerCommand(binding.socket, { op: "close" }).catch(() => undefined);
    await closeBinding(client, binding);
    return;
  }
  if (inspection.shellReady && (!binding.socket || !await viewerSocketIsLive(binding.socket))) {
    // q leaves a verified dedicated pane at its shell prompt.
    await closeBinding(client, binding);
    return;
  }
  // A repurposed foreground process is untouched, but its unreachable binding
  // must not keep the orphan alive forever.
  await removeHerdrBinding(binding.key, binding.paneId);
}

async function reconcileEvent(client: HerdrClient, event: HerdrEventEnvelope): Promise<void> {
  const data = event.data;
  const orphaned: HerdrBinding[] = [];
  const paneId = getString(data, "pane_id", "previous_pane_id");
  const tabId = getString(data, "tab_id");
  const workspaceId = getString(data, "workspace_id");
  const previousPaneId = getString(data, "previous_pane_id");
  await updateHerdrBindings((bindings) => {
    for (const [key, binding] of bindings) {
      if ((event.event === "pane.closed" || event.event === "pane.exited") && paneId !== undefined) {
        if (binding.paneId === paneId) bindings.delete(key);
        else if (binding.ownerPaneId === paneId) {
          if (binding.role === VISUALIZATION_VIEWER_ROLE || binding.role === PLAN_BOARD_ROLE) orphaned.push(binding);
          else bindings.delete(key);
        }
      }
      if (event.event === "tab.closed" && tabId !== undefined && binding.parentTabId === tabId) bindings.delete(key);
      if (event.event === "workspace.closed" && workspaceId !== undefined && binding.workspaceId === workspaceId) bindings.delete(key);
      if (event.event === "pane.moved" && previousPaneId !== undefined && binding.ownerPaneId === previousPaneId) {
        if (binding.role === VISUALIZATION_VIEWER_ROLE || binding.role === PLAN_BOARD_ROLE) orphaned.push(binding);
        else bindings.delete(key);
      }
      if (event.event === "pane.moved" && previousPaneId !== undefined && binding.paneId === previousPaneId) {
        const moved = getRecord(data, "pane");
        if (binding.role === NOTES_ROLE && moved) bindings.set(key, { ...binding, paneId: getString(moved, "pane_id") ?? binding.paneId, terminalId: getString(moved, "terminal_id") ?? binding.terminalId, workspaceId: getString(moved, "workspace_id") ?? binding.workspaceId, parentTabId: getString(moved, "tab_id") ?? binding.parentTabId, updatedAt: new Date().toISOString() });
        else bindings.delete(key);
      }
    }
  });
  for (const binding of orphaned) {
    try {
      if (binding.role === PLAN_BOARD_ROLE) await reclaimOrphanedPlanBoard(client, binding);
      else await reclaimOrphanedVisualization(client, binding);
    }
    catch { /* Keep the stale record so the next reconciliation can retry safely. */ }
  }
}

export default function herdrShellExtension(pi: ExtensionAPI): void {
  const client = createHerdrClient(pi);
  let operation = Promise.resolve();
  let currentContext: ExtensionContext | undefined;
  let subscriber: HerdrEventSubscriber | undefined;
  let reconcileTimer: NodeJS.Timeout | undefined;
  const enqueue = <T>(work: () => Promise<T>) => { const next = operation.then(work); operation = next.then(() => undefined, () => undefined); return next; };
  pi.on("session_start", (_event, ctx) => {
    // A repeated session_start can occur after a reload. Tear down prior socket
    // and timer first so neither can keep Pi alive or reconcile a stale session.
    subscriber?.close();
    if (reconcileTimer) clearInterval(reconcileTimer);
    subscriber = undefined;
    reconcileTimer = undefined;
    currentContext = ctx;
    if (process.env.HERDR_ENV === "1") {
      subscriber = new HerdrEventSubscriber({ onEvent: (event) => { void enqueue(() => reconcileEvent(client, event)); } });
      subscriber.start();
      // The subscription is best effort. Periodically prune records proven absent
      // by the supported list API when a socket is unavailable or reconnecting.
      reconcileTimer = setInterval(() => {
        void enqueue(async () => {
          const snapshotTakenAt = Date.now();
          const listed = await client.run(["pane", "list"], { timeout: 5_000 });
          const live = new Map(listedPanes(listed).flatMap((pane) => {
            const paneId = extractPaneId(pane);
            return paneId ? [[paneId, pane] as const] : [];
          }));
          const orphaned = await updateHerdrBindings((bindings) => reconcileLivePaneSnapshot(bindings, live, snapshotTakenAt));
          for (const binding of orphaned) {
            if (binding.role === PLAN_BOARD_ROLE) await reclaimOrphanedPlanBoard(client, binding);
            else await reclaimOrphanedVisualization(client, binding);
          }
        }).catch(() => undefined);
      }, 60_000);
      reconcileTimer.unref();
    }
  });
  pi.on("session_shutdown", () => { currentContext = undefined; subscriber?.close(); subscriber = undefined; if (reconcileTimer) clearInterval(reconcileTimer); reconcileTimer = undefined; });
  pi.events.on("herdr:open-command", (value) => {
    // This private event is deliberately not an arbitrary command channel.
    const request = value as Partial<HerdrNotesViewerRequest>;
    if (request.role !== NOTES_ROLE || typeof request.cwd !== "string" || typeof request.socket !== "string" || typeof request.respond !== "function") {
      if (typeof request.respond === "function") request.respond({ ok: false, error: "herdr:open-command accepts only typed Notes viewer requests." });
      return;
    }
    if (request.signal?.aborted) { request.respond({ ok: false, error: "Notes viewer request was cancelled." }); return; }
    if (!currentContext) { request.respond({ ok: false, error: "No active Pi session is available for Herdr." }); return; }
    void enqueue(() => openNotesViewer(client, request as HerdrNotesViewerRequest)).then(
      (result) => request.respond!({ ok: true, ...result }),
      (error: unknown) => request.respond!({ ok: false, error: formatHerdrError(error) }),
    );
  });
  pi.events.on("herdr:open-terminal-viewer", (value) => {
    const request = value as Partial<HerdrTerminalViewerRequest>;
    if (request.role !== VISUALIZATION_VIEWER_ROLE || typeof request.cwd !== "string" || typeof request.socket !== "string" || !isRecord(request.scene) || typeof request.respond !== "function") {
      if (typeof request.respond === "function") request.respond({ ok: false, error: "herdr:open-terminal-viewer accepts only typed visualization viewer requests." });
      return;
    }
    if (request.signal?.aborted) { request.respond({ ok: false, error: "Terminal viewer request was cancelled." }); return; }
    if (!currentContext) { request.respond({ ok: false, error: "No active Pi session is available for Herdr." }); return; }
    void enqueue(() => openTerminalViewer(client, request as HerdrTerminalViewerRequest)).then(
      (result) => request.respond!({ ok: true, ...result }),
      (error: unknown) => request.respond!({ ok: false, error: formatHerdrError(error) }),
    );
  });
  pi.events.on("herdr:status-terminal-viewer", (value) => {
    const request = value as Partial<HerdrTerminalViewerStatusRequest>;
    if (request.role !== VISUALIZATION_VIEWER_ROLE || typeof request.cwd !== "string" || typeof request.respond !== "function") {
      if (typeof request.respond === "function") request.respond({ ok: false, error: "herdr:status-terminal-viewer accepts only typed visualization viewer requests." });
      return;
    }
    void enqueue(() => statusTerminalViewer(client, request as HerdrTerminalViewerStatusRequest)).then(
      (result) => request.respond!({ ok: true, ...result }),
      (error: unknown) => request.respond!({ ok: false, error: formatHerdrError(error) }),
    );
  });
  pi.events.on("herdr:close-terminal-viewer", (value) => {
    const request = value as Partial<{ role: typeof VISUALIZATION_VIEWER_ROLE; cwd: string; socket: string; signal?: AbortSignal; respond: (result: { ok: boolean; error?: string; closed?: boolean }) => void }>;
    if (request.role !== VISUALIZATION_VIEWER_ROLE || typeof request.cwd !== "string" || typeof request.socket !== "string" || typeof request.respond !== "function") {
      if (typeof request.respond === "function") request.respond({ ok: false, error: "herdr:close-terminal-viewer accepts only typed visualization viewer requests." });
      return;
    }
    void enqueue(() => closeTerminalViewer(client, request)).then(
      (result) => request.respond!({ ok: true, closed: result.closed }),
      (error: unknown) => request.respond!({ ok: false, error: formatHerdrError(error) }),
    );
  });
  pi.events.on("herdr:open-plan-board", (value) => {
    const request = value as Partial<HerdrPlanBoardRequest>;
    if (request.role !== PLAN_BOARD_ROLE || typeof request.cwd !== "string" || request.socket !== "" || !isRecord(request.snapshot) || typeof request.respond !== "function") {
      if (typeof request.respond === "function") request.respond({ ok: false, error: "herdr:open-plan-board accepts only typed Plan Board requests." });
      return;
    }
    try { request.snapshot = validatePlanBoardSnapshot(request.snapshot); }
    catch (error) { request.respond({ ok: false, error: formatHerdrError(error) }); return; }
    if (request.signal?.aborted) { request.respond({ ok: false, error: "Plan Board request was cancelled." }); return; }
    if (!currentContext) { request.respond({ ok: false, error: "No active Pi session is available for Herdr." }); return; }
    void enqueue(() => openPlanBoard(client, request as HerdrPlanBoardRequest)).then(
      (result) => request.respond!({ ok: true, ...result }),
      (error: unknown) => request.respond!({ ok: false, error: formatHerdrError(error) }),
    );
  });
  pi.events.on("herdr:update-plan-board", (value) => {
    const request = value as Partial<HerdrPlanBoardRequest>;
    if (request.role !== PLAN_BOARD_ROLE || typeof request.cwd !== "string" || !isRecord(request.snapshot) || typeof request.respond !== "function") {
      if (typeof request.respond === "function") request.respond({ ok: false, error: "herdr:update-plan-board accepts only typed Plan Board requests." });
      return;
    }
    try { request.snapshot = validatePlanBoardSnapshot(request.snapshot); }
    catch (error) { request.respond({ ok: false, error: formatHerdrError(error) }); return; }
    void enqueue(() => updatePlanBoard(client, request as HerdrPlanBoardRequest)).then(
      (result) => request.respond!({ ok: true, binding: result.binding, revision: result.revision }),
      (error: unknown) => request.respond!({ ok: false, error: formatHerdrError(error) }),
    );
  });
  pi.events.on("herdr:status-plan-board", (value) => {
    const request = value as Partial<HerdrPlanBoardStatusRequest>;
    if (request.role !== PLAN_BOARD_ROLE || typeof request.cwd !== "string" || typeof request.respond !== "function") {
      if (typeof request.respond === "function") request.respond({ ok: false, error: "herdr:status-plan-board accepts only typed Plan Board requests." });
      return;
    }
    void enqueue(() => statusPlanBoard(client, request as HerdrPlanBoardStatusRequest)).then(
      (result) => request.respond!({ ok: true, ...result }),
      (error: unknown) => request.respond!({ ok: false, error: formatHerdrError(error) }),
    );
  });
  pi.events.on("herdr:close-plan-board", (value) => {
    const request = value as Partial<{ role: typeof PLAN_BOARD_ROLE; cwd: string; signal?: AbortSignal; respond: (result: { ok: boolean; error?: string; closed?: boolean }) => void }>;
    if (request.role !== PLAN_BOARD_ROLE || typeof request.cwd !== "string" || typeof request.respond !== "function") {
      if (typeof request.respond === "function") request.respond({ ok: false, error: "herdr:close-plan-board accepts only typed Plan Board requests." });
      return;
    }
    void enqueue(() => closePlanBoard(client, request)).then(
      (result) => request.respond!({ ok: true, closed: result.closed, binding: result.binding }),
      (error: unknown) => request.respond!({ ok: false, error: formatHerdrError(error) }),
    );
  });
  pi.events.on("plan-board:plan", (value) => {
    if (process.env.HERDR_ENV !== "1") return;
    const request = value as Partial<{ cwd: string; snapshot: unknown }>;
    if (typeof request.cwd !== "string" || !isRecord(request.snapshot)) return;
    let snapshot: PlanBoardSnapshot;
    try { snapshot = validatePlanBoardSnapshot(request.snapshot); } catch { return; }
    void enqueue(async () => {
      const context = await getHerdrContext(client);
      const binding = (await readHerdrBindings()).get(bindingKey(context, request.cwd!, PLAN_BOARD_ROLE));
      if (!binding?.socket) return;
      try {
        await updatePlanBoard(client, { role: PLAN_BOARD_ROLE, cwd: request.cwd!, socket: binding.socket, snapshot, respond: () => undefined });
      } catch {
        await openPlanBoard(client, { role: PLAN_BOARD_ROLE, cwd: request.cwd!, socket: "", snapshot, respond: () => undefined });
      }
    }).catch(() => undefined);
  });
  pi.events.on("plan-board:scene", (value) => {
    if (process.env.HERDR_ENV !== "1") return;
    const request = value as Partial<{ cwd: string; scene: unknown }>;
    if (typeof request.cwd !== "string" || !isRecord(request.scene)) return;
    void enqueue(async () => {
      const context = await getHerdrContext(client);
      const binding = (await readHerdrBindings()).get(bindingKey(context, request.cwd!, PLAN_BOARD_ROLE));
      if (!binding?.socket) return;
      const current = await sendPlanBoardCommand(binding.socket, { op: "get" });
      if (!current.snapshot) return;
      const snapshot = validatePlanBoardSnapshot({ ...current.snapshot, scene: request.scene });
      await updatePlanBoard(client, { role: PLAN_BOARD_ROLE, cwd: request.cwd!, socket: binding.socket, snapshot, respond: () => undefined });
    }).catch(() => undefined);
  });
  pi.registerTool({
    name: "herdr_shell", label: "Herdr Shell", description: "Control one persistent shell in the current tab's right-side Herdr pane. It never reuses a notes/Neovim pane or a pane whose foreground process is not its shell. Use bash when Pi needs output this turn.", promptSnippet: "Run long-lived work in a Herdr side pane", promptGuidelines: ["Use open or run for long-lived work, then read_output to verify it started.", "It runs asynchronously and reuses only a verified shell pane in the current Herdr tab."], parameters: HerdrShellParameters, executionMode: "sequential",
    async execute(_toolCallId, input, signal, _onUpdate, ctx) { return enqueue(() => executeAction(client, input, ctx, signal)); },
    renderCall(args, theme) { const command = args.command ? ` · ${describeCommand(args.command)}` : ""; return new Text(theme.fg("toolTitle", `Herdr shell · ${args.action}`) + theme.fg("muted", command), 0, 0); },
    renderResult(result, { expanded }, theme, context) { const text = result.content.find((part) => part.type === "text")?.text ?? "Herdr shell completed."; return new Text(theme.fg(context.isError ? "error" : "toolOutput", expanded ? text : (text.split(/\r?\n/, 1)[0] ?? text)), 0, 0); },
  });
}
