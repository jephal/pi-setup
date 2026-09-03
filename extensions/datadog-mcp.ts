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
const READ_ONLY_TOOLSETS = new Set(['core', 'error-tracking', 'rum']);
const TOOL_PREFIX = 'datadog_';
const SEARCH_TOOL_NAME = 'datadog_search_tools';

export interface DatadogConfig {
  cliPath: string;
  site: string;
  endpointPath: string;
}

let client: Client | undefined;
let connectionPromise: Promise<Client> | undefined;
let reconnectOperation: { epoch: number; promise: Promise<Client> } | undefined;
let discoveryPromise: Promise<number> | undefined;
let discoveryPromiseClient: Client | undefined;
let discoveryClient: Client | undefined;
let toolsDiscovered = false;
let lifecycleGeneration = 0;
let sessionEpoch = 0;
let lifecycleAbortController = new AbortController();
let sessionShuttingDown = false;
let activePi: ExtensionAPI | undefined;
const registeredToolNames = new WeakMap<object, Set<string>>();
const remoteTools = new Map<string, McpTool>();
const forwardedTools = new Map<string, ForwardedToolDefinition>();

/** Resolves the one effective Datadog configuration used by connection and errors. */
export function resolveDatadogConfig(env: NodeJS.ProcessEnv = process.env): DatadogConfig {
  return {
    cliPath: env.DD_MCP_CLI?.trim() || DEFAULT_CLI_PATH,
    site: env.DD_MCP_SITE?.trim() || DEFAULT_SITE,
    endpointPath: env.DD_MCP_ENDPOINT_PATH?.trim() || DEFAULT_ENDPOINT_PATH,
  };
}

/** Rejects endpoint configurations that do not explicitly select the read-only toolsets. */
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
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    throw new Error('DD_MCP_ENDPOINT_PATH has a malformed query.');
  }
  const keys = [...params.keys()];
  if (keys.length === 0 || keys.some((key) => key !== 'toolsets') || params.getAll('toolsets').length !== 1) {
    throw new Error('DD_MCP_ENDPOINT_PATH may contain only one toolsets query parameter.');
  }
  const values = params.get('toolsets')!.split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length === 0 || values.some((value) => !READ_ONLY_TOOLSETS.has(value))) {
    throw new Error('DD_MCP_ENDPOINT_PATH contains unexpected toolsets; configure only core,error-tracking,rum.');
  }
}

