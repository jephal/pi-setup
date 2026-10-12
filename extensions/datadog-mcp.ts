import type { ExtensionAPI, McpServerConfig } from '@earendil-works/pi-coding-agent';

const DEFAULT_SITE = 'us3';
const DEFAULT_ENDPOINT_PATH = '/api/unstable/mcp-server/mcp?toolsets=core,error-tracking,rum';
const DATADOG_SERVER_NAME = 'datadog';
const DATADOG_TOOL_PREFIX = 'mcp__datadog__';
const DATADOG_SITE_HOSTS: Readonly<Record<string, string>> = {
  us1: 'mcp.datadoghq.com',
  eu1: 'mcp.datadoghq.eu',
  us3: 'mcp.us3.datadoghq.com',
  us5: 'mcp.us5.datadoghq.com',
  ap1: 'mcp.ap1.datadoghq.com',
  ap2: 'mcp.ap2.datadoghq.com',
};
const MUTATING_TOOL_PARTS = /(?:^|_)(add|acknowledge|close|create|delete|disable|edit|enable|modify|mute|remove|resolve|reopen|schedule|set|silence|trigger|unmute|update)(?:_|$)/i;

export interface DatadogConfig {
  site: string;
  endpointPath: string;
}

/** Datadog is opt-in so sessions do not connect to a remote MCP server by default. */
export function isDatadogMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.PI_ENABLE_DATADOG_MCP?.trim() ?? '');
}

/** Resolves the hosted Datadog MCP configuration. */
export function resolveDatadogConfig(env: NodeJS.ProcessEnv = process.env): DatadogConfig {
  return {
    site: env.DD_MCP_SITE?.trim().toLowerCase() || DEFAULT_SITE,
    endpointPath: env.DD_MCP_ENDPOINT_PATH?.trim() || DEFAULT_ENDPOINT_PATH,
  };
}

/** Keep the hosted server on Datadog's read-only investigation toolsets. */
export function validateDatadogEndpointPath(endpointPath: string): void {
  if (!endpointPath || /[\u0000-\u001f\u007f]/.test(endpointPath) || endpointPath.includes('#')) {
    throw new Error('DD_MCP_ENDPOINT_PATH must be a safe relative MCP path.');
  }
  const parsed = new URL(endpointPath, 'https://datadog-mcp.invalid');
  if (parsed.origin !== 'https://datadog-mcp.invalid' || parsed.pathname !== '/api/unstable/mcp-server/mcp') {
    throw new Error('DD_MCP_ENDPOINT_PATH must be /api/unstable/mcp-server/mcp.');
  }
  const keys = [...parsed.searchParams.keys()];
  if (keys.some((key) => key !== 'toolsets') || parsed.searchParams.getAll('toolsets').length > 1) {
    throw new Error('DD_MCP_ENDPOINT_PATH may contain only one toolsets query parameter.');
  }
  const toolsets = parsed.searchParams.get('toolsets');
  if (!toolsets) return;
  const values = toolsets.split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length === 0 || values.some((value) => !new Set(['core', 'error-tracking', 'rum']).has(value))) {
    throw new Error('DD_MCP_ENDPOINT_PATH contains unexpected toolsets; configure only core,error-tracking,rum.');
  }
}

export function datadogMcpEndpoint(site: string, endpointPath: string): string {
  const host = DATADOG_SITE_HOSTS[site.trim().toLowerCase()];
  if (!host) {
    throw new Error(`DD_MCP_SITE is unsupported by the hosted Datadog MCP server: ${site}. Use us1, eu1, us3, us5, ap1, or ap2.`);
  }
  validateDatadogEndpointPath(endpointPath);
  return `https://${host}${endpointPath}`;
}

/** Build the Pi-native hosted HTTP MCP configuration without a local helper process. */
export function createDatadogMcpServerConfig(env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  const config = resolveDatadogConfig(env);
  return {
    type: 'http',
    url: datadogMcpEndpoint(config.site, config.endpointPath),
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
