import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  createHerdrClient,
  extractPaneId,
  extractWorkspaceId,
  formatHerdrError,
  getRecord,
  getString,
  isNotFound,
  parseVersion,
  supportsTabShell,
  type HerdrClient,
} from "./herdr-client.ts";

const STATE_VERSION = 2;
const DEFAULT_OUTPUT_LINES = 80;
const MAX_OUTPUT_LINES = 500;
const COMMAND_TIMEOUT_MS = 15_000;
const SHELL_STARTUP_DELAY_MS = 6_000;
const LIVE_INVENTORY_TTL_MS = 2_000;
const STATE_FILE = join(getAgentDir(), "herdr-shell.json");

const HerdrShellParameters = Type.Object({
  action: StringEnum(["open", "run", "read_output", "status", "close"] as const, {
    description: "Operation to perform in the managed Herdr side-by-side pane",
  }),
  command: Type.Optional(Type.String({
    description: "Shell command for open/run. Use for long-running servers, watchers, and processes.",
  })),
  cwd: Type.Optional(Type.String({
    description: "Working directory, relative to the current Pi project or absolute. Defaults to the current Pi directory.",
  })),
  lines: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: MAX_OUTPUT_LINES,
    description: "Maximum recent output lines for read_output (default 80, maximum 500).",
  })),
});

type HerdrShellInput = Static<typeof HerdrShellParameters>;
type HerdrShellAction = HerdrShellInput["action"];

interface HerdrBinding {
  key: string;
  workspaceId: string;
  parentTabId?: string;
  paneId: string;
  cwd: string;
  lastCommand?: string;
  createdAt: string;
  updatedAt: string;
}

interface PersistedState {
  version: number;
  bindings: HerdrBinding[];
}

export interface HerdrContext {
  workspaceId: string;
  parentTabId?: string;
}

export interface HerdrLivePane {
  paneId: string;
  workspaceId: string;
  tabId?: string;
  cwd?: string;
  foregroundCwd?: string;
  focused: boolean;
  agent?: string;
  agentStatus?: string;
  terminalTitle?: string;
  lastSeen: number;
}

export interface HerdrLiveInventory {
  workspaceId: string;
  parentTabId?: string;
  panes: HerdrLivePane[];
  refreshedAt: number;
}

interface HerdrOpenCommandRequest {
  command: string;
  cwd?: string;
  respond: (result: { ok: boolean; error?: string }) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function describeCommand(command: string | undefined): string {
  if (!command) return "interactive shell";
  const firstLine = command.split(/\r?\n/, 1)[0] ?? command;
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}

function extractLivePanes(value: unknown, context: HerdrContext, now: number): HerdrLivePane[] {
  const result = getRecord(value, "result") ?? value;
  if (!isRecord(result) || !Array.isArray(result.panes)) return [];

  return result.panes.flatMap((value): HerdrLivePane[] => {
    if (!isRecord(value)) return [];
    const paneId = getString(value, "pane_id", "paneId", "id");
    const workspaceId = getString(value, "workspace_id", "workspaceId") ?? context.workspaceId;
    const tabId = getString(value, "tab_id", "tabId");
    if (!paneId || workspaceId !== context.workspaceId) return [];
    if (context.parentTabId && tabId && tabId !== context.parentTabId) return [];
    return [{
      paneId,
      workspaceId,
      ...(tabId ? { tabId } : {}),
      ...(getString(value, "cwd") ? { cwd: getString(value, "cwd") } : {}),
      ...(getString(value, "foreground_cwd", "foregroundCwd")
        ? { foregroundCwd: getString(value, "foreground_cwd", "foregroundCwd") }
        : {}),
      focused: value.focused === true,
      ...(getString(value, "agent") ? { agent: getString(value, "agent") } : {}),
      ...(getString(value, "agent_status", "agentStatus")
        ? { agentStatus: getString(value, "agent_status", "agentStatus") }
        : {}),
      ...(getString(value, "terminal_title", "terminalTitle")
        ? { terminalTitle: getString(value, "terminal_title", "terminalTitle") }
        : {}),
      lastSeen: now,
    }];
  });
}

export function createHerdrLiveRegistry(client: HerdrClient, ttlMs = LIVE_INVENTORY_TTL_MS) {
  let snapshot: HerdrLiveInventory | undefined;
  let refreshPromise: Promise<HerdrLiveInventory> | undefined;

  async function refresh(context: HerdrContext, force = false): Promise<HerdrLiveInventory> {
    if (!force && snapshot && snapshot.workspaceId === context.workspaceId &&
      snapshot.parentTabId === context.parentTabId && Date.now() - snapshot.refreshedAt < ttlMs) {
      return snapshot;
    }
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      const refreshedAt = Date.now();
      const value = await client.run(["pane", "list", "--workspace", context.workspaceId]);
      const next: HerdrLiveInventory = {
        workspaceId: context.workspaceId,
        ...(context.parentTabId ? { parentTabId: context.parentTabId } : {}),
        panes: extractLivePanes(value, context, refreshedAt),
        refreshedAt,
      };
      snapshot = next;
      return next;
    })();

