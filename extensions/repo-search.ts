import { spawn, spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { Type, type Static } from "typebox";
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const MAX_SEARCH_RESULTS = 2_000;
export const MAX_GREP_CONTEXT = 20;
const EXECUTABLE_CHECK_TIMEOUT_MS = 2_000;
const ABORTED = "Operation aborted";

/** The compact shared input accepted by the direct and scripted search tools. */
export const repoSearchSchema = Type.Object({
	query: Type.String(),
	mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("text"), Type.Literal("files")])),
	path: Type.Optional(Type.String()),
	glob: Type.Optional(Type.String()),
	ignoreCase: Type.Optional(Type.Boolean()),
	literal: Type.Optional(Type.Boolean()),
	context: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_GREP_CONTEXT })),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
});

export type RepoSearchInput = Static<typeof repoSearchSchema>;
export type RepoSearchRoute =
	| { kind: "files"; args: { pattern: string; path?: string; limit?: number } }
	| { kind: "text"; args: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number } };

/** Wildcards identify a file query; ordinary words and phrases are text queries. */
export function isGlobLikeQuery(query: string): boolean {
	return /[*?\[\]{}]/.test(query);
}

/** Select a native Pi find or grep call without importing either implementation. */
export function routeRepoSearch(input: RepoSearchInput): RepoSearchRoute {
	const kind = input.mode === "files" || (input.mode !== "text" && isGlobLikeQuery(input.query)) ? "files" : "text";
	if (kind === "files") {
		return {
			kind,
			args: {
				pattern: input.query,
				...(input.path === undefined ? {} : { path: input.path }),
				...(input.limit === undefined ? {} : { limit: input.limit }),
			},
		};
	}
	return {
		kind,
		args: {
			pattern: input.query,
			...(input.path === undefined ? {} : { path: input.path }),
			...(input.glob === undefined ? {} : { glob: input.glob }),
			...(input.ignoreCase === undefined ? {} : { ignoreCase: input.ignoreCase }),
			...(input.literal === undefined ? {} : { literal: input.literal }),
			...(input.context === undefined ? {} : { context: input.context }),
			...(input.limit === undefined ? {} : { limit: input.limit }),
		},
	};
}

function invalidNumber(name: string, value: unknown, description: string): Error {
	return new Error(`Invalid ${name}: expected ${description}, received ${String(value)}`);
}

