#!/usr/bin/env node
/**
 * Small dependency-free terminal viewer process. The parent controls it over a
 * private Unix socket; model-authored commands never reach this process.
 */
import { chmod, mkdir, mkdtemp, rm, stat, unlink } from "node:fs/promises";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderExcalidrawAnsi, type TerminalRenderOptions } from "./excalidraw-terminal-renderer.ts";

export const MAX_CONTROL_FRAME_BYTES = 1_048_576;
export const MAX_CONTROL_BUFFER_BYTES = MAX_CONTROL_FRAME_BYTES * 2;
export const CONTROL_CONNECTION_TIMEOUT_MS = 10_000;
export const MAX_CONTROL_CONNECTIONS = 32;
export const TERMINAL_VIEWER_ROLE = "visualization-viewer" as const;

export type TerminalViewerOperation = "set_scene" | "update" | "get" | "ping" | "close";
export interface TerminalViewerFrame {
  op: TerminalViewerOperation;
  scene?: unknown;
  revision?: number;
  requestId?: string;
}
export interface TerminalViewerResponse { ok: boolean; revision?: number; scene?: unknown; error?: string; requestId?: string; }
export interface TerminalViewerEndpoint { directory: string; socket: string; cleanup: () => Promise<void>; }

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function frameBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8") + 1; }
function validRevision(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validateSocketPath(socket: string): void {
  if (!socket || !socket.startsWith("/") || socket.includes("\0") || Buffer.byteLength(socket) > 100) throw new Error("viewer socket must be an absolute, short Unix-socket path.");
}

export function parseControlFrame(line: string): TerminalViewerFrame {
  if (Buffer.byteLength(line, "utf8") > MAX_CONTROL_FRAME_BYTES) throw new Error("viewer control frame is too large.");
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error("viewer control frame must be valid JSON."); }
  if (!isRecord(value) || typeof value.op !== "string" || !["set_scene", "update", "get", "ping", "close"].includes(value.op)) throw new Error("unsupported viewer control operation.");
  if (value.revision !== undefined && !validRevision(value.revision)) throw new Error("viewer revision must be a non-negative safe integer.");
  if (value.requestId !== undefined && (typeof value.requestId !== "string" || value.requestId.length > 200)) throw new Error("viewer requestId must be a short string.");
  return value as unknown as TerminalViewerFrame;
}

export async function createTerminalViewerEndpoint(prefix = "pi-terminal-viewer-"): Promise<TerminalViewerEndpoint> {
  const directory = await mkdtemp(join(tmpdir(), prefix), { encoding: "utf8" });
  await chmod(directory, 0o700);
  const socket = join(directory, "viewer.sock");
  validateSocketPath(socket);
  let cleaned = false;
  return { directory, socket, cleanup: async () => { if (cleaned) return; cleaned = true; await unlink(socket).catch(() => undefined); await rm(directory, { recursive: true, force: true }); } };
}

/** The only command Herdr is allowed to launch for this role. */
export function terminalViewerCommand(socket: string, entry = fileURLToPath(import.meta.url)): string {
  validateSocketPath(socket);
  return `${shellQuote(process.execPath)} --experimental-strip-types ${shellQuote(entry)} --socket ${shellQuote(socket)}`;
}
export function shellQuote(value: string): string {
  if (!value || value.includes("\0")) throw new Error("viewer command argument is invalid.");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function waitForTerminalViewerSocket(socket: string, timeoutMs = 6_000, signal?: AbortSignal): Promise<void> {
  validateSocketPath(socket);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("viewer startup was cancelled.");
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
  throw new Error(`terminal viewer did not expose a usable socket within ${timeoutMs / 1_000} seconds.`);
}

export function sendTerminalViewerCommand(socket: string, frame: TerminalViewerFrame, timeoutMs = 3_000): Promise<TerminalViewerResponse> {
  validateSocketPath(socket);
  if (frameBytes(frame) > MAX_CONTROL_FRAME_BYTES) return Promise.reject(new Error("viewer control frame is too large."));
  const payload = `${JSON.stringify(frame)}\n`;
  return new Promise((resolve, reject) => {
    const connection = net.createConnection({ path: socket });
    let data = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("viewer control request timed out.")), timeoutMs);
    const finish = (error?: Error, response?: TerminalViewerResponse) => {
      if (settled) return;
      settled = true; clearTimeout(timer); connection.destroy();
      if (error) reject(error); else if (!response) reject(new Error("viewer returned an empty response.")); else if (!response.ok) reject(new Error(response.error || "viewer control request failed.")); else resolve(response);
    };
    connection.once("error", (error) => finish(error));
    connection.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (Buffer.byteLength(data, "utf8") > MAX_CONTROL_BUFFER_BYTES) return finish(new Error("viewer response exceeded the frame limit."));
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      try { finish(undefined, JSON.parse(data.slice(0, newline)) as TerminalViewerResponse); } catch { finish(new Error("viewer returned invalid JSON.")); }
    });
    connection.once("connect", () => { connection.end(payload); });
  });
}

