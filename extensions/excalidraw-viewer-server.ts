import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_VIEWER_PAYLOAD_BYTES = 1_024 * 1_024;
export const MAX_VIEWER_ELEMENTS = 5_000;
const MAX_VIEWER_FILES = 500;
const DEFAULT_STATIC_ROOT = fileURLToPath(new URL("../viewer/dist/", import.meta.url));

export interface ViewerSession {
  readonly token: string;
  readonly url: string;
  readonly port: number;
  readonly server: Server;
  readonly getScene: () => { scene: Record<string, unknown>; revision: number; writable: boolean };
  /** Change whether authenticated browser clients may write the scene. */
  readonly setWritable: (writable: boolean) => void;
  readonly close: () => Promise<void>;
}

interface SceneState {
  scene: Record<string, unknown>;
  revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Validate only the stable envelope. Unknown Excalidraw fields intentionally survive. */
export function validateViewerScene(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("scene must be a JSON object.");
  if (value.type !== "excalidraw") throw new Error("scene.type must be excalidraw.");
  if (!Array.isArray(value.elements)) throw new Error("scene.elements must be an array.");
  if (value.elements.length > MAX_VIEWER_ELEMENTS) throw new Error(`scene.elements is limited to ${MAX_VIEWER_ELEMENTS} items.`);
  if (value.appState !== undefined && !isRecord(value.appState)) throw new Error("scene.appState must be an object.");
  if (value.files !== undefined && !isRecord(value.files)) throw new Error("scene.files must be an object.");
  if (Object.keys(value.files ?? {}).length > MAX_VIEWER_FILES) throw new Error(`scene.files is limited to ${MAX_VIEWER_FILES} items.`);
  for (const element of value.elements) {
    if (!isRecord(element)) throw new Error("scene.elements may contain only objects.");
    if (element.id !== undefined && (typeof element.id !== "string" || element.id.length > 200)) throw new Error("scene element IDs must be short strings.");
  }
  if (jsonBytes(value) > MAX_VIEWER_PAYLOAD_BYTES) throw new Error(`scene exceeds ${MAX_VIEWER_PAYLOAD_BYTES} UTF-8 bytes.`);
  return value;
}

function mergeScene(previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const previousElements = Array.isArray(previous.elements) ? previous.elements : [];
  const nextElements = Array.isArray(next.elements) ? next.elements : [];
  const oldById = new Map(previousElements.filter(isRecord).filter((element) => typeof element.id === "string").map((element) => [element.id as string, element]));
  const elements = nextElements.map((element) => {
    if (!isRecord(element) || typeof element.id !== "string") return element;
    const old = oldById.get(element.id);
    // Excalidraw may add fields over time. Keep fields omitted by an older/newer
    // client rather than silently dropping them during a write-back.
    return old ? { ...old, ...element } : element;
  });
  const files = next.files === undefined
    ? previous.files
    : { ...(isRecord(previous.files) ? previous.files : {}), ...(isRecord(next.files) ? next.files : {}) };
  return { ...previous, ...next, ...(files === undefined ? {} : { files }), elements };
}

function tokenMatches(candidate: string | null, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestToken(request: IncomingMessage, allowQueryToken = false): string | null {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("pi_excalidraw_token="));
  return request.headers.authorization?.replace(/^Bearer\s+/i, "") || cookie?.slice("pi_excalidraw_token=".length) || (allowQueryToken ? url.searchParams.get("token") : null);
}

function send(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(body);
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_VIEWER_PAYLOAD_BYTES) throw Object.assign(new Error("request body is too large."), { statusCode: 413 });
    chunks.push(buffer);
  }
  if (!size) throw Object.assign(new Error("request body is required."), { statusCode: 400 });
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("request body must be valid JSON."), { statusCode: 400 }); }
}

