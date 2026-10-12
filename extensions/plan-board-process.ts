#!/usr/bin/env node
/** Dependency-free Plan Board process controlled over a private Unix socket. */
import { chmod, mkdir, mkdtemp, rm, stat, unlink } from "node:fs/promises";
import net from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderPlanBoardAnsi, validatePlanBoardSnapshot, type PlanBoardMarkdownRenderer, type PlanBoardRenderOptions, type PlanBoardSnapshot } from "./plan-board.ts";

export const PLAN_BOARD_MAX_CONTROL_FRAME_BYTES = 1_048_576;
export const PLAN_BOARD_MAX_CONTROL_BUFFER_BYTES = PLAN_BOARD_MAX_CONTROL_FRAME_BYTES * 2;
export const PLAN_BOARD_CONTROL_TIMEOUT_MS = 10_000;
export const PLAN_BOARD_MAX_CONTROL_CONNECTIONS = 32;
export const PLAN_BOARD_ROLE = "plan-board" as const;

export type PlanBoardOperation = "set_snapshot" | "update" | "get" | "ping" | "redraw" | "close";
export interface PlanBoardFrame { op: PlanBoardOperation; snapshot?: unknown; revision?: number; requestId?: string; }
export interface PlanBoardResponse { ok: boolean; revision?: number; snapshot?: PlanBoardSnapshot; error?: string; requestId?: string; }
export interface PlanBoardEndpoint { directory: string; socket: string; cleanup: () => Promise<void>; }

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function frameBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8") + 1; }
function validRevision(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validateSocketPath(socket: string): void {
  if (!socket || !socket.startsWith("/") || socket.includes("\0") || Buffer.byteLength(socket) > 100) throw new Error("Plan Board socket must be an absolute, short Unix-socket path.");
}

export function parsePlanBoardFrame(line: string): PlanBoardFrame {
  if (Buffer.byteLength(line, "utf8") > PLAN_BOARD_MAX_CONTROL_FRAME_BYTES) throw new Error("Plan Board control frame is too large.");
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error("Plan Board control frame must be valid JSON."); }
  if (!isRecord(value) || typeof value.op !== "string" || !["set_snapshot", "update", "get", "ping", "redraw", "close"].includes(value.op)) throw new Error("unsupported Plan Board control operation.");
  if (value.revision !== undefined && !validRevision(value.revision)) throw new Error("Plan Board revision must be a non-negative safe integer.");
  if (value.requestId !== undefined && (typeof value.requestId !== "string" || value.requestId.length > 200)) throw new Error("Plan Board requestId must be a short string.");
  return value as unknown as PlanBoardFrame;
}

export async function createPlanBoardEndpoint(prefix = "pi-plan-board-"): Promise<PlanBoardEndpoint> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  const socket = join(directory, "board.sock");
  validateSocketPath(socket);
  let cleaned = false;
  return { directory, socket, cleanup: async () => { if (cleaned) return; cleaned = true; await unlink(socket).catch(() => undefined); await rm(directory, { recursive: true, force: true }); } };
}

/** The only command Herdr is allowed to launch for this role. */
export function planBoardCommand(socket: string, entry = fileURLToPath(import.meta.url)): string {
  validateSocketPath(socket);
  return `${shellQuote(process.execPath)} --experimental-strip-types ${shellQuote(entry)} --socket ${shellQuote(socket)}`;
}
export function shellQuote(value: string): string {
  if (!value || value.includes("\0")) throw new Error("Plan Board command argument is invalid.");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function waitForPlanBoardSocket(socket: string, timeoutMs = 6_000, signal?: AbortSignal): Promise<void> {
  validateSocketPath(socket);
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Plan Board startup was cancelled.");
      try {
        await new Promise<void>((resolve, reject) => {
          const connection = net.createConnection({ path: socket });
          const timer = setTimeout(() => { connection.destroy(); reject(new Error("not ready")); }, 250);
          connection.once("connect", () => { clearTimeout(timer); connection.destroy(); resolve(); });
          connection.once("error", (error) => { clearTimeout(timer); connection.destroy(); reject(error); });
        });
        return;
      } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    throw new Error(`Plan Board did not expose a usable socket within ${timeoutMs / 1_000} seconds.`);
  })();
}

