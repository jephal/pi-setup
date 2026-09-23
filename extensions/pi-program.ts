import { callscript, tool, type ScriptTool, type ScriptLimits } from "callscript";
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
import {
	createDatadogCapabilities,
	createFoveaCapabilities,
	createMemoryReadCapabilities,
	createNotesReadCapabilities,
	createRepoSideEffectCapabilities,
	validateRepoSideEffectBounds,
} from "./capability-adapters.ts";
import {
	assertPiProgramSideEffectsAllowed,
	isPiProgramSideEffect,
	validatePiProgramSideEffectScript,
	runPiProgramWithApprovals,
	shouldSuspendPiProgramSideEffect,
	subscribePiProgramApprovalMode,
	type PiProgramApprovalMode,
	type PiProgramSuspension,
} from "./pi-program-approval.ts";

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

function asBuiltinDefinition(name: string, value: unknown, access: HostCapability["access"] = "read-only"): PiBuiltinDefinition {
	const definition = value as {
		description: string;
		parameters: Record<string, unknown>;
		execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext): Promise<unknown>;
	};
	return {
		name,
		description: definition.description,
		access,
		parameters: definition.parameters,
		execute: (args, ctx, signal) => definition.execute(`${name}:nested`, args, signal, undefined, ctx),
	};
}

function formatSchemaIssues(schema: Record<string, unknown>, args: unknown): string {
	const issues = [...Value.Errors(schema as any, args)].slice(0, 5).map((issue) => `${(issue as { path?: string }).path || "args"} ${issue.message}`);
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
	if (name === "repo.edit" || name === "repo.write") {
		validateRepoSideEffectBounds(name, input);
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
	options: {
		pathArg?: string;
		requiredExecutable?: string | ((args: unknown) => string);
		getApprovalMode?: () => PiProgramApprovalMode | undefined;
	} = {},
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
				const path = input[options.pathArg];
				await assertContainedPath(
					typeof path === "string" ? path : ".",
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
			if (definition.access === "side-effect") {
				assertPiProgramSideEffectsAllowed([name], options.getApprovalMode?.(), ctx.hasUI);
			}
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
		...createRepoSideEffectCapabilities(cwd),
		...createFoveaCapabilities(),
		...createNotesReadCapabilities(),
		...createMemoryReadCapabilities(),
		...createDatadogCapabilities(),
	];
}

function approvedDefinitions(definitions: PiBuiltinDefinition[]): PiBuiltinDefinition[] {
	return definitions.filter(isPiProgramCapabilityAllowed);
}

async function validateSuspendedSideEffect(suspension: PiProgramSuspension, cwd: string, signal?: AbortSignal): Promise<void> {
	const props = suspension.interaction?.props && typeof suspension.interaction.props === "object"
		? suspension.interaction.props as Record<string, unknown>
		: {};
	const calls = Array.isArray(props.calls) ? props.calls as Array<Record<string, unknown>> : [];
	const definitions = createRepoSideEffectCapabilities(cwd);
	for (const request of calls) {
		const name = request.tool;
		if (typeof name !== "string" || !definitions.some((definition) => definition.name === name)) continue;
		const definition = definitions.find((candidate) => candidate.name === name)!;
		validateNestedArgs(name, definition.parameters, request.args);
		validateNestedBounds(name, request.args);
		const args = request.args as Record<string, unknown>;
		await assertContainedPath(String(args.path), cwd, name, signal);
	}
}

function createProgramMetadata(): ScriptTool[] {
	return approvedDefinitions(createBuiltinDefinitions(process.cwd())).map((definition) => tool({
		name: definition.name,
		description: definition.description,
		inputSchema: definition.parameters,
		execute: async () => { throw new Error("pi_program metadata tool cannot execute"); },
	}));
}

function createProgramEngine(
	cwd: string,
	outerSignal: AbortSignal | undefined,
	ctx: ExtensionContext,
	getApprovalMode: () => PiProgramApprovalMode | undefined = () => undefined,
	limits: Partial<ScriptLimits> = {},
) {
	return callscript({
		tools: cwd ? createPiProgramTools(cwd, outerSignal, ctx, getApprovalMode) : createProgramMetadata(),
		limits: { ...PROGRAM_LIMITS, ...limits },
		suspend: ({ tool: name }) => shouldSuspendPiProgramSideEffect(name, getApprovalMode()),
	});
}

/**
 * Build the neutral CallScript registry for one Pi execution. Factories receive
 * the execution cwd, so every nested repository operation uses that cwd rather
 * than a cwd captured when the extension was loaded.
 */
export function createPiProgramTools(
	cwd: string,
	outerSignal: AbortSignal | undefined,
	ctx: ExtensionContext,
	getApprovalMode: () => PiProgramApprovalMode | undefined = () => undefined,
): ScriptTool[] {
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
			getApprovalMode,
		});
	});
}

