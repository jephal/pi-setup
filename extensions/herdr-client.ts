import type { ExtensionAPI, ExecOptions } from "@earendil-works/pi-coding-agent";

export type JsonRecord = Record<string, unknown>;

export interface HerdrCommandOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export class HerdrError extends Error {
  readonly code: string;

  constructor(message: string, code: string = "HERDR_ERROR") {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

export interface HerdrClient {
  run(args: string[], options?: HerdrCommandOptions): Promise<unknown>;
  runText(args: string[], options?: HerdrCommandOptions): Promise<string>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLastJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Some Herdr commands may write a log line before their JSON envelope.
  }

  for (const line of trimmed.split(/\r?\n/).reverse()) {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      // Keep looking for the final JSON envelope.
    }
  }

  return undefined;
}

function unwrapResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return value.result ?? value;
}

function errorFromValue(value: unknown): HerdrError | undefined {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;

  const error = value.error;
  const code = typeof error.code === "string" ? error.code : "HERDR_ERROR";
  const message = typeof error.message === "string" ? error.message : "Herdr command failed.";
  return new HerdrError(message, code);
}

function normalizeSpawnError(error: unknown, args: string[]): HerdrError {
  if (isRecord(error) && error.code === "ENOENT") {
    return new HerdrError(
      "Herdr is not installed or is not on PATH. Set HERDR_BIN to its executable path.",
      "HERDR_UNAVAILABLE",
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return new HerdrError(`Failed to run Herdr command '${args.join(" ")}': ${message}`);
}

function commandError(stdout: string, stderr: string, code: number, args: string[]): HerdrError {
  const parsed = errorFromValue(parseLastJson(stdout)) ?? errorFromValue(parseLastJson(stderr));
  if (parsed) return parsed;

  const message = stderr.trim() || stdout.trim() || `Herdr exited with code ${code}.`;
  return new HerdrError(message, code === 2 ? "VALIDATION_ERROR" : "HERDR_ERROR");
}

/** Create a small, non-shell client for Herdr's JSON/terminal CLI. */
export function createHerdrClient(pi: ExtensionAPI): HerdrClient {
  const binary = process.env.HERDR_BIN ?? "herdr";

  async function execute(args: string[], options: HerdrCommandOptions = {}) {
    let result;
    try {
      const execOptions: ExecOptions = {
        signal: options.signal,
        timeout: options.timeout ?? 15_000,
      };
      result = await pi.exec(binary, args, execOptions);
    } catch (error) {
      throw normalizeSpawnError(error, args);
    }

    if (result.code !== 0) {
      throw commandError(result.stdout, result.stderr, result.code, args);
    }

    return result;
  }

  return {
    async run(args, options) {
      const result = await execute(args, options);
      const parsed = parseLastJson(result.stdout);
      if (parsed !== undefined) {
        const parsedError = errorFromValue(parsed);
        if (parsedError) throw parsedError;
        return unwrapResult(parsed);
      }

      return result.stdout.trimEnd();
    },

    async runText(args, options) {
      const result = await execute(args, options);
      return result.stdout.trimEnd();
    },
  };
}

export function getRecord(value: unknown, key: string): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return isRecord(candidate) ? candidate : undefined;
}

export function getString(value: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return undefined;
}

export function extractTabId(value: unknown): string | undefined {
  const result = getRecord(value, "result") ?? value;
  const tab = getRecord(result, "tab");
  return getString(tab, "tab_id", "tabId", "id") ?? getString(result, "tab_id", "tabId", "id");
}

export function extractRootPaneId(value: unknown): string | undefined {
  const result = getRecord(value, "result") ?? value;
  const root = isRecord(result) ? (result.root_pane ?? result.rootPane) : undefined;
  return getString(root, "pane_id", "paneId", "id") ?? (typeof root === "string" ? root : undefined);
}

export function extractPaneId(value: unknown): string | undefined {
  const result = getRecord(value, "result") ?? value;
  const pane = getRecord(result, "pane") ?? result;
  return getString(pane, "pane_id", "paneId", "id");
}

export function extractWorkspaceId(value: unknown): string | undefined {
  const result = getRecord(value, "result") ?? value;
  const workspace = getRecord(result, "workspace");
  return getString(workspace, "workspace_id", "workspaceId", "id") ??
    getString(result, "workspace_id", "workspaceId");
}

export function extractTabWorkspaceId(value: unknown): string | undefined {
  const result = getRecord(value, "result") ?? value;
  const tab = getRecord(result, "tab") ?? result;
  return getString(tab, "workspace_id", "workspaceId");
}

export function isNotFound(error: unknown): boolean {
  if (!(error instanceof HerdrError)) return false;
  const code = error.code.toUpperCase().replaceAll("-", "_");
  return code === "NOT_FOUND" ||
    code === "PANE_GONE" ||
    code === "PANE_NOT_FOUND" ||
    code === "TAB_GONE" ||
    code === "TAB_NOT_FOUND";
}

export function parseVersion(value: string): { major: number; minor: number; patch: number } | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function supportsTabShell(version: { major: number; minor: number; patch: number }): boolean {
  return version.major > 0 || version.minor > 7 || (version.minor === 7 && version.patch >= 5);
}

export function formatHerdrError(error: unknown): string {
  if (error instanceof HerdrError) return `Herdr error (${error.code}): ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
