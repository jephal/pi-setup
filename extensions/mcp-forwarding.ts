import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdtemp, rmdir, unlink } from 'node:fs/promises';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

const SOCKET_ENV = 'PI_MCP_FORWARD_SOCKET';
const TOKEN_ENV = 'PI_MCP_FORWARD_TOKEN';
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const BRIDGE_CLOSE_TIMEOUT_MS = 2_000;

type ForwardRequestMethod = 'tools/list' | 'tools/search' | 'tools/call';

interface ForwardRequest {
  id: string;
  token: string;
  method: ForwardRequestMethod;
  params?: Record<string, unknown>;
}

interface ForwardResponse {
  id: string;
  result?: unknown;
  error?: string;
}

/** A Pi-compatible MCP tool definition sent across the child bridge. */
export interface ForwardedToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A serialized Datadog tool result returned to a child Pi process. */
export interface ForwardedToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: unknown;
  isError?: boolean;
}

/** Parent-side provider implementation exposed to child subagent bridges. */
export interface McpForwardingProvider {
  listTools(ctx: ExtensionContext): Promise<ForwardedToolDefinition[]>;
  searchTools(
    query: string,
    limit: number,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<{ matches: ForwardedToolDefinition[]; addedTools: string[] }>;
  callTool(
    name: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ForwardedToolResult>;
}

/** Per-child bridge environment and lifecycle handle. */
export interface McpForwardingBridge {
  env: Record<string, string>;
  toolNames: string[];
  close(): Promise<void>;
}

const forwardingState = globalThis as typeof globalThis & {
  __piSetupMcpForwardingProvider?: McpForwardingProvider;
};

/**
 * Registers the parent-side MCP provider used by child subagent bridges.
 *
 * @param provider - Provider that exposes allowlisted MCP tool metadata and calls.
 */
export function registerMcpForwardingProvider(provider: McpForwardingProvider): void {
  forwardingState.__piSetupMcpForwardingProvider = provider;
}

/**
 * Unregisters a provider without removing a newer provider from another session.
 *
 * @param provider - Provider that should be removed.
 */
export function unregisterMcpForwardingProvider(provider: McpForwardingProvider): void {
  if (forwardingState.__piSetupMcpForwardingProvider === provider) {
    delete forwardingState.__piSetupMcpForwardingProvider;
  }
}

/**
 * Returns the currently registered MCP forwarding provider, if any.
 *
 * @returns The active forwarding provider.
 */
export function getMcpForwardingProvider(): McpForwardingProvider | undefined {
  return forwardingState.__piSetupMcpForwardingProvider;
}

/**
 * Checks whether the current process is a child using a parent MCP bridge.
 *
 * @returns True when the forwarding socket and token are configured.
 */
export function isMcpForwardingChild(): boolean {
  return Boolean(process.env[SOCKET_ENV] && process.env[TOKEN_ENV]);
}

/**
 * Sends one request from a child process to its parent MCP bridge.
 *
 * @param method - Forwarding operation to perform.
 * @param params - Operation parameters.
 * @param signal - Optional cancellation signal for the child request.
 * @returns The parent response payload.
 * @throws When the bridge is unavailable, times out, rejects the request, or returns invalid data.
 */
export async function requestForwardedMcp(
  method: ForwardRequestMethod,
  params: Record<string, unknown> = {},
  signal: AbortSignal | undefined = undefined,
): Promise<unknown> {
  const socketPath = process.env[SOCKET_ENV];
  const token = process.env[TOKEN_ENV];
  if (!socketPath || !token) {
    throw new Error('MCP forwarding is not configured for this process.');
  }

  const request: ForwardRequest = {
    id: randomUUID(),
    token,
    method,
    params,
  };

  if (signal?.aborted) {
    return Promise.reject(new Error(`MCP forwarding request aborted: ${method}`));
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    let settled = false;
    let abortListener: (() => void) | undefined;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      socket.destroy();
      callback();
    };

    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`MCP forwarding request timed out: ${method}`)));
    }, REQUEST_TIMEOUT_MS);

    abortListener = () => finish(() => reject(new Error(`MCP forwarding request aborted: ${method}`)));
    if (signal?.aborted) {
      abortListener();
      return;
    }
    signal?.addEventListener('abort', abortListener, { once: true });

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
        finish(() => reject(new Error('MCP forwarding response exceeded the maximum frame size.')));
        return;
      }

      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      let response: ForwardResponse;
      try {
        response = JSON.parse(line) as ForwardResponse;
      } catch {
        finish(() => reject(new Error('MCP forwarding returned invalid JSON.')));
        return;
      }

      if (response.id !== request.id) {
        finish(() => reject(new Error('MCP forwarding returned a mismatched request ID.')));
        return;
      }
      if (response.error) {
        finish(() => reject(new Error(response.error)));
        return;
      }
      finish(() => resolve(response.result));
    });
    socket.on('error', (error) => {
      finish(() => reject(new Error(`MCP forwarding connection failed: ${error.message}`)));
    });
    socket.on('close', () => {
      if (!settled) finish(() => reject(new Error('MCP forwarding connection closed unexpectedly.')));
    });
  });
}

/**
 * Creates a private Unix-socket MCP bridge for one child process.
 *
 * @param provider - Parent-side MCP provider.
 * @param ctx - Parent extension context used for forwarded calls.
 * @param signal - Parent cancellation signal.
 * @returns Bridge environment variables and cleanup function.
 * @throws When the private socket cannot be created.
 */