    try {
      return await refreshPromise;
    } finally {
      refreshPromise = undefined;
    }
  }

  return {
    refresh,
    invalidate() {
      snapshot = undefined;
    },
  };
}

export function formatLiveInventory(inventory: HerdrLiveInventory): string {
  const scope = inventory.parentTabId
    ? `workspace ${inventory.workspaceId}, tab ${inventory.parentTabId}`
    : `workspace ${inventory.workspaceId}`;
  const lines = [`Herdr pane board (${scope}):`];
  if (inventory.panes.length === 0) {
    lines.push("- No panes found.");
    return lines.join("\n");
  }

  for (const pane of inventory.panes) {
    const descriptors = [
      pane.agent ? `agent ${pane.agent}` : "shell",
      pane.agentStatus && pane.agentStatus !== "unknown" ? pane.agentStatus : undefined,
      pane.focused ? "focused" : undefined,
    ].filter(Boolean).join(", ");
    lines.push(`- ${pane.paneId} [${descriptors}]`);
    if (pane.foregroundCwd ?? pane.cwd) lines.push(`  cwd: ${pane.foregroundCwd ?? pane.cwd}`);
    if (pane.terminalTitle) lines.push(`  title: ${pane.terminalTitle}`);
  }
  return lines.join("\n");
}

function toolResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

async function readPersistedState(): Promise<Map<string, HerdrBinding>> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== STATE_VERSION || !Array.isArray(parsed.bindings)) {
      return new Map();
    }

    const bindings = parsed.bindings.filter((value): value is HerdrBinding => {
      if (!isRecord(value)) return false;
      return ["key", "workspaceId", "paneId", "cwd", "createdAt", "updatedAt"]
        .every((key) => typeof value[key] === "string");
    });
    return new Map(bindings.map((binding) => [binding.key, binding]));
  } catch {
    return new Map();
  }
}

