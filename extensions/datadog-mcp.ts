import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isMcpForwardingChild,
  registerMcpForwardingProvider,
  requestForwardedMcp,
  unregisterMcpForwardingProvider,
  type ForwardedToolDefinition,
  type ForwardedToolResult,
  type McpForwardingProvider,
} from './mcp-forwarding.ts';

const DEFAULT_SITE = 'us3';
const DEFAULT_CLI_PATH = join(homedir(), '.local', 'bin', 'datadog_mcp_cli');
const DEFAULT_ENDPOINT_PATH = 'v1/mcp?toolsets=core,error-tracking,rum';
const TOOL_PREFIX = 'datadog_';
const SEARCH_TOOL_NAME = 'datadog_search_tools';

let client: Client | undefined;
let connectionPromise: Promise<Client> | undefined;
let discoveryPromise: Promise<number> | undefined;
let toolsDiscovered = false;
const registeredToolNames = new Set<string>();
const remoteTools = new Map<string, McpTool>();
const forwardedTools = new Map<string, ForwardedToolDefinition>();

/**
 * Loads Datadog's official OAuth-backed MCP tools into pi.
 *
 * @param pi - The pi extension API.
 */
export default function datadogMcpExtension(pi: ExtensionAPI): void {
  registerSearchTool(pi);
  const forwardingProvider = createForwardingProvider(pi);
  registerMcpForwardingProvider(forwardingProvider);

  pi.on('session_start', async (_event, ctx) => {
    // A child receives its permitted tools from --tools. Only re-activate the
    // loader when it is available in this process's filtered tool registry.
    if (pi.getAllTools().some((tool) => tool.name === SEARCH_TOOL_NAME)) {
      const activeTools = pi.getActiveTools();
      if (!activeTools.includes(SEARCH_TOOL_NAME)) pi.setActiveTools([...activeTools, SEARCH_TOOL_NAME]);
    }
    ctx.ui.notify('Datadog MCP ready; use datadog_search_tools when Datadog investigation is needed', 'info');
  });

  pi.registerCommand('datadog-connect', {
    description: 'Connect or reconnect the Datadog MCP server using OAuth',
    handler: async (_args, ctx) => {
      try {
        const connectedClient = await connect(ctx);
        const toolCount = await discoverTools(connectedClient, pi);
        ctx.ui.notify(`Datadog MCP connected (${toolCount} searchable tools)`, 'info');
      } catch (error) {
        ctx.ui.notify(formatConnectionError(error), 'error');
      }
    },
  });

  pi.registerCommand('datadog-reset', {
    description: 'Unload active Datadog tools and keep only the Datadog tool searcher',
    handler: async (_args, ctx) => {
      const remoteNames = new Set([...remoteTools.keys(), ...forwardedTools.keys()]);
      const activeTools = pi.getActiveTools().filter((name) => !remoteNames.has(name));
      pi.setActiveTools([...new Set([...activeTools, SEARCH_TOOL_NAME])]);
      ctx.ui.notify('Datadog tools unloaded; datadog_search_tools remains available', 'info');
    },
  });

  pi.on('session_shutdown', async () => {
    const connectedClient = client;
    client = undefined;
    connectionPromise = undefined;
    discoveryPromise = undefined;
    toolsDiscovered = false;
    registeredToolNames.clear();
    remoteTools.clear();
    forwardedTools.clear();
    unregisterMcpForwardingProvider(forwardingProvider);

    if (connectedClient) {
      await connectedClient.close().catch(() => undefined);
    }
  });
}

/**
 * Connects to the official Datadog MCP CLI, which owns the OAuth token storage.
 *
 * @param ctx - The current pi extension context.
 * @returns The connected MCP client.
 * @throws When the CLI is unavailable or OAuth has not been completed.
 */
async function connect(ctx: ExtensionContext): Promise<Client> {
  if (client) return client;
  if (connectionPromise) return connectionPromise;

  connectionPromise = createConnection(ctx);

  try {
    return await connectionPromise;
  } finally {
    connectionPromise = undefined;
  }
}