export async function createMcpForwardingBridge(
  provider: McpForwardingProvider,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<McpForwardingBridge> {
  const forwardedTools = await provider.listTools(ctx);
  const allowedToolNames = new Set(forwardedTools.map((tool) => tool.name));
  const bridgeDir = await mkdtemp(join(tmpdir(), 'pi-mcp-forward-'));
  try {
    await chmod(bridgeDir, 0o700);
  } catch (error) {
    await rmdir(bridgeDir).catch(() => undefined);
    throw error;
  }
  const socketPath = join(bridgeDir, 'bridge.sock');
  const token = randomUUID();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    handleConnection(socket, token, provider, ctx, signal, allowedToolNames);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.on('error', () => undefined);
      server.once('listening', onListening);
      server.listen(socketPath);
    });
  } catch (error) {
    await unlink(socketPath).catch(() => undefined);
    await rmdir(bridgeDir).catch(() => undefined);
    throw error;
  }

  const abort = (): void => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) void server.close();
  };
  signal?.addEventListener('abort', abort, { once: true });

  return {
    env: {
      [SOCKET_ENV]: socketPath,
      [TOKEN_ENV]: token,
    },
    toolNames: [...allowedToolNames],
    async close(): Promise<void> {
      signal?.removeEventListener('abort', abort);
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      await unlink(socketPath).catch(() => undefined);
      await rmdir(bridgeDir).catch(() => undefined);
    },
  };
}

/**
 * Closes a bridge server without allowing orphaned connections to block cleanup.
 *
 * @param server - Bridge server to close.
 * @returns Resolves after the server closes or the cleanup timeout expires.
 */
async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await Promise.race([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, BRIDGE_CLOSE_TIMEOUT_MS)),
  ]);
}

/**
 * Handles newline-delimited requests from one child connection.
 *
 * @param socket - Child bridge connection.
 * @param token - Expected per-child capability token.
 * @param provider - Parent-side MCP provider.
 * @param ctx - Parent extension context.
 */
function handleConnection(
  socket: Socket,
  token: string,
  provider: McpForwardingProvider,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  allowedToolNames: ReadonlySet<string>,
): void {
  let buffer = '';
  socket.setEncoding('utf8');

  const connectionController = new AbortController();
  const abortConnection = (): void => {
    connectionController.abort();
    socket.destroy();
  };
  signal?.addEventListener('abort', abortConnection, { once: true });
  socket.once('close', () => {
    connectionController.abort();
    signal?.removeEventListener('abort', abortConnection);
  });
  if (signal?.aborted) abortConnection();

  socket.on('error', () => {
    socket.destroy();
  });
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
      socket.destroy();
      return;
    }

    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void handleRequest(socket, line, token, provider, ctx, connectionController.signal, allowedToolNames).catch(() => {
        socket.destroy();
      });
    }
  });
}

/**
 * Executes one validated request and writes its response.
 *
 * @param socket - Child bridge connection.
 * @param line - Serialized request line.
 * @param token - Expected per-child capability token.
 * @param provider - Parent-side MCP provider.
 * @param ctx - Parent extension context.
 * @param signal - Child-connection cancellation signal.
 * @param allowedToolNames - Tool names authorized for this child.
 */
async function handleRequest(
  socket: Socket,
  line: string,
  token: string,
  provider: McpForwardingProvider,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  allowedToolNames: ReadonlySet<string>,
): Promise<void> {
  let requestId = 'unknown';
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || typeof parsed.id !== 'string' || typeof parsed.token !== 'string') {
      writeResponse(socket, { id: 'unknown', error: 'MCP forwarding request was malformed.' });
      return;
    }
    const request = parsed as unknown as ForwardRequest;
    requestId = request.id;

    if (request.token !== token) {
      writeResponse(socket, { id: request.id, error: 'MCP forwarding authorization failed.' });
      return;
    }

    const params = request.params ?? {};
    let result: unknown;
    if (request.method === 'tools/list') {
      result = (await provider.listTools(ctx)).filter((tool) => allowedToolNames.has(tool.name));
    } else if (request.method === 'tools/search') {
      const query = typeof params.query === 'string' ? params.query : '';
      const limit = typeof params.limit === 'number' ? params.limit : 5;
      const searchResult = await provider.searchTools(query, limit, ctx, signal);
      result = {
        matches: searchResult.matches.filter((tool) => allowedToolNames.has(tool.name)),
        addedTools: searchResult.addedTools.filter((name) => allowedToolNames.has(name)),
      };
    } else if (request.method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      if (!allowedToolNames.has(name)) throw new Error(`MCP tool is not authorized for this child: ${name}`);
      const arguments_ = isRecord(params.arguments) ? params.arguments : {};
      result = await provider.callTool(name, arguments_, signal, ctx);
    } else {
      throw new Error(`Unsupported MCP forwarding method: ${request.method}`);
    }
    writeResponse(socket, { id: request.id, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeResponse(socket, { id: requestId, error: message });
  }
}

/**
 * Writes one response frame to the child.
 *
 * @param socket - Child bridge connection.
 * @param response - Response to serialize.
 */
function writeResponse(socket: Socket, response: ForwardResponse): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
}

/**
 * Checks whether a value is a plain record suitable for MCP arguments.
 *
 * @param value - Value to inspect.
 * @returns True when the value is a non-null object that is not an array.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
