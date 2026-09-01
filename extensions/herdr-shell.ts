import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { formatSize, getAgentDir, truncateTail, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
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
const MAX_OUTPUT_BYTES = 24 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
const SHELL_STARTUP_DELAY_MS = 6_000;
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
  paneId?: string;
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

function toolResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export function truncateHerdrOutput(output: string, maxLines: number) {
  const sanitized = output
    .replace(/\r\n?/g, "\n")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const result = truncateTail(sanitized, { maxLines, maxBytes: MAX_OUTPUT_BYTES });
  const marker = result.truncated
    ? `\n\n[Recent output truncated by ${result.truncatedBy ?? "limit"}: showing ${result.outputLines}/${result.totalLines} lines and ${formatSize(result.outputBytes)}/${formatSize(result.totalBytes)}. Inspect the Herdr pane for the complete requested window.]`
    : "";
  return {
    text: `${result.content}${marker}`,
    truncation: {
      truncated: result.truncated,
      truncatedBy: result.truncatedBy,
      totalLines: result.totalLines,
      totalBytes: result.totalBytes,
      outputLines: result.outputLines,
      outputBytes: result.outputBytes,
      maxLines: result.maxLines,
      maxBytes: result.maxBytes,
    },
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
  const paneId = extractPaneId(value);
  if (!workspaceId) return undefined;
  return {
    workspaceId,
    parentTabId: getString(pane, "tab_id", "tabId"),
    ...(paneId ? { paneId } : {}),
  };
}

async function getHerdrContext(client: HerdrClient): Promise<HerdrContext> {
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  const parentTabId = process.env.HERDR_TAB_ID;
  const paneId = process.env.HERDR_PANE_ID;
  if (workspaceId) return { workspaceId, parentTabId, paneId };

  const current = await client.run(["pane", "current", "--current"], { timeout: 5_000 });
  const context = extractCurrentContext(current);
  if (!context) throw new Error("Could not determine the current Herdr workspace.");
  return { ...context, ...(paneId ? { paneId } : {}) };
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

async function isLivePane(client: HerdrClient, binding: HerdrBinding, signal?: AbortSignal): Promise<boolean> {
  try {
    await client.run(["pane", "get", binding.paneId], { timeout: 5_000, signal });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function createPane(
  client: HerdrClient,
  context: HerdrContext,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ paneId: string; workspaceId: string }> {
  const splitArgs = [
    "pane",
    "split",
    ...(context.paneId ? ["--pane", context.paneId] : ["--current"]),
    "--direction",
    "right",
    "--cwd",
    cwd,
    "--no-focus",
  ];
  let created: unknown;
  try {
    created = await client.run(splitArgs, { timeout: COMMAND_TIMEOUT_MS, signal });
  } catch (error) {
    if (!context.paneId || !isNotFound(error)) throw error;

    // A stale inherited caller ID should not prevent opening a new pane. The
    // current-pane fallback is safe here because the request is still issued
    // from the active Pi/Herdr session.
    try {
      created = await client.run([
        "pane",
        "split",
        "--current",
        "--direction",
        "right",
        "--cwd",
        cwd,
        "--no-focus",
      ], { timeout: COMMAND_TIMEOUT_MS, signal });
    } catch (fallbackError) {
      throw new AggregateError(
        [error, fallbackError],
        `Herdr caller pane ${context.paneId} was unavailable and the current pane fallback failed: ${formatHerdrError(fallbackError)}`,
      );
    }
  }
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
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, SHELL_STARTUP_DELAY_MS);
    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
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
  if (existing && await isLivePane(client, existing, signal)) return existing;
  if (existing) bindings.delete(key);

  const created = await createPane(client, context, cwd, signal);
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

export async function runPaneCommandWithRecovery(
  client: HerdrClient,
  binding: HerdrBinding,
  command: string,
  recreate: () => Promise<HerdrBinding>,
  signal?: AbortSignal,
): Promise<HerdrBinding> {
  try {
    await client.run(["pane", "run", binding.paneId, command], {
      timeout: COMMAND_TIMEOUT_MS,
      signal,
    });
    return binding;
  } catch (error) {
    if (!isNotFound(error)) throw error;

    // The pane can disappear after getOrCreatePane() checks it. Recreate the
    // binding and retry once instead of exposing the stale pane error.
    let replacement: HerdrBinding;
    try {
      replacement = await recreate();
    } catch (recreateError) {
      throw new AggregateError(
        [error, recreateError],
        `Herdr pane ${binding.paneId} disappeared and could not be recreated: ${formatHerdrError(recreateError)}`,
      );
    }

    try {
      await client.run(["pane", "run", replacement.paneId, command], {
        timeout: COMMAND_TIMEOUT_MS,
        signal,
      });
      return replacement;
    } catch (retryError) {
      throw new AggregateError(
        [error, retryError],
        `Herdr pane ${binding.paneId} disappeared; replacement pane ${replacement.paneId} could not run the command: ${formatHerdrError(retryError)}`,
      );
    }
  }
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
  input: HerdrShellInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<ReturnType<typeof toolResult>> {
  if (ctx.mode !== "tui" || process.env.HERDR_ENV !== "1") {
    throw new Error("herdr_shell requires Pi to run inside a Herdr-managed pane (HERDR_ENV=1).");
  }

  const cwd = await resolveWorkingDirectory(ctx, input.cwd);
  const herdrVersion = await ensureSupportedHerdr(client);
  const context = await getHerdrContext(client);
  const key = bindingKey(context, cwd);
  const existing = bindings.get(key);

  if (input.action === "close") {
    if (!existing) return toolResult(`No managed Herdr side-by-side pane exists for ${cwd}.`, { action: input.action, cwd });
    await closeBinding(client, bindings, existing, signal);
    return toolResult(`Closed managed Herdr pane ${existing.paneId} for ${cwd}.`, {
      action: input.action,
      cwd,
      paneId: existing.paneId,
    });
  }

  if (input.action === "status" || input.action === "read_output") {
    if (!existing || !(await isLivePane(client, existing, signal))) {
      if (existing) {
        bindings.delete(key);
        await writePersistedState(bindings);
      }
      return toolResult(`No live managed Herdr side-by-side pane exists for ${cwd}.`, { action: input.action, cwd });
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
      const bounded = truncateHerdrOutput(output, lines);
      return toolResult(bounded.text || "(no recent output)", {
        action: input.action,
        cwd,
        paneId: existing.paneId,
        lines,
        herdrVersion,
        truncation: bounded.truncation,
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
    const bounded = truncateHerdrOutput(output, 20);
    return toolResult(formatStatus(existing, pane, bounded.text), {
      action: input.action,
      cwd,
      paneId: existing.paneId,
      herdrVersion,
      truncation: bounded.truncation,
    });
  }

  if ((input.action === "open" || input.action === "run") && !input.command && input.action === "run") {
    throw new Error("herdr_shell run requires a command. Use open without a command to create an interactive shell tab.");
  }

  const initialBinding = await getOrCreatePane(client, bindings, context, cwd, signal);
  let binding = initialBinding;
  if (input.command) {
    binding = await runPaneCommandWithRecovery(client, initialBinding, input.command, async () => {
      if (bindings.get(initialBinding.key)?.paneId === initialBinding.paneId) {
        bindings.delete(initialBinding.key);
        await writePersistedState(bindings);
      }
      return getOrCreatePane(client, bindings, context, cwd, signal);
    }, signal);
    binding.lastCommand = input.command;
    binding.updatedAt = new Date().toISOString();
    await writePersistedState(bindings);
    return toolResult(
      `Started command in Herdr side-by-side pane ${binding.paneId} without waiting for it to exit: ${describeCommand(input.command)}\nUse herdr_shell read_output to inspect recent stdout/stderr.`,
      {
        action: input.action,
        cwd,
        paneId: binding.paneId,
        command: describeCommand(input.command),
        herdrVersion,
      },
    );
  }

  return toolResult(`Opened interactive shell in Herdr side-by-side pane ${binding.paneId}.`, {
    action: input.action,
    cwd,
    paneId: binding.paneId,
    herdrVersion,
  });
}

export default function herdrShellExtension(pi: ExtensionAPI): void {
  const client = createHerdrClient(pi);
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
      return executeAction(client, bindings, {
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
    description: "Control one persistent shell in the current tab's right-side Herdr pane. Use it for servers, watchers, logs, or interactive processes; use bash when Pi needs output this turn.",
    promptSnippet: "Run long-lived work in a Herdr side pane",
    promptGuidelines: [
      "Use open or run for long-lived work, then read_output to verify it started.",
      "It runs asynchronously and reuses one pane in the current Herdr tab.",
    ],
    parameters: HerdrShellParameters,
    executionMode: "sequential",
    async execute(_toolCallId, input, signal, _onUpdate, ctx) {
      const currentOperation = operation.then(async () => {
        const bindings = await getBindings();
        return executeAction(client, bindings, input, ctx, signal);
      });
      operation = currentOperation.then(() => undefined, () => undefined);
      return currentOperation;
    },
    renderCall(args, theme) {
      const command = args.command ? ` · ${describeCommand(args.command)}` : "";
      return new Text(theme.fg("toolTitle", `Herdr shell · ${args.action}`) + theme.fg("muted", command), 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      const text = result.content.find((part) => part.type === "text")?.text ?? "Herdr shell completed.";
      if (expanded) return new Text(theme.fg(context.isError ? "error" : "toolOutput", text), 0, 0);
      const firstLine = text.split(/\r?\n/, 1)[0] ?? text;
      return new Text(theme.fg(context.isError ? "error" : "toolOutput", firstLine), 0, 0);
    },
  });
}