interface ViewerRuntime { scene?: Record<string, unknown>; revision: number; }
function sceneForRender(scene: Record<string, unknown> | undefined): Record<string, unknown> {
  return scene ?? { type: "excalidraw", elements: [], appState: {}, files: {} };
}
function keyName(value: Buffer): "quit" | "reset" | "zoomIn" | "zoomOut" | "left" | "right" | "up" | "down" | undefined {
  if (value.toString() === "q" || value[0] === 3) return "quit";
  if (value.toString() === "0") return "reset";
  if (value.toString() === "+" || value.toString() === "=") return "zoomIn";
  if (value.toString() === "-") return "zoomOut";
  const text = value.toString();
  if (text === "\u001b[D" || text === "h") return "left";
  if (text === "\u001b[C" || text === "l") return "right";
  if (text === "\u001b[A" || text === "k") return "up";
  if (text === "\u001b[B" || text === "j") return "down";
  return undefined;
}

export interface TerminalViewerProcessOptions { socket: string; width?: number; height?: number; stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream; }

/** Run the process. Exported for focused tests; the CLI calls this only when executed directly. */
export async function runTerminalViewer(options: TerminalViewerProcessOptions): Promise<void> {
  validateSocketPath(options.socket);
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const runtime: ViewerRuntime = { revision: 0 };
  let renderOptions: TerminalRenderOptions = { width: options.width ?? output.columns ?? 80, height: options.height ?? (output.rows ? output.rows - 1 : 23), zoom: 1, panX: 0, panY: 0, color: !!output.isTTY };
  let closed = false;
  let interactive = !!input.isTTY && !!output.isTTY;
  let raw = false;
  let alternate = false;
  let server: net.Server;
  let activeConnections = 0;
  let cleanupPromise: Promise<void> | undefined;

  const leaveTerminal = () => {
    if (raw && typeof input.setRawMode === "function") { try { input.setRawMode(false); } catch { /* best effort during failure cleanup */ } }
    raw = false;
    if (alternate) { try { output.write("\u001b[0m\u001b[?25h\u001b[?1049l"); } catch { /* best effort during failure cleanup */ } }
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
      await new Promise<void>((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); /* setup may have failed before listen */ }
      });
      await unlink(options.socket).catch(() => undefined);
    })();
    return cleanupPromise;
  };
  const render = () => {
    if (closed || !runtime.scene) return;
    const result = renderExcalidrawAnsi(runtime.scene, renderOptions);
    try {
      if (interactive) output.write("\u001b[2J\u001b[H" + result.output + "\n");
      else output.write(result.output.slice(0, 256 * 1024) + "\n");
    } catch (error) {
      void close();
      throw error;
    }
  };
  const enterTerminal = () => {
    if (!interactive || alternate) return;
    alternate = true;
    try {
      output.write("\u001b[?1049h\u001b[?25l");
      if (typeof input.setRawMode === "function") { input.setRawMode(true); raw = true; }
      input.resume();
    } catch (error) {
      void close();
      throw error;
    }
  };
  const keyHandler = (value: Buffer) => {
    try {
      const key = keyName(value); if (!key || !runtime.scene) return;
      if (key === "quit") { void close(); return; }
      if (key === "reset") renderOptions = { ...renderOptions, zoom: 1, panX: 0, panY: 0 };
      if (key === "zoomIn") renderOptions = { ...renderOptions, zoom: Math.min(8, (renderOptions.zoom ?? 1) * 1.25) };
      if (key === "zoomOut") renderOptions = { ...renderOptions, zoom: Math.max(0.2, (renderOptions.zoom ?? 1) / 1.25) };
      if (key === "left") renderOptions = { ...renderOptions, panX: (renderOptions.panX ?? 0) + 2 };
      if (key === "right") renderOptions = { ...renderOptions, panX: (renderOptions.panX ?? 0) - 2 };
      if (key === "up") renderOptions = { ...renderOptions, panY: (renderOptions.panY ?? 0) + 1 };
      if (key === "down") renderOptions = { ...renderOptions, panY: (renderOptions.panY ?? 0) - 1 };
      render();
    } catch { void close(); }
  };

  server = net.createServer((connection) => {
    if (activeConnections >= MAX_CONTROL_CONNECTIONS) { connection.destroy(); return; }
    activeConnections++;
    let rejected = false;
    let frameCount = 0;
    let buffer = "";
    const rejectConnection = () => { if (rejected) return; rejected = true; connection.destroy(); };
    connection.setEncoding("utf8");
    connection.setTimeout(CONTROL_CONNECTION_TIMEOUT_MS, rejectConnection);
    connection.once("close", () => { activeConnections--; });
    connection.on("error", () => { rejected = true; });
    connection.on("data", (chunk: string) => {
      if (rejected) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_CONTROL_BUFFER_BYTES) { rejectConnection(); return; }
      // Reject a pipelined second frame before doing any render/validation work.
      if (buffer.indexOf("\n") !== buffer.lastIndexOf("\n")) { rejectConnection(); return; }
      let newline = buffer.indexOf("\n");
      while (!rejected && newline >= 0) {
        // One request per connection prevents an open local socket from
        // becoming an unbounded render/validation work queue.
        if (frameCount++ >= 1) { rejectConnection(); return; }
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n");
        let response: TerminalViewerResponse;
        try {
          const frame = parseControlFrame(line);
          if (frame.op === "set_scene") {
            if (runtime.revision !== 0 || frame.revision !== 1) throw new Error("set_scene is allowed only for the initial revision.");
            if (!isRecord(frame.scene) || frame.scene.type !== "excalidraw") throw new Error("set_scene requires an Excalidraw scene.");
            renderExcalidrawAnsi(frame.scene, renderOptions);
            runtime.scene = frame.scene; runtime.revision = 1; enterTerminal(); render(); response = { ok: true, revision: runtime.revision, requestId: frame.requestId };
          } else if (frame.op === "update") {
            if (!runtime.scene) throw new Error("viewer has no scene.");
            if (frame.revision !== runtime.revision) { response = { ok: false, revision: runtime.revision, error: "stale scene revision.", requestId: frame.requestId }; }
            else {
              if (!isRecord(frame.scene) || frame.scene.type !== "excalidraw") throw new Error("update requires an Excalidraw scene.");
            renderExcalidrawAnsi(frame.scene, renderOptions);
              runtime.scene = frame.scene; runtime.revision++; render(); response = { ok: true, revision: runtime.revision, requestId: frame.requestId };
            }
          } else if (frame.op === "get") response = { ok: true, scene: runtime.scene, revision: runtime.revision, requestId: frame.requestId };
          else if (frame.op === "ping") response = { ok: true, revision: runtime.revision, requestId: frame.requestId };
          else { response = { ok: true, revision: runtime.revision, requestId: frame.requestId }; setImmediate(() => { void close(); }); }
        } catch (error) { response = { ok: false, revision: runtime.revision, error: error instanceof Error ? error.message : "viewer request failed." }; }
        if (frameBytes(response) > MAX_CONTROL_FRAME_BYTES) response = { ok: false, error: "viewer response is too large." };
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
    if ((parent.mode & 0o077) !== 0 || (typeof process.getuid === "function" && parent.uid !== process.getuid())) throw new Error("viewer socket parent must be private to the current user.");
    try { await stat(options.socket); throw new Error("viewer socket already exists; refusing to replace it."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
  if (index !== 2 || !socket || process.argv.length !== 4) throw new Error("usage: excalidraw-terminal-viewer --socket /private/path/viewer.sock");
  await runTerminalViewer({ socket });
}

const invoked = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invoked) main().catch((error) => { process.stderr.write(`terminal viewer: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });

/** Start a local viewer when no Herdr pane is available. */
export async function spawnLocalTerminalViewer(endpoint: TerminalViewerEndpoint): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), "--socket", endpoint.socket], { stdio: "inherit", detached: false });
  child.once("exit", () => { void endpoint.cleanup(); });
  await waitForTerminalViewerSocket(endpoint.socket);
  return child;
}
