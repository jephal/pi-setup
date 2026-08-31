import assert from "node:assert/strict";
import test from "node:test";
import { discoverTools, keepDiscoveredToolsInactive } from "./datadog-mcp.ts";

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
});
