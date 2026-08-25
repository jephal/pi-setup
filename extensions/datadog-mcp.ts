import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_SITE = 'us3';
const DEFAULT_CLI_PATH = join(homedir(), '.local', 'bin', 'datadog_mcp_cli');
const DEFAULT_ENDPOINT_PATH = 'v1/mcp?toolsets=core,error-tracking,rum';
const TOOL_PREFIX = 'datadog_';
const SEARCH_TOOL_NAME = 'datadog_search_tools';

let client: Client | undefined;
let connectionPromise: Promise<Client> | undefined;
let toolsDiscovered = false;
const registeredToolNames = new Set<string>();
const remoteTools = new Map<string, McpTool>();

/**
 * Loads Datadog's official OAuth-backed MCP tools into pi.
 *
 * @param pi - The pi extension API.
 */
export default function datadogMcpExtension(pi: ExtensionAPI): void {
  registerSearchTool(pi);

  pi.on('session_start', async (_event, ctx) => {
    const activeTools = pi.getActiveTools();
    if (!activeTools.includes(SEARCH_TOOL_NAME)) {
      pi.setActiveTools([...activeTools, SEARCH_TOOL_NAME]);
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
      const remoteNames = new Set(remoteTools.keys());
      const activeTools = pi.getActiveTools().filter((name) => !remoteNames.has(name));
      pi.setActiveTools([...new Set([...activeTools, SEARCH_TOOL_NAME])]);
      ctx.ui.notify('Datadog tools unloaded; datadog_search_tools remains available', 'info');
    },
  });

  pi.on('session_shutdown', async () => {
    const connectedClient = client;
    client = undefined;
    connectionPromise = undefined;
    toolsDiscovered = false;
    registeredToolNames.clear();
    remoteTools.clear();

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

/**
 * Discovers and registers Datadog tools in pi.
 *
 * @param mcpClient - The connected Datadog MCP client.
 * @param pi - The pi extension API.
 * @returns The number of discovered Datadog tools.
 */
async function discoverTools(mcpClient: Client, pi: ExtensionAPI): Promise<number> {
  if (toolsDiscovered) return remoteTools.size;

  const result = await mcpClient.listTools();
  toolsDiscovered = true;

  for (const remoteTool of result.tools) {
    const piToolName = toPiToolName(remoteTool.name);
    remoteTools.set(piToolName, remoteTool);
    registerTool(remoteTool, pi);
  }

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
    description: 'Search the available Datadog MCP tools and activate only the tools needed for the current investigation.',
    promptSnippet: 'Search and activate Datadog tools only when a Datadog investigation is needed',
    promptGuidelines: [
      'Use datadog_search_tools before using Datadog MCP tools when the required Datadog capability is not already active.',
      'Prefer datadog_search_tools with a specific capability such as error tracking, logs, traces, or RUM rather than loading every Datadog tool.',
    ],
    parameters: Type.Object({
      query: Type.String({ description: 'The Datadog capability to find, for example "highest impact error tracking issues".' }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: 'Maximum number of matching tools to activate.' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const connectedClient = await connect(ctx);
      await discoverTools(connectedClient, pi);

      const matches = findToolMatches(params.query, params.limit ?? 5);
      if (matches.length === 0) {
        return {
          content: [{ type: 'text', text: `No Datadog tools matched: ${params.query}` }],
          details: { query: params.query, matches: [] },
        };
      }

      const activeTools = pi.getActiveTools();
      const addedTools = matches.filter((name) => !activeTools.includes(name));
      pi.setActiveTools([...new Set([...activeTools, ...addedTools])]);

      return {
        content: [{
          type: 'text',
          text: addedTools.length > 0
            ? `Activated Datadog tools: ${addedTools.join(', ')}`
            : `Matching Datadog tools are already active: ${matches.join(', ')}`,
        }],
        details: { query: params.query, matches, addedTools },
      };
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

  registeredToolNames.add(piToolName);
  const parameters = Type.Unsafe<Record<string, unknown>>(remoteTool.inputSchema as TSchema);

  pi.registerTool({
    name: piToolName,
    label: `Datadog: ${remoteTool.name}`,
    description: remoteTool.description ?? `Call the Datadog MCP tool ${remoteTool.name}.`,
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const activeClient = await connect(ctx);
      const result = await activeClient.callTool({
        name: remoteTool.name,
        arguments: params,
      });

      const output = JSON.stringify(result, null, 2) ?? String(result);
      const truncated = truncateHead(output, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });

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
      };
    },
  });
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
 * Formats a helpful connection failure without exposing credentials.
 *
 * @param error - The caught connection error.
 * @returns A user-facing error message.
 */
function formatConnectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Datadog MCP unavailable. Run '${DEFAULT_CLI_PATH} --site us3 login' in a terminal, then run /datadog-connect. (${message})`;
}
