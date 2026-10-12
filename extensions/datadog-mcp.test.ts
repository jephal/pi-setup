import assert from "node:assert/strict";
import test from "node:test";
import {
  createDatadogMcpServerConfig,
  datadogMcpEndpoint,
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

test("hosted Datadog configuration resolves site and endpoint path", () => {
  assert.deepEqual(resolveDatadogConfig({
    DD_MCP_SITE: " US3 ",
    DD_MCP_ENDPOINT_PATH: " /api/unstable/mcp-server/mcp?toolsets=core ",
  } as NodeJS.ProcessEnv), {
    site: "us3",
    endpointPath: "/api/unstable/mcp-server/mcp?toolsets=core",
  });
});

test("hosted Datadog endpoint validation rejects broader or unsafe paths", () => {
  validateDatadogEndpointPath("/api/unstable/mcp-server/mcp?toolsets=core,error-tracking,rum");
  validateDatadogEndpointPath("/api/unstable/mcp-server/mcp");
  assert.throws(() => validateDatadogEndpointPath("/v1/mcp?toolsets=core"), /api\/unstable/i);
  assert.throws(() => validateDatadogEndpointPath("https://example.test/api/unstable/mcp-server/mcp"));
  assert.throws(() => validateDatadogEndpointPath("/api/unstable/mcp-server/mcp?toolsets=all"), /unexpected.*toolsets/i);
  assert.throws(() => validateDatadogEndpointPath("/api/unstable/mcp-server/mcp?toolsets=core&other=value"));
});

test("hosted endpoint maps supported Datadog sites to regional MCP servers", () => {
  assert.equal(
    datadogMcpEndpoint("us3", "/api/unstable/mcp-server/mcp?toolsets=core"),
    "https://mcp.us3.datadoghq.com/api/unstable/mcp-server/mcp?toolsets=core",
  );
  assert.equal(
    datadogMcpEndpoint("eu1", "/api/unstable/mcp-server/mcp"),
    "https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp",
  );
  assert.throws(() => datadogMcpEndpoint("gov", "/api/unstable/mcp-server/mcp"), /unsupported/i);
});

test("native Datadog MCP configuration uses hosted OAuth and deferred read-only exposure", () => {
  const config = createDatadogMcpServerConfig({
    DD_MCP_SITE: "us5",
    DD_MCP_ENDPOINT_PATH: "/api/unstable/mcp-server/mcp?toolsets=core,error-tracking,rum",
  } as NodeJS.ProcessEnv);
  assert.equal(config.type, "http");
  assert.equal(config.url, "https://mcp.us5.datadoghq.com/api/unstable/mcp-server/mcp?toolsets=core,error-tracking,rum");
  assert.equal(config.exposure, "deferred");
  assert.equal(config.toolExposure?.["create_*"], "hidden");
  assert.equal((config as any).command, undefined);
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

test("native registration passes the hosted HTTP config to Pi", () => {
  const previous = process.env.PI_ENABLE_DATADOG_MCP;
  process.env.PI_ENABLE_DATADOG_MCP = "1";
  const registrations: unknown[][] = [];
  datadogMcpExtension({ registerMcpServer: (...args: unknown[]) => registrations.push(args) } as any);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0][0], "datadog");
  assert.equal((registrations[0][1] as any).type, "http");
  assert.match((registrations[0][1] as any).url, /^https:\/\/mcp\.us3\.datadoghq\.com\//);
  if (previous === undefined) delete process.env.PI_ENABLE_DATADOG_MCP;
  else process.env.PI_ENABLE_DATADOG_MCP = previous;
});

test("native Datadog tool names reject mutation-shaped operations in read-only modes", () => {
  assert.equal(isDatadogReadOnlyToolName("mcp__datadog__logs"), true);
  assert.equal(isDatadogReadOnlyToolName("mcp__datadog__error_tracking"), true);
  assert.equal(isDatadogReadOnlyToolName("mcp__datadog__create_monitor"), false);
  assert.equal(isDatadogReadOnlyToolName("mcp__other__logs"), false);
});