async function writePersistedState(bindings: Map<string, HerdrBinding>): Promise<void> {
  await fs.mkdir(getAgentDir(), { recursive: true });
  const state: PersistedState = {
    version: STATE_VERSION,
    bindings: [...bindings.values()],
  };
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function reconcileBindings(bindings: Map<string, HerdrBinding>, inventory: HerdrLiveInventory): Promise<void> {
  const livePaneIds = new Set(inventory.panes.map((pane) => pane.paneId));
  let changed = false;

  for (const [key, binding] of bindings) {
    const sameWorkspace = binding.workspaceId === inventory.workspaceId;
    const sameTab = binding.parentTabId === inventory.parentTabId;
    if (sameWorkspace && sameTab && !livePaneIds.has(binding.paneId)) {
      bindings.delete(key);
      changed = true;
    }
  }

  if (changed) await writePersistedState(bindings);
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

function extractCurrentContext(value: unknown): HerdrContext | undefined {
  const result = getRecord(value, "result") ?? value;
  const pane = getRecord(result, "pane");
  const workspaceId = getString(pane, "workspace_id", "workspaceId") ?? extractWorkspaceId(value);
  if (!workspaceId) return undefined;
  return {
    workspaceId,
    parentTabId: getString(pane, "tab_id", "tabId"),
  };
}

async function getHerdrContext(client: HerdrClient): Promise<HerdrContext> {
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  const parentTabId = process.env.HERDR_TAB_ID;
  if (workspaceId && parentTabId) return { workspaceId, parentTabId };

  const current = await client.run(["pane", "current", "--current"], { timeout: 5_000 });
  const context = extractCurrentContext(current);
  if (!context) throw new Error("Could not determine the current Herdr workspace.");
  return {
    workspaceId: workspaceId ?? context.workspaceId,
    parentTabId: parentTabId ?? context.parentTabId,
  };
}

function bindingKey(context: HerdrContext, cwd: string): string {
  return `${context.workspaceId}|${context.parentTabId ?? "current"}|${cwd}`;
}

async function ensureSupportedHerdr(client: HerdrClient): Promise<string> {
  const raw = await client.runText(["--version"], { timeout: 3_000 });
  const version = parseVersion(raw);
  if (!version || !supportsTabShell(version)) {
    throw new Error(`Herdr ${raw || "version is unknown"} does not support the tab/pane controls required by herdr_shell. Upgrade Herdr to 0.7.5 or newer.`);
  }
  return raw;
}

async function isLivePane(client: HerdrClient, binding: HerdrBinding): Promise<boolean> {
  try {
    await client.run(["pane", "get", binding.paneId], { timeout: 5_000 });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function createPane(
  client: HerdrClient,
  context: HerdrContext,
  cwd: string,
): Promise<{ paneId: string; workspaceId: string }> {
  const created = await client.run([
    "pane",
    "split",
    "--current",
    "--direction",
    "right",
    "--cwd",
    cwd,
    "--no-focus",
  ], { timeout: COMMAND_TIMEOUT_MS });
  const paneId = extractPaneId(created);
  const workspaceId = extractWorkspaceId(created) ?? context.workspaceId;
  if (!paneId) {
    throw new Error("Herdr created a pane but did not return its pane identifier.");
  }
  return { paneId, workspaceId };
}

async function waitForShellStartup(signal?: AbortSignal): Promise<void> {
  // Herdr creates the PTY asynchronously and may not accept the first input
  // immediately. Its read API intentionally returns an empty snapshot during
  // this window, so polling output cannot establish readiness. Use a bounded
  // startup grace period before sending the first command.
  if (signal?.aborted) return;
  await new Promise((resolve) => setTimeout(resolve, SHELL_STARTUP_DELAY_MS));
}

async function getOrCreatePane(
  client: HerdrClient,
  bindings: Map<string, HerdrBinding>,
  context: HerdrContext,
  cwd: string,
  signal?: AbortSignal,
): Promise<HerdrBinding> {
  const key = bindingKey(context, cwd);
  const existing = bindings.get(key);
  if (existing && await isLivePane(client, existing)) return existing;
  if (existing) {
    // A pane may have been closed manually. Invalidate only this confirmed-dead
    // binding, preserving all other persistent cache entries.
    bindings.delete(key);
    await writePersistedState(bindings);
  }

  const created = await createPane(client, context, cwd);
  await waitForShellStartup(signal);
  const now = new Date().toISOString();
  const binding: HerdrBinding = {
    key,
    workspaceId: created.workspaceId,
    ...(context.parentTabId ? { parentTabId: context.parentTabId } : {}),
    paneId: created.paneId,
    cwd,
    createdAt: now,
    updatedAt: now,
  };
  bindings.set(key, binding);
  await writePersistedState(bindings);
  return binding;
}

async function closeBinding(
  client: HerdrClient,
  bindings: Map<string, HerdrBinding>,
  binding: HerdrBinding,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await client.run(["pane", "close", binding.paneId], { timeout: COMMAND_TIMEOUT_MS, signal });
  } catch (error) {
    if (!isNotFound(error) && getErrorCode(error) !== "TAB_GONE") throw error;
  }
  bindings.delete(binding.key);
  await writePersistedState(bindings);
}

function formatStatus(binding: HerdrBinding, pane: unknown, output: string): string {
  const paneRecord = getRecord(pane, "pane") ?? pane;
  const paneStatus = getString(paneRecord, "agent_status") ?? "unknown";
  const foregroundCwd = getString(paneRecord, "foreground_cwd") ?? binding.cwd;
  const lines = [
    `Herdr side-by-side pane: ${binding.paneId}`,
    `Workspace: ${binding.workspaceId}`,
    `Cwd: ${binding.cwd}`,
    `Herdr status: ${paneStatus}`,
    `Foreground cwd: ${foregroundCwd}`,
    `Last command: ${describeCommand(binding.lastCommand)}`,
  ];
  if (output.trim()) lines.push("", "Recent output:", output.trimEnd());
  return lines.join("\n");
}

async function executeAction(
  client: HerdrClient,
  bindings: Map<string, HerdrBinding>,
  liveRegistry: ReturnType<typeof createHerdrLiveRegistry>,
  input: HerdrShellInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<ReturnType<typeof toolResult>> {
  if (ctx.mode !== "tui" || process.env.HERDR_ENV !== "1") {
    throw new Error("herdr_shell requires Pi to run inside a Herdr-managed pane (HERDR_ENV=1).");
  }

  const [herdrVersion, context] = await Promise.all([
    ensureSupportedHerdr(client),
    getHerdrContext(client),
  ]);

  if (input.action === "status" && input.cwd === undefined) {
    const inventory = await liveRegistry.refresh(context, true);
    await reconcileBindings(bindings, inventory);
    return toolResult(formatLiveInventory(inventory), {
      action: input.action,
      workspaceId: context.workspaceId,
      parentTabId: context.parentTabId,
      paneCount: inventory.panes.length,
      refreshedAt: inventory.refreshedAt,
      herdrVersion,
    });
  }

  const cwd = await resolveWorkingDirectory(ctx, input.cwd);
  const key = bindingKey(context, cwd);
  const existing = bindings.get(key);

  if (input.action === "close") {
    if (!existing) return toolResult(`No managed Herdr side-by-side pane exists for ${cwd}.`, { action: input.action, cwd });
    await closeBinding(client, bindings, existing, signal);
    liveRegistry.invalidate();
    const inventory = await liveRegistry.refresh(context, true);
    return toolResult(`Closed managed Herdr pane ${existing.paneId} for ${cwd}.\n\n${formatLiveInventory(inventory)}`, {
      action: input.action,
      cwd,
      paneId: existing.paneId,
      paneCount: inventory.panes.length,
      herdrVersion,
    });
  }

  if (input.action === "status" || input.action === "read_output") {
    if (!existing || !(await isLivePane(client, existing))) {
      if (existing) {
        bindings.delete(key);
        await writePersistedState(bindings);
        liveRegistry.invalidate();
        const inventory = await liveRegistry.refresh(context, true);
        return toolResult(`Managed Herdr pane ${existing.paneId} is no longer open, likely because it was closed manually.\n\n${formatLiveInventory(inventory)}`, {
          action: input.action,
          cwd,
          paneId: existing.paneId,
          paneCount: inventory.panes.length,
          herdrVersion,
        });
      }
      return toolResult(`No live managed Herdr side-by-side pane exists for ${cwd}.`, { action: input.action, cwd, herdrVersion });
    }

    if (input.action === "read_output") {
      const lines = Math.min(input.lines ?? DEFAULT_OUTPUT_LINES, MAX_OUTPUT_LINES);
      const output = await client.runText([
        "pane",
        "read",
        existing.paneId,
        "--source",
        "recent-unwrapped",
        "--format",
        "text",
        "--lines",
        String(lines),
      ], { timeout: COMMAND_TIMEOUT_MS });
      return toolResult(output || "(no recent output)", {
        action: input.action,
        cwd,
        paneId: existing.paneId,
        lines,
        herdrVersion,
      });
    }

    const pane = await client.run(["pane", "get", existing.paneId], { timeout: 5_000 });
    const output = await client.runText([
      "pane",
      "read",
      existing.paneId,
      "--source",
      "recent-unwrapped",
      "--format",
      "text",
      "--lines",
      "20",
    ], { timeout: COMMAND_TIMEOUT_MS });
    return toolResult(formatStatus(existing, pane, output), {
      action: input.action,
      cwd,
      paneId: existing.paneId,
      herdrVersion,
    });
  }

  if ((input.action === "open" || input.action === "run") && !input.command && input.action === "run") {
    throw new Error("herdr_shell run requires a command. Use open without a command to create an interactive shell tab.");
  }

  const binding = await getOrCreatePane(client, bindings, context, cwd, signal);
  if (input.command) {
    await client.run(["pane", "run", binding.paneId, input.command], {
      timeout: COMMAND_TIMEOUT_MS,
    });
    binding.lastCommand = input.command;
    binding.updatedAt = new Date().toISOString();
    await writePersistedState(bindings);
    liveRegistry.invalidate();
    const inventory = await liveRegistry.refresh(context, true);
    return toolResult(
      `Started command in Herdr side-by-side pane ${binding.paneId} without waiting for it to exit: ${describeCommand(input.command)}\nUse herdr_shell read_output to inspect recent stdout/stderr.\n\n${formatLiveInventory(inventory)}`,
      {
        action: input.action,
        cwd,
        paneId: binding.paneId,
        command: describeCommand(input.command),
        paneCount: inventory.panes.length,
        herdrVersion,
      },
    );
  }

  liveRegistry.invalidate();
  const inventory = await liveRegistry.refresh(context, true);
  return toolResult(`Opened interactive shell in Herdr side-by-side pane ${binding.paneId}.\n\n${formatLiveInventory(inventory)}`, {
    action: input.action,
    cwd,
    paneId: binding.paneId,
    paneCount: inventory.panes.length,
    herdrVersion,
  });
}

export default function herdrShellExtension(pi: ExtensionAPI): void {
  const client = createHerdrClient(pi);
  const liveRegistry = createHerdrLiveRegistry(client);
  let bindingsPromise: Promise<Map<string, HerdrBinding>> | undefined;
  let operation = Promise.resolve();

  const getBindings = (): Promise<Map<string, HerdrBinding>> => {
    bindingsPromise ??= readPersistedState();
    return bindingsPromise;
  };

  let currentContext: ExtensionContext | undefined;
  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
  });
  pi.on("session_shutdown", () => {
    currentContext = undefined;
  });

  // Other extensions can request a command in the same managed pane without
  // duplicating Herdr pane state or invoking a shell from the parent process.
  pi.events.on("herdr:open-command", (value) => {
    const request = value as Partial<HerdrOpenCommandRequest>;
    if (typeof request.command !== "string" || typeof request.respond !== "function") return;
    const context = currentContext;
    if (!context) {
      request.respond({ ok: false, error: "No active Pi session is available for Herdr." });
      return;
    }

    const currentOperation = operation.then(async () => {
      const bindings = await getBindings();
      return executeAction(client, bindings, liveRegistry, {
        action: "open",
        command: request.command!,
        cwd: request.cwd,
      }, context);
    });
    operation = currentOperation.then(() => undefined, () => undefined);
    void currentOperation.then(
      () => request.respond!({ ok: true }),
      (error: unknown) => request.respond!({ ok: false, error: formatHerdrError(error) }),
    );
  });

  pi.registerTool({
    name: "herdr_shell",
    label: "Herdr Shell",
    description: "Open and control a persistent shell in a right-side Herdr pane in the current tab. Use status without cwd to inspect the live pane board. Use this for long-running development servers, watchers, logs, and interactive processes; use bash for short commands whose output Pi needs immediately.",
    promptSnippet: "Run long-lived commands in a visible right-side Herdr pane and read their recent output",
    promptGuidelines: [
      "Use bash for short-lived commands when Pi needs their stdout/stderr in the current turn.",
      "Use herdr_shell with action open or run for development servers, watchers, log tails, and other long-running processes.",
      "Use herdr_shell with action read_output to inspect recent output from a managed Herdr pane; do not assume a server started successfully without checking it.",
      "herdr_shell runs asynchronously in a right-side pane and does not wait for a server to exit.",
      "herdr_shell creates one right-side pane in the current Herdr tab and never creates a new tab or workspace.",
      "Use status without cwd to inspect all live panes in the current Herdr tab.",
      "Pane state is reconciled against Herdr before operations; if a pane was closed manually, open/run recreates it and read_output/status reports the refreshed pane board.",
      "If the user closed a pane manually and you need to show something visibly, use open or run to create a fresh pane; do not try to reuse the old pane ID.",
    ],
    parameters: HerdrShellParameters,
    executionMode: "sequential",
    async execute(_toolCallId, input, signal, _onUpdate, ctx) {
      const currentOperation = operation.then(async () => {
        const bindings = await getBindings();
        return executeAction(client, bindings, liveRegistry, input, ctx, signal);
      });
      operation = currentOperation.then(() => undefined, () => undefined);
      return currentOperation;
    },
    renderCall(args, theme) {
      const command = args.command ? ` · ${describeCommand(args.command)}` : "";
      return new Text(theme.fg("toolTitle", `Herdr shell · ${args.action}`) + theme.fg("muted", command), 0, 0);
    },
    renderResult(result, _options, theme, context) {
      const text = result.content.find((part) => part.type === "text")?.text ?? "Herdr shell completed.";
      const firstLine = text.split(/\r?\n/, 1)[0] ?? text;
      return new Text(theme.fg(context.isError ? "error" : "toolOutput", firstLine), 0, 0);
    },
  });
}