function shellQuote(value: string): string {
  return `'${sanitizeDisplay(value).replace(/'/g, `'\\''`)}'`;
}

function sanitizeDisplay(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '?');
}

function redactConnectionMessage(value: string): string {
  return sanitizeDisplay(value)
    .replace(/(Bearer\s+|Basic\s+)[^\s,;)]+/gi, '$1[redacted]')
    .replace(/(authorization\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;)]+)/gi, '$1[redacted]')
    .replace(/((?:["']?(?:access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|secret|api[_ -]?key|credential)["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key)%3[dD])[^&\s]+/gi, '$1[redacted]')
    .replace(/([?&](?:api[_-]?key|token|key|code|credential)[^=]*=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(Cookie\s*:\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-token]');
}

function safeEndpointPath(endpointPath: string): string {
  try {
    validateDatadogEndpointPath(endpointPath);
    const params = new URLSearchParams(endpointPath.slice(endpointPath.indexOf('?') + 1));
    const values = params.get('toolsets')!.split(',').map((item) => item.trim()).filter(Boolean);
    return `v1/mcp?toolsets=${values.join(',')}`;
  } catch {
    return '[redacted endpoint]';
  }
}

function staleLifecycleError(): Error {
  return new Error('Datadog MCP connection was superseded or shut down.');
}

async function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw staleLifecycleError();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(staleLifecycleError());
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

function isCurrentLifecycle(generation: number, expectedClient?: Client): boolean {
  return generation === lifecycleGeneration
    && !lifecycleAbortController.signal.aborted
    && (expectedClient === undefined || client === expectedClient);
}

/** Installs an explicit client seam for lifecycle/discovery regression tests. */
export function setDatadogClientForTesting(testClient: Client | undefined): void {
  sessionEpoch++;
  sessionShuttingDown = false;
  lifecycleGeneration++;
  lifecycleAbortController.abort();
  lifecycleAbortController = new AbortController();
  client = testClient;
  connectionPromise = undefined;
  reconnectOperation = undefined;
  resetDiscoveryState();
}

/**
 * Loads Datadog's official OAuth-backed MCP tools into pi.
 *
 * @param pi - The pi extension API.
 */
export default function datadogMcpExtension(pi: ExtensionAPI): void {
  activePi = pi;
  registerSearchTool(pi);
  const forwardingProvider = createForwardingProvider(pi);
  registerMcpForwardingProvider(forwardingProvider);

  pi.on('session_start', async (_event, ctx) => {
    // A session can be restored in the same extension process. Do not let the
    // previous session's client, discovery, or in-flight connection leak into
    // the new one.
    await teardownDatadogLifecycle(pi);
    sessionShuttingDown = false;
    lifecycleAbortController = new AbortController();
    // Shutdown unregisters the provider. Re-register the same provider for a
    // session restored in this extension process.
    registerMcpForwardingProvider(forwardingProvider);
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
        const connectedClient = await reconnect(ctx, pi);
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
    await teardownDatadogLifecycle(pi);
    unregisterMcpForwardingProvider(forwardingProvider);
  });
}

/**
 * Stops every operation and client belonging to the current Datadog lifecycle.
 *
 * This deliberately clears the shared references before awaiting anything. Any
 * completion that races the teardown therefore fails its generation/client
 * guard instead of publishing state into the next session.
 */
async function teardownDatadogLifecycle(pi: ExtensionAPI): Promise<void> {
  sessionShuttingDown = true;
  sessionEpoch++;
  lifecycleGeneration++;
  lifecycleAbortController.abort();

  const operations = new Set<Promise<unknown>>();
  if (connectionPromise) operations.add(connectionPromise);
  if (discoveryPromise) operations.add(discoveryPromise);
  if (reconnectOperation?.promise) operations.add(reconnectOperation.promise);
  const clients = new Set<Client>(pendingClients);
  if (client) clients.add(client);

  client = undefined;
  connectionPromise = undefined;
  discoveryPromise = undefined;
  discoveryPromiseClient = undefined;
  reconnectOperation = undefined;
  resetDiscoveryState(pi);

  // Closing before awaiting is important for transports whose connect/list
  // operation only resolves after the client is closed.
  const closeClients = async (values: Iterable<Client>): Promise<void> => {
    await Promise.all([...values].map((connectedClient) => connectedClient.close().catch(() => undefined)));
  };
  await Promise.all([
    closeClients(clients),
    ...[...operations].map((operation) => operation.catch(() => undefined)),
  ]);

  // A pending connect can construct a client just before observing the
  // generation change. Drain that final set as well before the new lifecycle
  // gets a usable abort controller.
  await closeClients(new Set<Client>(pendingClients));
  await Promise.all([...operations].map((operation) => operation.catch(() => undefined)));
}

function resetDiscoveryState(pi: ExtensionAPI | undefined = activePi): void {
  const staleNames = new Set([...remoteTools.keys(), ...forwardedTools.keys()]);
  if (pi && staleNames.size > 0) {
    pi.setActiveTools(pi.getActiveTools().filter((name) => !staleNames.has(name)));
  }
  toolsDiscovered = false;
  discoveryPromiseClient = undefined;
  discoveryClient = undefined;
  remoteTools.clear();
  forwardedTools.clear();
}

async function invalidateDatadogConnection(pi: ExtensionAPI): Promise<void> {
  lifecycleAbortController.abort();
  lifecycleGeneration++;
  const operations = new Set<Promise<unknown>>();
  if (connectionPromise) operations.add(connectionPromise);
  if (discoveryPromise) operations.add(discoveryPromise);
  const clients = new Set<Client>(pendingClients);
  if (client) clients.add(client);
  client = undefined;
  connectionPromise = undefined;
  discoveryPromise = undefined;
  resetDiscoveryState(pi);
  await Promise.all([
    Promise.all([...clients].map((connectedClient) => connectedClient.close().catch(() => undefined))),
    ...[...operations].map((operation) => operation.catch(() => undefined)),
  ]);
  await Promise.all([...pendingClients].map((connectedClient) => connectedClient.close().catch(() => undefined)));
}

/** Connects to Datadog without reusing a client from an earlier lifecycle. */
async function reconnect(ctx: ExtensionContext, pi: ExtensionAPI): Promise<Client> {
  if (sessionShuttingDown) throw new Error('Datadog MCP session is shutting down.');
  if (reconnectOperation) return reconnectOperation.promise;
  const epoch = sessionEpoch;
  const pending = (async () => {
    await invalidateDatadogConnection(pi);
    if (sessionShuttingDown || epoch !== sessionEpoch) throw staleLifecycleError();
    lifecycleAbortController = new AbortController();
    return connect(ctx, true, epoch);
  })();
  reconnectOperation = { epoch, promise: pending };
  try {
    return await pending;
  } finally {
    if (reconnectOperation?.promise === pending) reconnectOperation = undefined;
  }
}

/**
 * Connects to the official Datadog MCP CLI, which owns the OAuth token storage.
 *
 * @param ctx - The current pi extension context.
 * @returns The connected MCP client.
 * @throws When the CLI is unavailable or OAuth has not been completed.
 */
async function connect(ctx: ExtensionContext, allowReconnect = false, expectedSessionEpoch = sessionEpoch): Promise<Client> {
  if (sessionShuttingDown || expectedSessionEpoch !== sessionEpoch) throw staleLifecycleError();
  if (!allowReconnect && reconnectOperation) {
    await reconnectOperation.promise;
    if (sessionShuttingDown || expectedSessionEpoch !== sessionEpoch) throw staleLifecycleError();
    if (client) return client;
  }
  if (client) return client;
  if (connectionPromise) return connectionPromise;

  const generation = lifecycleGeneration;
  const signal = lifecycleAbortController.signal;
  const pending = createConnection(ctx, generation, signal, expectedSessionEpoch);
  connectionPromise = pending;
  try {
    return await pending;
  } finally {
    if (connectionPromise === pending) connectionPromise = undefined;
  }
}

const pendingClients = new Set<Client>();

function handleClientClosed(closedClient: Client, generation: number): void {
  if (client !== closedClient || generation !== lifecycleGeneration) return;
  client = undefined;
  lifecycleAbortController.abort();
  lifecycleGeneration++;
  resetDiscoveryState();
  lifecycleAbortController = new AbortController();
}

/** Starts the local Datadog OAuth proxy and performs MCP initialization. */
async function createConnection(ctx: ExtensionContext, generation: number, signal: AbortSignal, expectedSessionEpoch: number): Promise<Client> {
  const config = resolveDatadogConfig();
  validateDatadogEndpointPath(config.endpointPath);
  const transport = new StdioClientTransport({
    command: config.cliPath,
    args: ['--site', config.site, '--endpoint-path', config.endpointPath, '--force-oauth'],
    cwd: ctx.cwd,
    stderr: 'pipe',
  });
  const mcpClient = new Client({ name: 'pi-datadog-mcp', version: '0.1.0' });
  let accepted = false;
  mcpClient.onclose = () => {
    if (accepted) handleClientClosed(mcpClient, generation);
  };
  pendingClients.add(mcpClient);
  try {
    await mcpClient.connect(transport);
    accepted = true;
    if (!isCurrentLifecycle(generation) || signal.aborted || expectedSessionEpoch !== sessionEpoch || sessionShuttingDown) {
      await mcpClient.close().catch(() => undefined);
      throw staleLifecycleError();
    }
    client = mcpClient;
    return mcpClient;
  } catch (error) {
    await mcpClient.close().catch(() => undefined);
    throw error;
  } finally {
    pendingClients.delete(mcpClient);
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
export async function discoverTools(mcpClient: Client, pi: ExtensionAPI, operationSignal?: AbortSignal): Promise<number> {
  if (sessionShuttingDown || client !== mcpClient || operationSignal?.aborted) throw staleLifecycleError();
  if (toolsDiscovered && discoveryClient === mcpClient) return remoteTools.size;
  if (discoveryPromise && discoveryPromiseClient === mcpClient) return operationSignal
    ? waitForSignal(discoveryPromise, operationSignal)
    : discoveryPromise;
  const generation = lifecycleGeneration;
  const signal = operationSignal
    ? AbortSignal.any([lifecycleAbortController.signal, operationSignal])
    : lifecycleAbortController.signal;
  const pending = discoverToolsOnce(mcpClient, pi, generation, signal);
  discoveryPromise = pending;
  discoveryPromiseClient = mcpClient;
  try {
    return await pending;
  } finally {
    if (discoveryPromise === pending) {
      discoveryPromise = undefined;
      discoveryPromiseClient = undefined;
    }
  }
}

async function discoverToolsOnce(
  mcpClient: Client,
  pi: ExtensionAPI,
  generation: number,
  signal: AbortSignal,
): Promise<number> {
  const result = await mcpClient.listTools(undefined, { signal });
  // A reconnect or shutdown may complete while listTools was in flight. Never
  // publish definitions from that old client into the new registry.
  if (!isCurrentLifecycle(generation, mcpClient) || signal.aborted) throw staleLifecycleError();
  const previousRemoteNames = new Set(remoteTools.keys());
  const activeBeforeDiscovery = new Set(pi.getActiveTools().filter((name) => !previousRemoteNames.has(name)));
  if (previousRemoteNames.size > 0) pi.setActiveTools([...activeBeforeDiscovery]);

  for (const remoteTool of result.tools) {
    if (!isCurrentLifecycle(generation, mcpClient) || signal.aborted) throw staleLifecycleError();
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
  discoveryClient = mcpClient;

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
 * @param pi - The pi extension API.
 */
function registerTool(remoteTool: McpTool, pi: ExtensionAPI): void {
  const piToolName = toPiToolName(remoteTool.name);
  // Pi does not expose tool removal. Register each name once per Pi API and
  // resolve the current remote definition at execution time so reconnects
  // cannot retain a stale client or leave duplicate registrations behind.
  const registeredNames = getRegisteredToolNames(pi);
  if (registeredNames.has(piToolName)) return;

  const parameters = Type.Unsafe<Record<string, unknown>>(remoteTool.inputSchema as TSchema);

  pi.registerTool({
    name: piToolName,
    label: `Datadog: ${remoteTool.name}`,
    description: remoteTool.description ?? `Call the Datadog MCP tool ${remoteTool.name}.`,
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      return callDatadogToolByName(piToolName, params, signal);
    },
  });
  registeredNames.add(piToolName);
}

function getRegisteredToolNames(pi: ExtensionAPI): Set<string> {
  let names = registeredToolNames.get(pi);
  if (!names) {
    names = new Set<string>();
    registeredToolNames.set(pi, names);
  }
  return names;
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
    listTools: async (ctx: ExtensionContext, signal?: AbortSignal): Promise<ForwardedToolDefinition[]> => {
      if (isMcpForwardingChild()) {
        return parseForwardedToolList(await requestForwardedMcp('tools/list', {}, signal));
      }
      await ensureDatadogToolsDiscovered(pi, ctx, signal);
      if (signal?.aborted) throw staleLifecycleError();
      return [...remoteTools.keys()].map((name) => toForwardedTool(name));
    },
    searchTools: (query: string, limit: number, ctx: ExtensionContext, signal?: AbortSignal) =>
      isMcpForwardingChild()
        ? requestForwardedMcp('tools/search', { query, limit }, signal).then(parseForwardedSearchResponse)
        : searchForwardedDatadogTools(query, limit, pi, ctx, signal),
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
async function ensureDatadogToolsDiscovered(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
  if (isMcpForwardingChild()) return;
  const connecting = connect(ctx);
  const connectedClient = signal ? await waitForSignal(connecting, signal) : await connecting;
  await discoverTools(connectedClient, pi, signal);
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
    if (signal?.aborted) throw staleLifecycleError();
    for (const tool of forwarded.matches) {
      if (signal?.aborted) throw staleLifecycleError();
      forwardedTools.set(tool.name, tool);
      registerForwardedTool(tool, pi);
    }
    if (signal?.aborted) throw staleLifecycleError();
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

  await ensureDatadogToolsDiscovered(pi, ctx, signal);
  if (signal?.aborted) throw staleLifecycleError();
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
  if (!isForwardedToolDefinition(tool)) return;
  const registeredNames = getRegisteredToolNames(pi);
  if (registeredNames.has(tool.name)) return;
  registeredNames.add(tool.name);
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
  signal?: AbortSignal,
): Promise<{ matches: ForwardedToolDefinition[]; addedTools: string[] }> {
  await ensureDatadogToolsDiscovered(pi, ctx, signal);
  if (signal?.aborted) throw staleLifecycleError();
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
  _ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<ForwardedToolResult> {
  return callDatadogToolByName(name, arguments_, signal);
}

async function callDatadogToolByName(
  piToolName: string,
  arguments_: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<ForwardedToolResult> {
  const remoteTool = remoteTools.get(piToolName);
  if (!remoteTool) throw new Error(`Datadog tool is unavailable in the current discovery: ${piToolName}`);
  const activeClient = client;
  if (!activeClient) throw new Error('Datadog MCP is not connected. Run /datadog-connect first.');
  const generation = lifecycleGeneration;
  return callDatadogTool(activeClient, remoteTool, arguments_, signal, generation);
}

/**
 * Calls a Datadog MCP tool and formats its result consistently for parent and child Pi.
 *
 * @param remoteTool - Datadog MCP tool definition.
 * @param arguments_ - Tool arguments.
 * @returns Serialized tool result.
 */
async function callDatadogTool(
  activeClient: Client,
  remoteTool: McpTool,
  arguments_: Record<string, unknown>,
  signal: AbortSignal | undefined = undefined,
  generation = lifecycleGeneration,
): Promise<ForwardedToolResult> {
  const callSignal = signal
    ? AbortSignal.any([signal, lifecycleAbortController.signal])
    : lifecycleAbortController.signal;
  const result = await activeClient.callTool(
    { name: remoteTool.name, arguments: arguments_ },
    undefined,
    { signal: callSignal },
  );
  if (!isCurrentLifecycle(generation, activeClient)) throw staleLifecycleError();
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
export function formatConnectionError(error: unknown, config: DatadogConfig = resolveDatadogConfig()): string {
  const message = redactConnectionMessage(error instanceof Error ? error.message : String(error));
  return `Datadog MCP unavailable. Run ${shellQuote(config.cliPath)} --site ${shellQuote(config.site)} login in a terminal, then run /datadog-connect. Endpoint: ${safeEndpointPath(config.endpointPath)}. (${message})`;
}