/** Apply the same safe numeric limits to direct and CallScript searches. */
export function validateRepoSearchInput(input: RepoSearchInput): void {
	if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_SEARCH_RESULTS)) {
		throw invalidNumber("search limit", input.limit, `an integer from 1 to ${MAX_SEARCH_RESULTS}`);
	}
	if (input.context !== undefined && (!Number.isSafeInteger(input.context) || input.context < 0 || input.context > MAX_GREP_CONTEXT)) {
		throw invalidNumber("grep context", input.context, `an integer from 0 to ${MAX_GREP_CONTEXT}`);
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error(ABORTED);
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Match Pi's shared path normalization before checking the containment boundary. */
function normalizeSearchPath(rawPath: string): string {
	let normalized = rawPath.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (process.platform === "win32" && normalized.startsWith("~\\")) normalized = resolve(homedir(), normalized.slice(2));
	else if (normalized === "~") normalized = homedir();
	else if (normalized.startsWith("~/")) normalized = resolve(homedir(), normalized.slice(2));
	if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
	return normalized;
}

function isContained(root: string, target: string): boolean {
	const relation = relative(root, target);
	return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function resolveSearchPaths(rawPath: string, cwd: string, includeReadVariants: boolean): string[] {
	const resolved = resolve(cwd, normalizeSearchPath(rawPath));
	if (!includeReadVariants) return [resolved];
	const variants = [
		resolved.replace(/ (AM|PM)\./gi, "\u202F$1."),
		resolved.normalize("NFD"),
		resolved.replace(/'/g, "\u2019"),
	];
	variants.push(variants[1].replace(/'/g, "\u2019"));
	return [...new Set([resolved, ...variants])];
}

/** Reject traversal and symlink paths that resolve outside the execution repository. */
export async function assertContainedPath(
	rawPath: string,
	cwd: string,
	capability = "repo.search",
	signal?: AbortSignal,
	includeReadVariants = false,
): Promise<void> {
	const lexicalRoot = resolve(cwd);
	const realRoot = await realpath(lexicalRoot);
	for (const lexicalTarget of resolveSearchPaths(rawPath, cwd, includeReadVariants)) {
		throwIfAborted(signal);
		if (!isContained(lexicalRoot, lexicalTarget)) {
			throw new Error(`${capability} path is outside the execution repository`);
		}

		let candidate = lexicalTarget;
		while (true) {
			throwIfAborted(signal);
			try {
				if (!isContained(realRoot, await realpath(candidate))) {
					throw new Error(`${capability} path is outside the execution repository`);
				}
				break;
			} catch (error) {
				if (error instanceof Error && error.message === `${capability} path is outside the execution repository`) throw error;
				const parent = dirname(candidate);
				if (parent === candidate) break;
				candidate = parent;
			}
		}
	}
}

/** Check a binary without allowing a stuck or failing executable to block forever. */
export function executableExists(binary: string, env: NodeJS.ProcessEnv = process.env): boolean {
	try {
		const result = spawnSync(binary, ["--version"], {
			stdio: "ignore",
			env,
			timeout: EXECUTABLE_CHECK_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		return result.error === undefined;
	} catch {
		return false;
	}
}

/** Abortable executable preflight used before Pi's downloader-backed definitions. */
export async function requireExistingExecutable(binary: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	await new Promise<void>((resolvePromise, reject) => {
		let settled = false;
		const child = spawn(binary, ["--version"], { stdio: "ignore" });
		const timer = setTimeout(() => finish(new Error(`${binary} is not available; repository search will not install tools`)), EXECUTABLE_CHECK_TIMEOUT_MS);
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (error) {
				child.kill("SIGKILL");
				reject(error);
			} else {
				resolvePromise();
			}
		};
		const onAbort = () => finish(new Error(ABORTED));
		signal?.addEventListener("abort", onAbort, { once: true });
		child.once("error", () => finish(new Error(`${binary} is not available; repository search will not install tools`)));
		child.once("close", () => finish());
	});
	throwIfAborted(signal);
}

/** Build the native Pi definition used by both the direct tool and pi_program. */
export function createRepoSearchToolDefinition(): ToolDefinition {
	return {
		name: "repo_search",
		label: "Repository Search",
		description: "Search the repository for text or files. Auto routes glob-like queries to file search and other queries to text search; set mode to override.",
		promptSnippet: "Search repository text or files",
		promptGuidelines: ["Use mode=files for file names and mode=text for file contents when auto routing is not appropriate."],
		parameters: repoSearchSchema,
		async execute(toolCallId, input, signal, onUpdate, ctx) {
			const searchInput = input as RepoSearchInput;
			const operationSignal = signal ?? ctx.signal;
			validateRepoSearchInput(searchInput);
			throwIfAborted(operationSignal);
			const route = routeRepoSearch(searchInput);
			await assertContainedPath(searchInput.path ?? ".", ctx.cwd, "repo_search", operationSignal);
			await requireExistingExecutable(route.kind === "files" ? "fd" : "rg", operationSignal);
			const definition = route.kind === "files"
				? createFindToolDefinition(ctx.cwd)
				: createGrepToolDefinition(ctx.cwd);
			return definition.execute(toolCallId, route.args as never, operationSignal, onUpdate as never, ctx);
		},
	};
}

export default function repoSearchExtension(pi: ExtensionAPI): void {
	pi.registerTool(createRepoSearchToolDefinition());
}