export function sendPlanBoardCommand(socket: string, frame: PlanBoardFrame, timeoutMs = 3_000): Promise<PlanBoardResponse> {
  validateSocketPath(socket);
  if (frameBytes(frame) > PLAN_BOARD_MAX_CONTROL_FRAME_BYTES) return Promise.reject(new Error("Plan Board control frame is too large."));
  const payload = `${JSON.stringify(frame)}\n`;
  return new Promise((resolve, reject) => {
    const connection = net.createConnection({ path: socket });
    let data = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Plan Board control request timed out.")), timeoutMs);
    const finish = (error?: Error, response?: PlanBoardResponse) => {
      if (settled) return;
      settled = true; clearTimeout(timer); connection.destroy();
      if (error) reject(error); else if (!response) reject(new Error("Plan Board returned an empty response.")); else if (!response.ok) reject(new Error(response.error || "Plan Board control request failed.")); else resolve(response);
    };
    connection.once("error", (error) => finish(error));
    connection.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (Buffer.byteLength(data, "utf8") > PLAN_BOARD_MAX_CONTROL_BUFFER_BYTES) return finish(new Error("Plan Board response exceeded the frame limit."));
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      try { finish(undefined, JSON.parse(data.slice(0, newline)) as PlanBoardResponse); } catch { finish(new Error("Plan Board returned invalid JSON.")); }
    });
    connection.once("connect", () => connection.end(payload));
  });
}

interface BoardRuntime { snapshot?: PlanBoardSnapshot; revision: number; }

type SharedMarkdownComponent = { render: (width: number) => string[] };
type SharedMarkdownConstructor = new (text: string, paddingX: number, paddingY: number, theme: unknown) => SharedMarkdownComponent;

/** Load Pi's public Markdown component without making the standalone board depend on it. */
async function loadSharedMarkdownRenderer(): Promise<PlanBoardMarkdownRenderer | undefined> {
  try {
    const [tui, codingAgent] = await Promise.all([
      import("@earendil-works/pi-tui"),
      import("@earendil-works/pi-coding-agent"),
    ]);
    const Markdown = tui.Markdown as unknown as SharedMarkdownConstructor;
    // Herdr launches this file as an independent Node process, so Pi's
    // interactive startup has not initialized the theme proxy for us.
    codingAgent.initTheme();
    const theme = codingAgent.getMarkdownTheme();
    return (markdown, width) => new Markdown(markdown, 0, 0, theme).render(width);
  } catch {
    // Pi can run the process in a minimal environment. The plain projection is
    // deliberately retained as a safe renderer when shared UI packages fail.
    return undefined;
  }
}

