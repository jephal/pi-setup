import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { access } from "node:fs/promises";
import test from "node:test";
import { createMcpForwardingBridge, parseForwardingResponse, type McpForwardingProvider } from "./mcp-forwarding.ts";

const ctx = { cwd: process.cwd() } as any;
const tool = { name: "datadog_logs", description: "Search logs", parameters: { type: "object" } };

function readFrame(socket: ReturnType<typeof createConnection>, payload: string): Promise<any> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const timer = setTimeout(() => reject(new Error("test frame timed out")), 2_000);
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			clearTimeout(timer);
			resolve(JSON.parse(buffer.slice(0, newline)));
			socket.destroy();
		});
		socket.once("error", reject);
	});
}

function connectAndWrite(path: string, frame: string): Promise<any> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		socket.once("error", reject);
		socket.once("connect", () => {
			void readFrame(socket, frame).then(resolve, reject);
			socket.write(frame);
		});
	});
}

test("forwarding bridge rejects cancellation during initial tool listing", async () => {
	let release!: () => void;
	const listed = new Promise<any[]>((resolve) => { release = () => resolve([tool]); });
	const provider = { listTools: async () => listed } as unknown as McpForwardingProvider;
	const controller = new AbortController();
	const pending = createMcpForwardingBridge(provider, ctx, controller.signal);
	controller.abort();
	await assert.rejects(pending, /aborted/);
	release();
});

test("forwarding bridge abort after listening closes the socket directory and is idempotent", async () => {
  const provider = { listTools: async () => [tool] } as unknown as McpForwardingProvider;
  const controller = new AbortController();
  const bridge = await createMcpForwardingBridge(provider, ctx, controller.signal);
  const socketPath = bridge.env.PI_MCP_FORWARD_SOCKET;
  controller.abort();
  for (let i = 0; i < 100; i++) {
    try {
      await access(socketPath);
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await assert.rejects(access(socketPath), /ENOENT/);
  await bridge.close();
  await bridge.close();
});

test("forwarding bridge outlives caller cancellation but closes with its session", async () => {
	const caller = new AbortController();
	const session = new AbortController();
	const provider = { listTools: async () => [tool] } as unknown as McpForwardingProvider;
	const bridge = await createMcpForwardingBridge(provider, ctx, caller.signal, session.signal);
	const socketPath = bridge.env.PI_MCP_FORWARD_SOCKET;
	caller.abort();
	await access(socketPath);
	session.abort();
	for (let i = 0; i < 100; i++) {
		try {
			await access(socketPath);
		} catch {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	await assert.rejects(access(socketPath), /ENOENT/);
	await bridge.close();
});

test("forwarding bridge does not answer a request after provider cancellation", async () => {
  let release!: () => void;
  const pending = new Promise<any>((resolve) => { release = () => resolve(undefined); });
  let providerSignal: AbortSignal | undefined;
  const provider = {
    listTools: async () => [tool],
    searchTools: async () => ({ matches: [tool], addedTools: [] }),
    callTool: async (_name: string, _args: Record<string, unknown>, signal?: AbortSignal) => {
      providerSignal = signal;
      await pending;
      return { content: [{ type: "text" as const, text: "late" }], details: {} };
    },
  } as McpForwardingProvider;
  const controller = new AbortController();
  const bridge = await createMcpForwardingBridge(provider, ctx, controller.signal);
  const socket = createConnection(bridge.env.PI_MCP_FORWARD_SOCKET);
  try {
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(`${JSON.stringify({ id: "call-1", token: bridge.env.PI_MCP_FORWARD_TOKEN, method: "tools/call", params: { name: tool.name, arguments: {} } })}\n`);
    for (let i = 0; i < 100 && !providerSignal; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    assert.equal(providerSignal?.aborted, true);
  } finally {
    release();
    socket.destroy();
    await bridge.close();
  }
});

test("forwarding client validates null and non-record response envelopes", () => {
	for (const response of ["null", "[]", '"not-an-envelope"']) {
		assert.throws(() => parseForwardingResponse(response, "request-1"), /invalid response/i);
	}
});

test("forwarding client preserves normal parent rejection responses", () => {
	const response = parseForwardingResponse(JSON.stringify({ id: "request-1", error: "parent rejected this request" }), "request-1");
	assert.equal(response.error, "parent rejected this request");
});

test("forwarding bridge rejects malformed and oversized request frames", async () => {
	const provider = {
		listTools: async () => [tool],
		searchTools: async () => ({ matches: [tool], addedTools: [] }),
		callTool: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
	} as McpForwardingProvider;
	const bridge = await createMcpForwardingBridge(provider, ctx, undefined);
	try {
		const malformed = await connectAndWrite(bridge.env.PI_MCP_FORWARD_SOCKET, "not-json\n");
		assert.match(malformed.error, /malformed/i);

		await new Promise<void>((resolve, reject) => {
			const socket = createConnection(bridge.env.PI_MCP_FORWARD_SOCKET);
			const timer = setTimeout(() => reject(new Error("oversized frame was not closed")), 2_000);
			socket.once("error", () => undefined);
			socket.once("close", () => { clearTimeout(timer); resolve(); });
			socket.once("connect", () => socket.write("x".repeat(2 * 1024 * 1024 + 1)));
		});
	} finally {
		await bridge.close();
	}
});
