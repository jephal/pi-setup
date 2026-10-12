import assert from "node:assert/strict";
import test from "node:test";
import {
  createDatadogMcpServerConfig,
  isDatadogMcpEnabled,
  isDatadogReadOnlyToolName,
  resolveDatadogConfig,
  validateDatadogEndpointPath,
  default as datadogMcpExtension,
} from "./datadog-mcp.ts";

test("Datadog is disabled unless explicitly enabled", () => {
  assert.equal(isDatadogMcpEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(isDatadogMcpEnabled({ PI_ENABLE_DATADOG_MCP: "0" } as NodeJS.ProcessEnv), false);
  assert.equal(isDatadogMcpEnabled({ PI_ENABLE_DATADOG_MCP: "true" } as NodeJS.ProcessEnv), true);
  assert.equal(isDatadogMcpEnabled({ PI_ENABLE_DATADOG_MCP: "on" } as NodeJS.ProcessEnv), true);
});

test("Datadog configuration resolves safe CLI values", () => {
  assert.deepEqual(resolveDatadogConfig({
    DD_MCP_CLI: " /tmp/datadog cli ",
    DD_MCP_SITE: " eu1 ",
    DD_MCP_ENDPOINT_PATH: " v1/mcp?toolsets=core ",
  } as NodeJS.ProcessEnv), {
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
    "/v1/mcp?toolsets=core",
    "https://example.test/v1/mcp?toolsets=core",
    "v1/mcp?toolsets=core#token",
    "v1/mcp?toolsets=core%",
  ]) assert.throws(() => validateDatadogEndpointPath(unsafe));
});

test("native Datadog MCP configuration uses deferred read-only exposure", () => {
  const config = createDatadogMcpServerConfig({
    DD_MCP_CLI: "/tmp/datadog_mcp_cli",
    DD_MCP_SITE: "us5",
    DD_MCP_ENDPOINT_PATH: "v1/mcp?toolsets=core,error-tracking,rum",
  } as NodeJS.ProcessEnv);
  assert.equal(config.type, "stdio");
  assert.equal(config.command, "/tmp/datadog_mcp_cli");
  assert.deepEqual(config.args, ["--site", "us5", "--endpoint-path", "v1/mcp?toolsets=core,error-tracking,rum", "--force-oauth"]);
  assert.equal(config.exposure, "deferred");
  assert.equal(config.toolExposure?.["create_*"], "hidden");
});

test("native registration is opt-in and does not connect while disabled", () => {
  const previous = process.env.PI_ENABLE_DATADOG_MCP;
  delete process.env.PI_ENABLE_DATADOG_MCP;
  const registrations: unknown[] = [];
  datadogMcpExtension({ registerMcpServer: (...args: unknown[]) => registrations.push(args) } as any);
  assert.deepEqual(registrations, []);
  if (previous === undefined) delete process.env.PI_ENABLE_DATADOG_MCP;
  else process.env.PI_ENABLE_DATADOG_MCP = previous;
});

test("native registration passes the CLI config to Pi", () => {
  const previous = process.env.PI_ENABLE_DATADOG_MCP;
  process.env.PI_ENABLE_DATADOG_MCP = "1";
  const registrations: unknown[][] = [];
  datadogMcpExtension({ registerMcpServer: (...args: unknown[]) => registrations.push(args) } as any);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0][0], "datadog");
  assert.equal((registrations[0][1] as any).exposure, "deferred");
  if (previous === undefined) delete process.env.PI_ENABLE_DATADOG_MCP;
  else process.env.PI_ENABLE_DATADOG_MCP = previous;
});

test("native Datadog tool names reject mutation-shaped operations in read-only modes", () => {
  assert.equal(isDatadogReadOnlyToolName("mcp__datadog__logs"), true);
  assert.equal(isDatadogReadOnlyToolName("mcp__datadog__error_tracking"), true);
  assert.equal(isDatadogReadOnlyToolName("mcp__datadog__create_monitor"), false);
  assert.equal(isDatadogReadOnlyToolName("mcp__other__logs"), false);
});
