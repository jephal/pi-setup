import { callscript, tool, type ScriptTool } from "callscript";
import { Value } from "typebox/value";
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
	assertContainedPath,
	createRepoSearchToolDefinition,
	executableExists,
	MAX_GREP_CONTEXT,
	MAX_SEARCH_RESULTS,
	requireExistingExecutable,
	routeRepoSearch,
	validateRepoSearchInput,
} from "./repo-search.ts";
import {
	MAX_NESTED_RESULT_BYTES,
	MAX_PROGRAM_RESULT_BYTES,
	assertPiProgramCapabilityAllowed,
	isPiProgramCapabilityAllowed,
	PI_PROGRAM_CAPABILITY_NAMES,
	boundCapabilityText,
	compactCapabilityResult,
	normalizeCapabilityResult,
	type HostCapability,
} from "./capabilities.ts";
import { createDatadogCapabilities, createFoveaCapabilities, createMemoryReadCapabilities, createNotesReadCapabilities } from "./capability-adapters.ts";

export { executableExists } from "./repo-search.ts";
export const boundText = boundCapabilityText;
export const compactToolResult = compactCapabilityResult;

/** Explicit CallScript registry. Namespaces make the host policy auditable. */
export const PI_PROGRAM_CAPABILITIES = PI_PROGRAM_CAPABILITY_NAMES;

const ABORTED = "Operation aborted";
const MAX_READ_LINES = 2_000;
const PROGRAM_LIMITS = {
	maxSteps: 20,
	maxItemsPerStep: 25,
	maxTotalCalls: 50,
	maxExprNodes: 100_000,
	maxConcurrency: 5,
	maxCallResultBytes: MAX_NESTED_RESULT_BYTES,
	maxSuspendAttempts: 5,
} as const;

type PiBuiltinDefinition = HostCapability;

// Result helpers are re-exported above for existing consumers.

function compactProgramResult(result: { status: string; output?: unknown; at?: string; error?: { message?: string }; issues?: string[]; suspensions?: unknown[] }): string {
	let text: string;
	if (result.status === "ok") text = compactToolResult(result.output);
	else if (result.status === "invalid") text = `Invalid program: ${result.issues?.join("; ") || "validation failed"}`;
	else if (result.status === "suspended") text = `Program suspended: ${result.suspensions?.length ?? 0} pending action(s)`;
	else text = `Program error${result.at ? ` at ${result.at}` : ""}: ${result.error?.message || "execution failed"}`;
	return boundCapabilityText(text, MAX_PROGRAM_RESULT_BYTES);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error(ABORTED);
}

function asBuiltinDefinition(name: string, value: unknown): PiBuiltinDefinition {
	const definition = value as {
		description: string;
		parameters: Record<string, unknown>;
		execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext): Promise<unknown>;
	};
	return {
		name,
		description: definition.description,
		access: "read-only",
		parameters: definition.parameters,
		execute: (args, ctx, signal) => definition.execute(`${name}:nested`, args, signal, undefined, ctx),
	};
}

function formatSchemaIssues(schema: Record<string, unknown>, args: unknown): string {
	const issues = [...Value.Errors(schema as any, args)].slice(0, 5).map((issue) => `${issue.path || "args"} ${issue.message}`);
	return issues.join("; ") || "schema validation failed";
}

function validateNestedArgs(name: string, schema: Record<string, unknown>, args: unknown): void {
	if (!Value.Check(schema as any, args)) {
		throw new Error(`Invalid arguments for ${name}: ${formatSchemaIssues(schema, args)}`);
	}
}

function validateNestedBounds(name: string, args: unknown): void {
	const input = args as Record<string, unknown>;
	const limit = input.limit;
	const offset = input.offset;
	const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
	if (name === "repo.search") {
		validateRepoSearchInput(args as any);
		return;
	}
	if (name === "repo.read") {
		if (limit !== undefined && (!isInteger(limit) || limit < 1 || limit > MAX_READ_LINES)) {
			throw new Error(`Arguments for ${name} require an integer limit from 1 to ${MAX_READ_LINES}`);
		}
		if (offset !== undefined && (!isInteger(offset) || offset < 1)) {
			throw new Error(`Arguments for ${name} require a positive integer offset`);
		}
		return;
	}
	if ((name === "repo.find" || name === "repo.grep") && limit !== undefined
		&& (!isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS)) {
		throw new Error(`Arguments for ${name} exceed the result limit or require an integer from 1 to ${MAX_SEARCH_RESULTS}`);
	}
	if (name === "repo.grep" && input.context !== undefined
		&& (!isInteger(input.context) || input.context < 0 || input.context > MAX_GREP_CONTEXT)) {
		throw new Error(`Arguments for ${name} exceed the context limit or require an integer from 0 to ${MAX_GREP_CONTEXT}`);
	}
}

