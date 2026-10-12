import type { ExtensionAPI, McpServerConfig } from '@earendil-works/pi-coding-agent';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_SITE = 'us3';
const DEFAULT_CLI_PATH = join(homedir(), '.local', 'bin', 'datadog_mcp_cli');
const DEFAULT_ENDPOINT_PATH = 'v1/mcp?toolsets=core,error-tracking,rum';
const DATADOG_SERVER_NAME = 'datadog';
const DATADOG_TOOL_PREFIX = 'mcp__datadog__';
const MUTATING_TOOL_PARTS = /(?:^|_)(add|acknowledge|close|create|delete|disable|edit|enable|modify|mute|remove|resolve|reopen|schedule|set|silence|trigger|unmute|update)(?:_|$)/i;

export interface DatadogConfig {
  cliPath: string;
  site: string;
  endpointPath: string;
}

/** Datadog is opt-in so sessions do not connect to a remote MCP server by default. */
export function isDatadogMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.PI_ENABLE_DATADOG_MCP?.trim() ?? '');
}

/** Resolves the configuration passed to the official Datadog OAuth CLI. */
export function resolveDatadogConfig(env: NodeJS.ProcessEnv = process.env): DatadogConfig {
  return {
    cliPath: env.DD_MCP_CLI?.trim() || DEFAULT_CLI_PATH,
    site: env.DD_MCP_SITE?.trim() || DEFAULT_SITE,
    endpointPath: env.DD_MCP_ENDPOINT_PATH?.trim() || DEFAULT_ENDPOINT_PATH,
  };
}

/** Keep the native server restricted to Datadog's read-only investigation toolsets. */
export function validateDatadogEndpointPath(endpointPath: string): void {
  if (!endpointPath || /[\u0000-\u001f\u007f]/.test(endpointPath) || endpointPath.includes('#')) {
    throw new Error('DD_MCP_ENDPOINT_PATH must be a safe relative MCP path.');
  }
  const separator = endpointPath.indexOf('?');
  const base = separator < 0 ? endpointPath : endpointPath.slice(0, separator);
  if (base !== 'v1/mcp' || endpointPath.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(endpointPath) || endpointPath.startsWith('//')) {
    throw new Error('DD_MCP_ENDPOINT_PATH must be the relative path v1/mcp.');
  }
  const query = separator < 0 ? '' : endpointPath.slice(separator + 1);
  if (/%(?![0-9a-fA-F]{2})/.test(query)) throw new Error('DD_MCP_ENDPOINT_PATH has a malformed query.');
  const params = new URLSearchParams(query);
  const keys = [...params.keys()];
  if (keys.length === 0 || keys.some((key) => key !== 'toolsets') || params.getAll('toolsets').length !== 1) {
    throw new Error('DD_MCP_ENDPOINT_PATH may contain only one toolsets query parameter.');
  }
  const values = params.get('toolsets')!.split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length === 0 || values.some((value) => !new Set(['core', 'error-tracking', 'rum']).has(value))) {
    throw new Error('DD_MCP_ENDPOINT_PATH contains unexpected toolsets; configure only core,error-tracking,rum.');
  }
}

/** Build the Pi-native stdio MCP configuration without starting the CLI. */
export function createDatadogMcpServerConfig(env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  const config = resolveDatadogConfig(env);
  validateDatadogEndpointPath(config.endpointPath);
  return {
    type: 'stdio',
    command: config.cliPath,
    args: ['--site', config.site, '--endpoint-path', config.endpointPath, '--force-oauth'],
    exposure: 'deferred',
    description: 'Read-only Datadog investigation tools for errors, logs, RUM, metrics, traces, and events.',
    toolExposure: {
      '*': 'deferred',
      'create_*': 'hidden',
      'update_*': 'hidden',
      'delete_*': 'hidden',
      'remove_*': 'hidden',
      'mute_*': 'hidden',
      'resolve_*': 'hidden',
      'close_*': 'hidden',
    },
  };
}

/** Native MCP tools remain read-only in Plan mode; mutation-shaped tools are hidden at registration. */
export function isDatadogReadOnlyToolName(toolName: string): boolean {
  return toolName.startsWith(DATADOG_TOOL_PREFIX) && !MUTATING_TOOL_PARTS.test(toolName.slice(DATADOG_TOOL_PREFIX.length));
}

export default function datadogMcpExtension(pi: ExtensionAPI): void {
  if (!isDatadogMcpEnabled()) return;
  pi.registerMcpServer(DATADOG_SERVER_NAME, createDatadogMcpServerConfig());
}