/**
 * Starts the local Datadog OAuth proxy and performs MCP initialization.
 *
 * @param ctx - The current pi extension context.
 * @returns The initialized MCP client.
 * @throws When the local proxy cannot connect to Datadog.
 */
async function createConnection(ctx: ExtensionContext): Promise<Client> {
  const cliPath = process.env.DD_MCP_CLI ?? DEFAULT_CLI_PATH;
  const site = process.env.DD_MCP_SITE ?? DEFAULT_SITE;
  const endpointPath = process.env.DD_MCP_ENDPOINT_PATH ?? DEFAULT_ENDPOINT_PATH;

  const transport = new StdioClientTransport({
    command: cliPath,
    args: ['--site', site, '--endpoint-path', endpointPath, '--force-oauth'],
    cwd: ctx.cwd,
    stderr: 'pipe',
  });

  const mcpClient = new Client({
    name: 'pi-datadog-mcp',
    version: '0.1.0',
  });

  try {
    await mcpClient.connect(transport);
    client = mcpClient;
    return mcpClient;
  } catch (error) {
    await mcpClient.close().catch(() => undefined);
    throw error;
  }
}

/** Keep only remote tools that were explicitly active before discovery. */
export function keepDiscoveredToolsInactive(
  activeAfterRegistration: readonly string[],
  activeBeforeDiscovery: ReadonlySet<string>,
  discoveredRemoteTools: ReadonlySet<string>,
): string[] {
  return activeAfterRegistration.filter(
    (name) => !discoveredRemoteTools.has(name) || activeBeforeDiscovery.has(name),
  );
}

/**
 * Discovers and registers Datadog tools in pi.
 *
 * @param mcpClient - The connected Datadog MCP client.
 * @param pi - The pi extension API.
 * @returns The number of discovered Datadog tools.
 */
export async function discoverTools(mcpClient: Client, pi: ExtensionAPI): Promise<number> {
  if (toolsDiscovered) return remoteTools.size;
  if (!discoveryPromise) {
    discoveryPromise = discoverToolsOnce(mcpClient, pi).finally(() => {
      discoveryPromise = undefined;
    });
  }
  return discoveryPromise;
}

async function discoverToolsOnce(mcpClient: Client, pi: ExtensionAPI): Promise<number> {
  const result = await mcpClient.listTools();
  const activeBeforeDiscovery = new Set(pi.getActiveTools());

  for (const remoteTool of result.tools) {
    const piToolName = toPiToolName(remoteTool.name);
    remoteTools.set(piToolName, remoteTool);
    registerTool(remoteTool, pi);
  }

  // Pi may activate a newly registered tool by default. Discovery must remain
  // metadata-only until the search loader explicitly selects matching tools.
  const activeAfterRegistration = pi.getActiveTools();
  const lazyActiveTools = keepDiscoveredToolsInactive(activeAfterRegistration, activeBeforeDiscovery, new Set(remoteTools.keys()));
  if (lazyActiveTools.length !== activeAfterRegistration.length) pi.setActiveTools(lazyActiveTools);
  toolsDiscovered = true;

  return result.tools.length;
}

/**
 * Registers the small loader tool that searches Datadog tools on demand.
 *
 * @param pi - The pi extension API.
 */
function registerSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: SEARCH_TOOL_NAME,
    label: 'Datadog: Search Tools',
    description: 'Find and activate only the Datadog MCP tools needed for an investigation.',
    promptSnippet: 'Find Datadog investigation tools on demand',
    promptGuidelines: [
      'Search with a specific capability, such as error tracking, logs, traces, or RUM, before calling an inactive Datadog tool.',
    ],
    parameters: Type.Object({
      query: Type.String({ description: 'The Datadog capability to find, for example "highest impact error tracking issues".' }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: 'Maximum number of matching tools to activate.' })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return searchDatadogTools(params.query, params.limit ?? 5, pi, ctx, signal);
    },
  });
}

/**
 * Finds Datadog tools whose names, descriptions, or schemas match a query.
 *
 * @param query - The requested Datadog capability.
 * @param limit - Maximum number of matches.
 * @returns Matching pi tool names ordered by relevance.
 */