function mountBuiltin(
	name: (typeof PI_PROGRAM_CAPABILITIES)[number],
	definition: PiBuiltinDefinition,
	outerSignal: AbortSignal | undefined,
	ctx: ExtensionContext,
	options: { pathArg?: string; requiredExecutable?: string | ((args: unknown) => string) } = {},
): ScriptTool {
	return tool({
		name,
		description: definition.description,
		inputSchema: definition.parameters,
		async execute(args: unknown): Promise<string> {
			// CallScript dispatch is deliberately below Pi's tool event pipeline.
			// Its inputSchema is descriptive, so validate before calling Pi directly.
			validateNestedArgs(name, definition.parameters, args);
			validateNestedBounds(name, args);
			throwIfAborted(outerSignal);
			const operationSignal = outerSignal ?? ctx.signal;
			if (options.pathArg) {
				const input = args as Record<string, unknown>;
				await assertContainedPath(
					typeof input[options.pathArg] === "string" ? input[options.pathArg] : ".",
					ctx.cwd,
					name,
					operationSignal,
					name === "repo.read",
				);
			}
			if (options.requiredExecutable) {
				const executable = typeof options.requiredExecutable === "function" ? options.requiredExecutable(args) : options.requiredExecutable;
				await requireExistingExecutable(executable, operationSignal);
			}
			assertPiProgramCapabilityAllowed(definition);
			const result = await definition.execute(args, ctx, operationSignal);
			return normalizeCapabilityResult(result, MAX_NESTED_RESULT_BYTES);
		},
	});
}

/**
 * Build the neutral CallScript registry for one Pi execution. Factories receive
 * the execution cwd, so every nested repository operation uses that cwd rather
 * than a cwd captured when the extension was loaded.
 */
function createBuiltinDefinitions(cwd: string): PiBuiltinDefinition[] {
	return [
		asBuiltinDefinition("repo.read", createReadToolDefinition(cwd)),
		asBuiltinDefinition("repo.find", createFindToolDefinition(cwd)),
		asBuiltinDefinition("repo.grep", createGrepToolDefinition(cwd)),
		asBuiltinDefinition("repo.ls", createLsToolDefinition(cwd)),
		asBuiltinDefinition("repo.search", createRepoSearchToolDefinition()),
		...createFoveaCapabilities(),
		...createNotesReadCapabilities(),
		...createMemoryReadCapabilities(),
		...createDatadogCapabilities(),
	];
}

function approvedDefinitions(definitions: PiBuiltinDefinition[]): PiBuiltinDefinition[] {
	return definitions.filter(isPiProgramCapabilityAllowed);
}

function createProgramMetadata(): ScriptTool[] {
	return approvedDefinitions(createBuiltinDefinitions(process.cwd())).map((definition) => tool({
		name: definition.name,
		description: definition.description,
		inputSchema: definition.parameters,
		execute: async () => { throw new Error("pi_program metadata tool cannot execute"); },
	}));
}

function createProgramEngine(cwd: string, outerSignal: AbortSignal | undefined, ctx: ExtensionContext) {
	return callscript({
		tools: cwd ? createPiProgramTools(cwd, outerSignal, ctx) : createProgramMetadata(),
		limits: PROGRAM_LIMITS,
	});
}

/**
 * Build the neutral CallScript registry for one Pi execution. Factories receive
 * the execution cwd, so every nested repository operation uses that cwd rather
 * than a cwd captured when the extension was loaded.
 */
export function createPiProgramTools(cwd: string, outerSignal: AbortSignal | undefined, ctx: ExtensionContext): ScriptTool[] {
	const definitions = approvedDefinitions(createBuiltinDefinitions(cwd));
	return definitions.map((definition) => {
		// The registry is an explicit fail-closed mount boundary.
		assertPiProgramCapabilityAllowed(definition);
		return mountBuiltin(definition.name as (typeof PI_PROGRAM_CAPABILITIES)[number], definition, outerSignal, ctx, {
		pathArg: definition.name.startsWith("repo.") ? "path" : undefined,
		requiredExecutable: definition.name === "repo.find" ? "fd"
			: definition.name === "repo.grep" ? "rg"
			: definition.name === "repo.search" ? (args) => routeRepoSearch(args as any).kind === "files" ? "fd" : "rg"
				: undefined,
		});
	});
}

export function createPiProgramTool(): ToolDefinition {
	const promptDefinition = createProgramEngine("", undefined, {} as ExtensionContext).toolDefinition();
	return {
		name: "pi_program",
		label: "Pi Program",
		description: `${promptDefinition.description}\n\nNested calls are read-only, repository-scoped, and bypass Pi's outer tool_call event.`,
		promptSnippet: "Run a bounded read-only repository program",
		promptGuidelines: [
			"Use repo.*, fovea.*, notes.list/search/read, memory.search/list, and datadog.search/describe/call for read-only work.",
			"repo.search auto routes glob-like queries to files and other queries to text; set mode to override.",
			"Writes, edit, bash, Herdr, scheduled tasks, subagents, interactive tools, and all other unlisted capabilities are direct-only and rejected.",
			"Nested calls bypass Pi's outer tool_call event; the host capability policy and bounded result adapter are authoritative.",
		],
		parameters: Type.Unsafe(promptDefinition.inputSchema as TSchema),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const outerSignal = signal ?? ctx.signal;
			throwIfAborted(outerSignal);
			try {
				const engine = createProgramEngine(ctx.cwd, outerSignal, ctx);
				const execute = engine.tools({ inlineTools: true }).execute;
				throwIfAborted(outerSignal);
				const result = await execute.execute(params);
				throwIfAborted(outerSignal);
				return { content: [{ type: "text", text: compactProgramResult(result) }], details: { status: result.status } };
			} catch (error) {
				// Keep host-level CallScript failures in the same compact textual form
				// as normal error results. Preserve cancellation for Pi's host pipeline.
				throwIfAborted(outerSignal);
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: boundCapabilityText(`Program error: ${message}`, MAX_PROGRAM_RESULT_BYTES) }], details: { status: "error" } };
			}
		},
	};
}

export default function piProgramExtension(pi: ExtensionAPI): void {
	pi.registerTool(createPiProgramTool());
}
