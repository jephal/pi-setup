import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverTools,
  formatConnectionError,
  keepDiscoveredToolsInactive,
  resolveDatadogConfig,
  default as datadogMcpExtension,
  setDatadogClientForTesting,
  validateDatadogEndpointPath,
} from "./datadog-mcp.ts";
import { getMcpForwardingProvider } from "./mcp-forwarding.ts";

test("Datadog configuration resolves one effective set of safe values", () => {
  assert.deepEqual(resolveDatadogConfig({ DD_MCP_CLI: " /tmp/datadog cli ", DD_MCP_SITE: " eu1 ", DD_MCP_ENDPOINT_PATH: " v1/mcp?toolsets=core " } as any), {
    cliPath: "/tmp/datadog cli",
    site: "eu1",
    endpointPath: "v1/mcp?toolsets=core",
  });
});

test("Datadog endpoint validation rejects broader or implicit toolsets", () => {
  validateDatadogEndpointPath("v1/mcp?toolsets=core,error-tracking,rum");
  assert.throws(() => validateDatadogEndpointPath("v1/mcp?toolsets=all"), /unexpected.*toolsets/i);
  assert.throws(() => validateDatadogEndpointPath("v1/mcp"), /toolsets/i);
  for (const unsafe of [
    "https://example.test/v1/mcp?toolsets=core",
    "v1/other?toolsets=core",
    "v1/mcp?toolsets=core&admin=true",
    "v1/mcp?toolsets=core#fragment",
    "v1/mcp?toolsets=core%ZZ",
  ]) assert.throws(() => validateDatadogEndpointPath(unsafe));
});

test("Datadog connection errors quote paths and redact credential-shaped values", () => {
  const message = formatConnectionError(new Error([
    "Authorization: Bearer bearer-secret",
    "Basic basic-secret",
    "access_token=url-secret",
    '{"password":"json-secret"}',
    "Cookie: session=cookie-secret",
    "access_token%3Dencoded-secret",
    "refresh_token=newline-secret\nnext-line",
  ].join(" ")), {
    cliPath: "/tmp/O'Reilly/datadog cli\nunsafe",
    site: "us3\runsafe",
    endpointPath: "https://user:password@example.test/v1/mcp?token=secret",
  });
  assert.match(message, /'\\''/);
  for (const secret of ["bearer-secret", "basic-secret", "url-secret", "json-secret", "cookie-secret", "encoded-secret", "newline-secret", "password@example"]) {
    assert.doesNotMatch(message, new RegExp(secret));
  }
  assert.doesNotMatch(message, /[\r\n\u0000-\u001f]/);
});

test("Datadog discovery does not activate every newly registered remote tool", () => {
  const remaining = keepDiscoveredToolsInactive(
    ["read", "datadog_search_tools", "datadog_logs", "datadog_error_tracking"],
    new Set(["read", "datadog_search_tools"]),
    new Set(["datadog_logs", "datadog_error_tracking"]),
  );
  assert.deepEqual(remaining, ["read", "datadog_search_tools"]);
});

test("Datadog discovery preserves an explicitly active known remote tool", () => {
  const remaining = keepDiscoveredToolsInactive(
    ["datadog_logs", "datadog_error_tracking"],
    new Set(["datadog_logs"]),
    new Set(["datadog_logs", "datadog_error_tracking"]),
  );
  assert.deepEqual(remaining, ["datadog_logs"]);
});

test("concurrent Datadog discovery shares one MCP list request", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const listed = new Promise<void>((resolve) => { release = resolve; });
  const client = {
    async listTools() {
      calls++;
      await listed;
      return { tools: [{ name: "logs", description: "Search logs", inputSchema: { type: "object" } }] };
    },
  };
  setDatadogClientForTesting(client as any);
  let activeTools = ["read", "datadog_search_tools"];
  const pi = {
    getActiveTools: () => activeTools,
    setActiveTools: (next: string[]) => { activeTools = next; },
    registerTool() {},
  };

  const first = discoverTools(client as any, pi as any);
  const second = discoverTools(client as any, pi as any);
  release!();
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.equal(calls, 1);
  setDatadogClientForTesting(undefined);
});

test("Datadog session start replaces a pending lifecycle before the next client is used", async () => {
  let release!: () => void;
  let closeCalls = 0;
  const oldClient = {
    async listTools() {
      await new Promise<void>((resolve) => { release = resolve; });
      return { tools: [{ name: "old_tool", description: "old", inputSchema: { type: "object" } }] };
    },
    async close() { closeCalls++; release?.(); },
  };
  const newClient = {
    async listTools() { return { tools: [{ name: "new_tool", description: "new", inputSchema: { type: "object" } }] }; },
    async close() { /* test seam */ },
  };
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  const definitions: any[] = [];
  let activeTools = ["datadog_search_tools"];
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => handlers.set(event, handler),
    registerTool: (definition: any) => definitions.push(definition),
    registerCommand: () => undefined,
    getAllTools: () => definitions,
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => { activeTools = names; },
  };
  const ctx = { cwd: process.cwd(), ui: { notify: () => undefined } };
  setDatadogClientForTesting(oldClient as any);
  datadogMcpExtension(pi as any);
  const pendingDiscovery = discoverTools(oldClient as any, pi as any);
  const starting = handlers.get("session_start")!(undefined, ctx);
  await starting;
  await assert.rejects(pendingDiscovery, /superseded|shut down/i);
  assert.equal(closeCalls, 1);

  setDatadogClientForTesting(newClient as any);
  assert.equal(await discoverTools(newClient as any, pi as any), 1);
  assert.equal(definitions.filter((definition) => definition.name === "datadog_new_tool").length, 1);
  setDatadogClientForTesting(undefined);
});