function keyName(value: Buffer): "quit" | "redraw" | "up" | "down" | "pageUp" | "pageDown" | "home" | "end" | "wheelUp" | "wheelDown" | undefined {
  const text = value.toString();
  if (text === "q" || value[0] === 3) return "quit";
  if (text === "r" || text === "\u000c") return "redraw";
  if (text === "\u001b[A" || text === "k") return "up";
  if (text === "\u001b[B" || text === "j") return "down";
  if (text === "\u001b[5~" || text === "\u0015") return "pageUp";
  if (text === "\u001b[6~" || text === "\u0004") return "pageDown";
  if (text === "\u001b[H" || text === "\u001b[1~" || text === "\u001b[7~") return "home";
  if (text === "\u001b[F" || text === "\u001b[4~" || text === "\u001b[8~") return "end";
  const mouse = /^\u001b\[<(64|65);\d+;\d+[mM]$/.exec(text);
  if (mouse?.[1] === "64") return "wheelUp";
  if (mouse?.[1] === "65") return "wheelDown";
  return undefined;
}

export interface PlanBoardProcessOptions { socket: string; width?: number; height?: number; stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream; }

/** Run the interactive board. Exported so tests can exercise cleanup without a terminal. */
export async function runPlanBoard(options: PlanBoardProcessOptions): Promise<void> {
  validateSocketPath(options.socket);
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const runtime: BoardRuntime = { revision: 0 };
  const markdownRenderer = await loadSharedMarkdownRenderer();
  let renderOptions: PlanBoardRenderOptions = { width: options.width ?? output.columns ?? 80, height: options.height ?? (output.rows ? output.rows - 1 : 23), scroll: 0, color: !!output.isTTY };
  let closed = false;
  const interactive = !!input.isTTY && !!output.isTTY;
  let raw = false;
  let alternate = false;
  let server: net.Server;
  let activeConnections = 0;
  let cleanupPromise: Promise<void> | undefined;

  const leaveTerminal = () => {
    if (raw && typeof input.setRawMode === "function") { try { input.setRawMode(false); } catch { /* best effort */ } }
    raw = false;
    if (alternate) { try { output.write("\u001b[0m\u001b[?1006l\u001b[?1000l\u001b[?25h\u001b[?1049l"); } catch { /* best effort */ } }
    alternate = false;
  };
  const close = async () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (closed) return;
      closed = true;
      input.off("data", keyHandler);
      leaveTerminal();
      try { (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.(); } catch { /* best effort */ }
      await new Promise<void>((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } });
      await unlink(options.socket).catch(() => undefined);
    })();
    return cleanupPromise;
  };
  const render = () => {
    if (closed || !runtime.snapshot) return;
    const result = renderPlanBoardAnsi(runtime.snapshot, renderOptions, markdownRenderer);
    renderOptions = { ...renderOptions, scroll: result.scroll };
    try { output.write((interactive ? "\u001b[2J\u001b[H" : "") + result.output + "\n"); } catch { void close(); }
  };
  const enterTerminal = () => {
    if (!interactive || alternate) return;
    alternate = true;
    try {
      output.write("\u001b[?1049h\u001b[?25l\u001b[?1000h\u001b[?1006h");
      if (typeof input.setRawMode === "function") { input.setRawMode(true); raw = true; }
      input.resume();
    } catch { void close(); }
  };
  const keyHandler = (value: Buffer) => {
    const key = keyName(value);
    if (!key || !runtime.snapshot) return;
    if (key === "quit") { void close(); return; }
    if (key === "redraw") { render(); return; }
    const page = Math.max(1, Math.floor((renderOptions.height ?? 24) - 3));
    const current = renderOptions.scroll ?? 0;
    const scroll = key === "home"
      ? 0
      : key === "end"
        ? Number.MAX_SAFE_INTEGER
        : current + (key === "pageDown" ? page : key === "pageUp" ? -page : key === "wheelDown" ? 3 : key === "wheelUp" ? -3 : key === "down" ? 1 : -1);
    renderOptions = { ...renderOptions, scroll };
    render();
  };

  server = net.createServer((connection) => {
    if (activeConnections >= PLAN_BOARD_MAX_CONTROL_CONNECTIONS) { connection.destroy(); return; }
    activeConnections++;
    let rejected = false;
    let frameCount = 0;
    let buffer = "";
    const rejectConnection = () => { if (rejected) return; rejected = true; connection.destroy(); };
    connection.setEncoding("utf8");
    connection.setTimeout(PLAN_BOARD_CONTROL_TIMEOUT_MS, rejectConnection);
    connection.once("close", () => { activeConnections--; });
    connection.on("error", () => { rejected = true; });
    connection.on("data", (chunk: string) => {
      if (rejected) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > PLAN_BOARD_MAX_CONTROL_BUFFER_BYTES) { rejectConnection(); return; }
      // Reject a pipelined second frame before doing any render/validation work.
      if (buffer.indexOf("\n") !== buffer.lastIndexOf("\n")) { rejectConnection(); return; }
      let newline = buffer.indexOf("\n");
      while (!rejected && newline >= 0) {
        // A control connection is intentionally single-request. This bounds
        // validation/render work even when a local client keeps the socket open.
        if (frameCount++ >= 1) { rejectConnection(); return; }
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n");
        let response: PlanBoardResponse;
        try {
          const frame = parsePlanBoardFrame(line);
          if (frame.op === "set_snapshot") {
            if (runtime.revision !== 0 || frame.revision !== 1) throw new Error("set_snapshot is allowed only for the initial revision.");
            runtime.snapshot = validatePlanBoardSnapshot(frame.snapshot);
            runtime.revision = 1; renderOptions = { ...renderOptions, scroll: 0 }; enterTerminal(); render(); response = { ok: true, revision: runtime.revision, requestId: frame.requestId };
          } else if (frame.op === "update") {
            if (!runtime.snapshot) throw new Error("Plan Board has no snapshot.");
            if (frame.revision !== runtime.revision) { response = { ok: false, revision: runtime.revision, error: "stale Plan Board revision.", requestId: frame.requestId }; }
            else {
              runtime.snapshot = validatePlanBoardSnapshot(frame.snapshot);
              runtime.revision++; renderOptions = { ...renderOptions, scroll: Math.min(renderOptions.scroll ?? 0, 1_000_000) }; render(); response = { ok: true, revision: runtime.revision, requestId: frame.requestId };
            }
          } else if (frame.op === "get") response = { ok: true, snapshot: runtime.snapshot, revision: runtime.revision, requestId: frame.requestId };
          else if (frame.op === "ping") response = { ok: true, revision: runtime.revision, requestId: frame.requestId };
          else if (frame.op === "redraw") { render(); response = { ok: true, revision: runtime.revision, requestId: frame.requestId }; }
          else { response = { ok: true, revision: runtime.revision, requestId: frame.requestId }; setImmediate(() => { void close(); }); }
        } catch (error) { response = { ok: false, revision: runtime.revision, error: error instanceof Error ? error.message : "Plan Board request failed." }; }
        if (frameBytes(response) > PLAN_BOARD_MAX_CONTROL_FRAME_BYTES) response = { ok: false, error: "Plan Board response is too large." };
        if (!connection.destroyed) {
          try { connection.write(JSON.stringify(response) + "\n", () => connection.destroy()); }
          catch { rejectConnection(); }
        }
        return;
      }
    });
  });

  const onSignal = () => { void close(); };
  try {
    await mkdir(dirname(options.socket), { recursive: true, mode: 0o700 });
    const parent = await stat(dirname(options.socket));
    if ((parent.mode & 0o077) !== 0 || (typeof process.getuid === "function" && parent.uid !== process.getuid())) throw new Error("Plan Board socket parent must be private to the current user.");
    try { await stat(options.socket); throw new Error("Plan Board socket already exists; refusing to replace it."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.socket, () => { server.off("error", reject); resolve(); }); });
    await chmod(options.socket, 0o600);
    process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
    if (interactive) input.on("data", keyHandler); else input.pause();
    await new Promise<void>((resolve) => server.once("close", resolve));
  } finally {
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
    if (interactive) input.off("data", keyHandler); else input.pause();
    await close();
    leaveTerminal();
  }
}

async function main(): Promise<void> {
  const index = process.argv.indexOf("--socket");
  const socket = index >= 0 ? process.argv[index + 1] : undefined;
  if (index !== 2 || !socket || process.argv.length !== 4) throw new Error("usage: plan-board-process --socket /private/path/board.sock");
  await runPlanBoard({ socket });
}

const invoked = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invoked) main().catch((error) => { process.stderr.write(`plan board: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