function findToolMatches(query: string, limit: number): string[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  return [...remoteTools.entries()]
    .map(([piToolName, remoteTool]) => {
      const searchableText = [
        remoteTool.name,
        remoteTool.description ?? '',
        JSON.stringify(remoteTool.inputSchema),
      ].join(' ').toLowerCase();
      const score = terms.reduce((total, term) => total + (searchableText.includes(term) ? 1 : 0), 0);
      return { piToolName, score };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.piToolName.localeCompare(right.piToolName))
    .slice(0, limit)
    .map((match) => match.piToolName);
}

/**
 * Registers one Datadog MCP tool as a pi tool.
 *
 * @param remoteTool - The tool definition returned by Datadog.
 * @param mcpClient - The connected Datadog MCP client.
 * @param pi - The pi extension API.
 */
function registerTool(remoteTool: McpTool, pi: ExtensionAPI): void {
  const piToolName = toPiToolName(remoteTool.name);
  if (registeredToolNames.has(piToolName)) return;

  const parameters = Type.Unsafe<Record<string, unknown>>(remoteTool.inputSchema as TSchema);

  pi.registerTool({
    name: piToolName,
    label: `Datadog: ${remoteTool.name}`,
    description: remoteTool.description ?? `Call the Datadog MCP tool ${remoteTool.name}.`,
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return callDatadogTool(remoteTool, params, ctx, signal);
    },
  });
  registeredToolNames.add(piToolName);
}

/**
 * Converts an MCP tool name into a collision-resistant pi tool name.
 *
 * @param remoteName - The original Datadog MCP tool name.
 * @returns A valid pi tool name.
 */
function toPiToolName(remoteName: string): string {
  const normalized = remoteName.replace(/[^a-zA-Z0-9_]/g, '_');
  return `${TOOL_PREFIX}${normalized}`;
}

/**
 * Creates the parent-side Datadog provider exposed to child subagents.
 *
 * @param pi - The parent extension API used to activate matching tools.
 * @returns The forwarding provider.
 */
function createForwardingProvider(pi: ExtensionAPI): McpForwardingProvider {
  return {
    listTools: async (ctx: ExtensionContext): Promise<ForwardedToolDefinition[]> => {
      if (isMcpForwardingChild()) {
        return parseForwardedToolList(await requestForwardedMcp('tools/list'));
      }
      await ensureDatadogToolsDiscovered(pi, ctx);
      return [...remoteTools.keys()].map((name) => toForwardedTool(name));
    },
    searchTools: (query: string, limit: number, ctx: ExtensionContext, signal?: AbortSignal) =>
      isMcpForwardingChild()
        ? requestForwardedMcp('tools/search', { query, limit }, signal).then(parseForwardedSearchResponse)
        : searchForwardedDatadogTools(query, limit, pi, ctx),
    callTool: (name: string, arguments_: Record<string, unknown>, signal: AbortSignal | undefined, ctx: ExtensionContext) =>
      isMcpForwardingChild()
        ? requestForwardedMcp('tools/call', { name, arguments: arguments_ }, signal) as Promise<ForwardedToolResult>
        : callForwardedDatadogTool(name, arguments_, ctx, signal),
  };
}

/**
 * Ensures the parent or local Datadog tool registry has been populated.
 *
 * @param pi - Current extension API.
 * @param ctx - Current extension context.
 * @returns Nothing when discovery has completed.
 */
async function ensureDatadogToolsDiscovered(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (isMcpForwardingChild()) return;
  const connectedClient = await connect(ctx);
  await discoverTools(connectedClient, pi);
}

/**
 * Searches and activates Datadog tools either locally or through the parent bridge.
 *
 * @param query - Search phrase for Datadog capabilities.
 * @param limit - Maximum number of matching tools.
 * @param pi - Current extension API.
 * @param ctx - Current extension context.
 * @returns A standard Pi tool result.
 */