test("Datadog forwarding provider is restored after session replacement", async () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  const definitions: any[] = [];
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => handlers.set(event, handler),
    registerTool: (definition: any) => definitions.push(definition),
    registerCommand: () => undefined,
    getAllTools: () => definitions,
    getActiveTools: () => ["datadog_search_tools"],
    setActiveTools: () => undefined,
  };
  const ctx = { ui: { notify: () => undefined } };

  datadogMcpExtension(pi as any);
  assert.ok(getMcpForwardingProvider());
  await handlers.get("session_shutdown")!(undefined, ctx);
  assert.equal(getMcpForwardingProvider(), undefined);
  await handlers.get("session_start")!(undefined, ctx);
  assert.ok(getMcpForwardingProvider());
  await handlers.get("session_shutdown")!(undefined, ctx);
  assert.equal(getMcpForwardingProvider(), undefined);
});

test("Datadog discovery rejects results from a client invalidated while listing", async () => {
  let release!: () => void;
  const listed = new Promise<void>((resolve) => { release = resolve; });
  const oldClient = {
    async listTools() {
      await listed;
      return { tools: [{ name: "old_tool", description: "old", inputSchema: { type: "object" } }] };
    },
  };
  const newClient = { async listTools() { return { tools: [] }; } };
  const definitions: any[] = [];
  const pi = {
    getActiveTools: () => ["read", "datadog_old_tool"],
    setActiveTools: () => undefined,
    registerTool: (definition: any) => definitions.push(definition),
  };
  setDatadogClientForTesting(oldClient as any);
  const pending = discoverTools(oldClient as any, pi as any);
  setDatadogClientForTesting(newClient as any);
  release();
  await assert.rejects(pending, /superseded|shut down/i);
  assert.equal(definitions.length, 0);
  setDatadogClientForTesting(undefined);
});

test("Datadog schema refresh reuses one Pi tool and resolves the current client by name", async () => {
  const definitions: any[] = [];
  const pi = {
    getActiveTools: () => ["read"],
    setActiveTools: () => undefined,
    registerTool: (definition: any) => definitions.push(definition),
  };
  const oldClient = {
    async listTools() { return { tools: [{ name: "logs", description: "old schema", inputSchema: { type: "object", properties: { old: { type: "string" } } } }] }; },
    async close() { /* test seam */ },
  };
  let calls = 0;
  const newClient = {
    async listTools() { return { tools: [{ name: "logs", description: "new schema", inputSchema: { type: "object", properties: { fresh: { type: "boolean" } } } }] }; },
    async callTool() { calls++; return { content: [{ type: "text", text: "current" }], details: {} }; },
  };
  setDatadogClientForTesting(oldClient as any);
  await discoverTools(oldClient as any, pi as any);
  setDatadogClientForTesting(newClient as any);
  await discoverTools(newClient as any, pi as any);
  assert.equal(definitions.filter((definition) => definition.name === "datadog_logs").length, 1);
  await definitions.find((definition) => definition.name === "datadog_logs").execute("call", {}, new AbortController().signal, undefined, {});
  assert.equal(calls, 1);
  setDatadogClientForTesting(undefined);
  await assert.rejects(
    definitions.find((definition) => definition.name === "datadog_logs").execute("call", {}, new AbortController().signal, undefined, {}),
    /unavailable|connected/i,
  );
});

test("Datadog tool calls reject a late result from an invalidated client", async () => {
  let release!: () => void;
  const callResult = new Promise<any>((resolve) => { release = () => resolve({ content: [{ type: "text", text: "stale" }] }); });
  const fakeClient = {
    async listTools() { return { tools: [{ name: "logs", description: "logs", inputSchema: { type: "object" } }] }; },
    async callTool() { return callResult; },
  };
  const definitions: any[] = [];
  const pi = {
    getActiveTools: () => ["read"],
    setActiveTools: () => undefined,
    registerTool: (definition: any) => definitions.push(definition),
  };
  setDatadogClientForTesting(fakeClient as any);
  await discoverTools(fakeClient as any, pi as any);
  const pending = definitions[0].execute("call", {}, new AbortController().signal, undefined, {});
  setDatadogClientForTesting(undefined);
  release();
  await assert.rejects(pending, /superseded|shut down/i);
});