async function serveStatic(response: ServerResponse, requestPath: string, staticRoot: string, token: string): Promise<void> {
  const suffix = requestPath === "/viewer" || requestPath === "/viewer/" ? "index.html" : requestPath.startsWith("/viewer/") ? requestPath.slice("/viewer/".length) : "";
  if (!suffix || suffix.includes("\\") || suffix.split("/").includes("..")) { send(response, 404, { error: "not found" }); return; }
  try {
    const root = await realpath(staticRoot);
    const absolute = await realpath(join(root, suffix));
    const rel = relative(root, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || rel.includes(`..${sep}`)) { send(response, 404, { error: "not found" }); return; }
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error("not a file");
    const headers: Record<string, string> = {
      "Content-Type": contentType(absolute),
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; base-uri 'none'; form-action 'none'",
      "Referrer-Policy": "no-referrer",
    };
    if (suffix === "index.html") headers["Set-Cookie"] = `pi_excalidraw_token=${token}; HttpOnly; SameSite=Strict; Path=/`;
    response.writeHead(200, headers);
    response.end(await readFile(absolute));
  } catch { send(response, 404, { error: "not found" }); }
}

export async function startExcalidrawViewer(initialScene: unknown, options: { staticRoot?: string; writable?: boolean } = {}): Promise<ViewerSession> {
  const scene = validateViewerScene(initialScene);
  const state: SceneState = { scene, revision: 1 };
  // Set the initial policy before the server binds. This closes the small
  // startup window in which a Plan/Review viewer could otherwise accept a PUT.
  let writable = options.writable ?? true;
  let closePromise: Promise<void> | undefined;
  const token = randomBytes(32).toString("hex");
  const staticRoot = options.staticRoot ?? DEFAULT_STATIC_ROOT;
  const entry = await stat(join(staticRoot, "index.html")).catch(() => undefined);
  if (!entry?.isFile()) throw new Error("local Excalidraw viewer bundle is missing index.html; run npm run build:viewer.");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const isInitialViewerRequest = request.method === "GET" && (url.pathname === "/viewer" || url.pathname === "/viewer/");
      if (!tokenMatches(requestToken(request, isInitialViewerRequest), token)) { send(response, 401, { error: "unauthorized" }); return; }
      if (url.pathname === "/api/scene" && request.method === "GET") {
        send(response, 200, { scene: state.scene, revision: state.revision, writable });
        return;
      }
      if (url.pathname === "/api/scene" && request.method === "PUT") {
        if (!writable) { send(response, 403, { error: "viewer is read-only in the current approval mode." }); return; }
        const body = await readBody(request);
        if (!isRecord(body) || !Number.isInteger(body.revision) || !isRecord(body.scene)) { send(response, 422, { error: "body must contain an integer revision and scene object." }); return; }
        if (body.revision !== state.revision) { send(response, 409, { error: "stale scene revision.", revision: state.revision }); return; }
        const next = validateViewerScene(body.scene);
        state.scene = mergeScene(state.scene, next);
        state.revision++;
        send(response, 200, { revision: state.revision });
        return;
      }
      if (request.method === "GET" && (url.pathname === "/viewer" || url.pathname === "/viewer/" || url.pathname.startsWith("/viewer/"))) {
        await serveStatic(response, url.pathname, staticRoot, token);
        return;
      }
      send(response, 404, { error: "not found" });
    } catch (error) {
      const status = typeof error === "object" && error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 422;
      send(response, status, { error: error instanceof Error ? error.message : "request failed" });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { await new Promise<void>((resolve) => server.close(() => resolve())); throw new Error("viewer server did not expose a TCP port."); }
  const port = address.port;
  return {
    token,
    port,
    url: `http://127.0.0.1:${port}/viewer/?token=${encodeURIComponent(token)}`,
    server,
    getScene: () => ({ scene: state.scene, revision: state.revision, writable }),
    setWritable: (value) => { writable = value; },
    close: () => {
      if (closePromise) return closePromise;
      closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      const closeAllConnections = (server as Server & { closeAllConnections?: () => void }).closeAllConnections;
      closeAllConnections?.call(server);
      return closePromise;
    },
  };
}