async function searchDatadogTools(
  query: string,
  limit: number,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
) {
  if (isMcpForwardingChild()) {
    const forwarded = parseForwardedSearchResponse(
      await requestForwardedMcp('tools/search', { query, limit }, signal),
    );
    for (const tool of forwarded.matches) {
      forwardedTools.set(tool.name, tool);
      registerForwardedTool(tool, pi);
    }
    const activeTools = pi.getActiveTools();
    const addedTools = forwarded.matches
      .map((tool) => tool.name)
      .filter((name) => !activeTools.includes(name));
    if (addedTools.length > 0) pi.setActiveTools([...activeTools, ...addedTools]);
    return {
      content: [{
        type: 'text' as const,
        text: forwarded.matches.length === 0
          ? `No Datadog tools matched: ${query}`
          : addedTools.length > 0
            ? `Activated Datadog tools through parent: ${addedTools.join(', ')}`
            : `Matching Datadog tools are already active through parent: ${forwarded.matches.map((tool) => tool.name).join(', ')}`,
      }],
      details: { query, matches: forwarded.matches.map((tool) => tool.name), addedTools },
      addedToolNames: addedTools,
    };
  }

  await ensureDatadogToolsDiscovered(pi, ctx);
  const matches = findToolMatches(query, limit);
  const activeTools = pi.getActiveTools();
  const addedTools = matches.filter((name) => !activeTools.includes(name));
  if (addedTools.length > 0) pi.setActiveTools([...activeTools, ...addedTools]);

  return {
    content: [{
      type: 'text' as const,
      text: addedTools.length > 0
        ? `Activated Datadog tools: ${addedTools.join(', ')}`
        : matches.length > 0
          ? `Matching Datadog tools are already active: ${matches.join(', ')}`
          : `No Datadog tools matched: ${query}`,
    }],
    details: { query, matches, addedTools },
    addedToolNames: addedTools,
  };
}

/**
 * Parses a tool list received from the parent bridge.
 *
 * @param value - Untrusted bridge response.
 * @returns Validated forwarded tool definitions.
 * @throws When the response contains an invalid tool definition.
 */
function parseForwardedToolList(value: unknown): ForwardedToolDefinition[] {
  if (!Array.isArray(value) || value.some((tool) => !isForwardedToolDefinition(tool))) {
    throw new Error('MCP forwarding returned an invalid Datadog tool list.');
  }
  return value;
}

/**
 * Parses a search response received from the parent bridge.
 *
 * @param value - Untrusted bridge response.
 * @returns Validated forwarded search result.
 * @throws When the response shape or tool definitions are invalid.
 */
function parseForwardedSearchResponse(value: unknown): {
  matches: ForwardedToolDefinition[];
  addedTools: string[];
} {
  if (!isRecord(value) || !Array.isArray(value.matches) || !Array.isArray(value.addedTools)) {
    throw new Error('MCP forwarding returned an invalid Datadog search response.');
  }
  const matches = value.matches.filter(isForwardedToolDefinition);
  if (
    matches.length !== value.matches.length
    || value.addedTools.some(
      (name) => typeof name !== 'string' || !name.startsWith(TOOL_PREFIX) || name.includes(',') || name === SEARCH_TOOL_NAME,
    )
  ) {
    throw new Error('MCP forwarding returned an invalid Datadog tool definition.');
  }
  return { matches, addedTools: value.addedTools as string[] };
}

/**
 * Checks whether a value is a safe forwarded Datadog tool definition.
 *
 * @param value - Value to inspect.
 * @returns True when the definition has a prefixed name and object schema.
 */
function isForwardedToolDefinition(value: unknown): value is ForwardedToolDefinition {
  return isRecord(value)
    && typeof value.name === 'string'
    && value.name.startsWith(TOOL_PREFIX)
    && !value.name.includes(',')
    && value.name !== SEARCH_TOOL_NAME
    && typeof value.description === 'string'
    && isRecord(value.parameters);
}

/**
 * Checks whether a value is a plain record.
 *
 * @param value - Value to inspect.
 * @returns True when the value is a non-null non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Registers one tool definition received from the parent bridge.
 *
 * @param tool - Forwarded Pi-compatible tool definition.
 * @param pi - Child extension API.
 */