const NOOP_APPROVAL_EVENT_BUS = { events: { emit() {} } } as unknown as Pick<ExtensionAPI, "events">;

export function createPiProgramTool(
	getApprovalMode: () => PiProgramApprovalMode | undefined = () => undefined,
	pi: Pick<ExtensionAPI, "events"> = NOOP_APPROVAL_EVENT_BUS,
): ToolDefinition {
	const promptDefinition = createProgramEngine("", undefined, {} as ExtensionContext).toolDefinition();
	return {
		name: "pi_program",
		label: "Pi Program",
		description: `${promptDefinition.description}\n\nNested calls bypass Pi's outer tool_call event. Only repo.edit and repo.write may change files; both are repository-scoped and bounded, and every required confirmation resolves before execution resumes.`,
		promptSnippet: "Run bounded repository reads and approved edits",
		promptGuidelines: [
			"Use repo.*, fovea.*, notes.list/search/read, memory.search/list, and datadog.search/describe/call for read-only work.",
			"repo.search auto routes glob-like queries to files and other queries to text; set mode to override.",
			"repo.edit and repo.write are the only side effects. They are repository-scoped and bounded; Manual/Approve asks per operation, Auto runs unless suspend:true is set, and Review/Plan/headless execution blocks them.",
			"Bash, shell, notes/memory mutation, Datadog mutation, scheduled tasks, interactive tools, and subagents remain direct-only and rejected.",
			"Nested calls bypass Pi's outer tool_call event; the host capability policy and bounded result adapter are authoritative.",
		],
		parameters: Type.Unsafe(promptDefinition.inputSchema as TSchema),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const outerSignal = signal ?? ctx.signal;
			throwIfAborted(outerSignal);
			try {
				let engine = createProgramEngine(ctx.cwd, outerSignal, ctx, getApprovalMode);
				let script = engine.validate((params as { script: unknown }).script);
				const sideEffectNames = script.steps.flatMap((step) => "call" in step ? [step.call] : []);
				validatePiProgramSideEffectScript(script);
				assertPiProgramSideEffectsAllowed(sideEffectNames, getApprovalMode(), ctx.hasUI);
				if (sideEffectNames.some((name) => isPiProgramSideEffect(name))) {
					// Serialize mixed/write programs so separate approved mutations cannot race.
					engine = createProgramEngine(ctx.cwd, outerSignal, ctx, getApprovalMode, { maxConcurrency: 1 });
					script = engine.validate(script);
				}
				throwIfAborted(outerSignal);
				const result = await runPiProgramWithApprovals(
					({ state, resolutions }) => engine.run({ script, state: state as any, resolutions, retainOutputs: "all" }),
					{
						pi,
						ctx,
						getMode: getApprovalMode,
						beforeConfirm: (suspension) => validateSuspendedSideEffect(suspension, ctx.cwd, outerSignal),
						signal: outerSignal,
					},
				);
				throwIfAborted(outerSignal);
				return { content: [{ type: "text", text: compactProgramResult(result as any) }], details: { status: result.status } };
			} catch (error) {
				// Keep host-level CallScript failures in the same compact textual form
				// as normal error results. Preserve cancellation for Pi's host pipeline.
				throwIfAborted(outerSignal);
				const message = error instanceof Error ? error.message : String(error);
				const prefix = message.startsWith("Invalid script:") ? "Invalid program:" : "Program error:";
				return { content: [{ type: "text", text: boundCapabilityText(`${prefix} ${message.replace(/^Invalid script:\s*/, "")}`, MAX_PROGRAM_RESULT_BYTES) }], details: { status: prefix === "Invalid program:" ? "invalid" : "error" } };
			}
		},
	};
}

export default function piProgramExtension(pi: ExtensionAPI): void {
	const getApprovalMode = subscribePiProgramApprovalMode(pi);
	pi.registerTool(createPiProgramTool(getApprovalMode, pi));
}