function registerForwardedTool(tool: ForwardedToolDefinition, pi: ExtensionAPI): void {
  if (!isForwardedToolDefinition(tool) || registeredToolNames.has(tool.name)) return;
  registeredToolNames.add(tool.name);
  pi.registerTool({
    name: tool.name,
    label: `Datadog: ${tool.name}`,
    description: tool.description,
    parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters as TSchema),
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal) {
      return requestForwardedMcp('tools/call', { name: tool.name, arguments: params }, signal) as Promise<ForwardedToolResult>;
    },
  });
}

/**
 * Converts a parent-side Datadog tool into a child-safe definition.
 *
 * @param piToolName - Prefixed Pi tool name.
 * @returns Serialized tool metadata safe to send to a child.
 * @throws When the tool is not registered in the parent.
 */
function toForwardedTool(piToolName: string): ForwardedToolDefinition {
  const remoteTool = remoteTools.get(piToolName);
  if (!remoteTool) throw new Error(`Unknown Datadog tool: ${piToolName}`);
  return {
    name: piToolName,
    description: remoteTool.description ?? `Call the Datadog MCP tool ${remoteTool.name}.`,
    parameters: remoteTool.inputSchema as Record<string, unknown>,
  };
}

/**
 * Searches parent-side Datadog tools and activates matching tools in the parent.
 *
 * @param query - Search phrase for Datadog capabilities.
 * @param limit - Maximum number of matches.
 * @param pi - Parent extension API.
 * @param ctx - Parent extension context.
 * @returns Matching definitions and newly activated tool names.
 */
async function searchForwardedDatadogTools(
  query: string,
  limit: number,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<{ matches: ForwardedToolDefinition[]; addedTools: string[] }> {
  await ensureDatadogToolsDiscovered(pi, ctx);
  const matches = findToolMatches(query, limit).map((name) => toForwardedTool(name));
  return { matches, addedTools: [] };
}

/**
 * Calls one parent-side Datadog MCP tool and serializes its output for Pi.
 *
 * @param name - Prefixed Pi tool name.
 * @param arguments_ - Tool arguments.
 * @param ctx - Parent extension context.
 * @returns Serialized tool result.
 * @throws When the tool is unknown or the MCP call fails.
 */
async function callForwardedDatadogTool(
  name: string,
  arguments_: Record<string, unknown>,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<ForwardedToolResult> {
  const remoteTool = remoteTools.get(name);
  if (!remoteTool) throw new Error(`Unknown Datadog tool: ${name}`);
  return callDatadogTool(remoteTool, arguments_, ctx, signal);
}

/**
 * Calls a Datadog MCP tool and formats its result consistently for parent and child Pi.
 *
 * @param remoteTool - Datadog MCP tool definition.
 * @param arguments_ - Tool arguments.
 * @param ctx - Extension context.
 * @returns Serialized tool result.
 */
async function callDatadogTool(
  remoteTool: McpTool,
  arguments_: Record<string, unknown>,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined = undefined,
): Promise<ForwardedToolResult> {
  const activeClient = await connect(ctx);
  const result = await activeClient.callTool(
    { name: remoteTool.name, arguments: arguments_ },
    undefined,
    signal ? { signal } : undefined,
  );
  const output = JSON.stringify(result, null, 2) ?? String(result);
  const truncated = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (result.isError === true) {
    throw new Error(`Datadog MCP tool failed: ${truncated.content}`);
  }
  return {
    content: [{
      type: 'text',
      text: truncated.truncated
        ? `${truncated.content}\n\n[Datadog output truncated: ${truncated.totalBytes} bytes, ${truncated.totalLines} lines]`
        : truncated.content,
    }],
    details: {
      remoteTool: remoteTool.name,
      truncated: truncated.truncated,
      isError: result.isError === true,
    },
    isError: result.isError === true,
  };
}

/**
 * Formats a helpful connection failure without exposing credentials.
 *
 * @param error - The caught connection error.
 * @returns A user-facing error message.
 */
function formatConnectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Datadog MCP unavailable. Run '${DEFAULT_CLI_PATH} --site us3 login' in a terminal, then run /datadog-connect. (${message})`;
}
