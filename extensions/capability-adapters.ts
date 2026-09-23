import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "node:path";
import type { ImpactArgs } from "pi-fovea/ops";
import { NotesVault, MAX_NOTE_BYTES, type NotesSearchMode } from "../src/notes/vault.ts";
import { MemoryStore } from "../src/memory/db.ts";
import type { MemoryRecord, MemorySearchResult } from "../src/memory/types.ts";
import { withMemoryStoreReadOnly } from "./memory.ts";
import { assertContainedPath } from "./repo-search.ts";
import { boundCapabilityText, MAX_NESTED_RESULT_BYTES, type HostCapability } from "./capabilities.ts";
import { getDatadogCapabilityProvider, type DatadogCapabilityProvider } from "./datadog-mcp.ts";

const MAX_NOTES_OUTPUT_BYTES = 50 * 1024;
const MAX_NOTES_LIST_LIMIT = 500;

const notesListParameters = Type.Object({
	path: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_NOTES_LIST_LIMIT })),
});

const notesSearchParameters = Type.Object({
	query: Type.String(),
	path: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	mode: Type.Optional(StringEnum(["literal", "regex", "filename"] as const)),
	glob: Type.Optional(Type.String()),
	caseSensitive: Type.Optional(Type.Boolean()),
	contextLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
	pathsOnly: Type.Optional(Type.Boolean()),
});

const notesReadParameters = Type.Object({ path: Type.String() });

const memorySearchParameters = Type.Object({
	query: Type.Optional(Type.String()),
	scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project")])),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});
const memoryListParameters = Type.Object({
	scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project")])),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

const foveaBudget = Type.Optional(Type.Integer({ minimum: 256, maximum: 16_000 }));
const foveaRoot = Type.Optional(Type.String({ description: "Repository-relative root; defaults to the execution cwd." }));

const foveaSketchParameters = Type.Object({ root: foveaRoot, maxTokens: foveaBudget });
const foveaKind = Type.Optional(Type.Union([
	Type.Literal("function"), Type.Literal("method"), Type.Literal("class"), Type.Literal("interface"),
	Type.Literal("type"), Type.Literal("field"), Type.Literal("decl"), Type.Literal("file"), Type.Literal("anchor"),
]));
const foveaFocusParameters = Type.Object({
	query: Type.String(),
	path: Type.Optional(Type.String()),
	language: Type.Optional(Type.String()),
	kind: foveaKind,
	fresh: Type.Optional(Type.Boolean()),
	root: foveaRoot,
	maxTokens: foveaBudget,
});
const foveaDwellParameters = Type.Object({
	factor: Type.Optional(Type.Number({ minimum: 1.1, maximum: 16 })),
	root: foveaRoot,
	maxTokens: foveaBudget,
});
const foveaImpactParameters = Type.Object({
	files: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
	symbols: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
	includeUncommitted: Type.Optional(Type.Boolean()),
	base: Type.Optional(Type.String()),
	root: foveaRoot,
	maxTokens: foveaBudget,
});

const datadogSearchParameters = Type.Object({
	query: Type.String(),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
});
const datadogNameParameters = Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }) });
const datadogCallParameters = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 200 }),
	arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

function boundedNoteText(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= MAX_NOTES_OUTPUT_BYTES) return text;
	const suffix = `\n\n[Output truncated to ${MAX_NOTES_OUTPUT_BYTES} bytes.]`;
	let result = text.slice(0, MAX_NOTES_OUTPUT_BYTES - Buffer.byteLength(suffix, "utf8"));
	while (Buffer.byteLength(result, "utf8") + Buffer.byteLength(suffix, "utf8") > MAX_NOTES_OUTPUT_BYTES) result = result.slice(0, -1);
	return `${result}${suffix}`;
}

function notes(): NotesVault {
	return NotesVault.fromEnvironment();
}

type FoveaOperations = typeof import("pi-fovea/ops");

async function foveaOperations(): Promise<FoveaOperations> {
	// Resolve through the dependency's public export only when Fovea is used.
	return import("pi-fovea/ops");
}

function foveaRootPath(ctx: ExtensionContext, rawRoot: unknown, signal?: AbortSignal): Promise<string> {
	const root = typeof rawRoot === "string" && rawRoot.trim() ? rawRoot : ".";
	return assertContainedPath(root, ctx.cwd, "fovea", signal).then(() => resolve(ctx.cwd, root));
}

async function abortable<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const pending = operation();
	if (!signal) return pending;
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => {
			signal.removeEventListener("abort", abort);
			reject(new Error("Operation aborted"));
		};
		signal.addEventListener("abort", abort, { once: true });
		pending.then(
			(value) => { signal.removeEventListener("abort", abort); resolve(value); },
			(error) => { signal.removeEventListener("abort", abort); reject(error); },
		);
	});
}

function formatBoundedMemories(results: Array<MemoryRecord | MemorySearchResult>, maxBytes: number): string {
	let output = "";
	for (const record of results) {
		const tags = record.tags.length ? ` [${record.tags.join(", ")}]` : "";
		const score = "score" in record ? ` score=${record.score.toFixed(2)}` : "";
		const core = record.alwaysInject ? " · core" : "";
		const prefix = `${record.id} · ${record.scope}/${record.category}${core}${tags}${score}\n`;
		const separator = output ? "\n\n" : "";
		const remaining = maxBytes - new TextEncoder().encode(output + separator + prefix).byteLength;
		if (remaining <= 0) break;
		const content = boundCapabilityText(record.content, remaining);
		output += separator + prefix + content;
		if (new TextEncoder().encode(output).byteLength >= maxBytes) break;
	}
	return output || "No memories found.";
}

function capability(
	name: string,
	description: string,
	parameters: Record<string, unknown>,
	execute: (args: any, ctx: ExtensionContext, signal?: AbortSignal) => Promise<unknown>,
): HostCapability {
	return { name, description, access: "read-only", parameters, execute };
}

export function createFoveaCapabilities(): HostCapability[] {
	return [
		capability("fovea.sketch", "Survey the repository with a bounded production-first Fovea sketch.", foveaSketchParameters, async (args, ctx, signal) => {
			const { sketch } = await abortable(() => foveaOperations(), signal);
			return abortable(async () => sketch(await foveaRootPath(ctx, args.root, signal), args.maxTokens), signal);
		}),
		capability("fovea.focus", "Focus Fovea on a repository symbol, route, environment key, or file.", foveaFocusParameters, async (args, ctx, signal) => {
			const { focus } = await abortable(() => foveaOperations(), signal);
			return abortable(async () => focus(await foveaRootPath(ctx, args.root, signal), args.query, args.maxTokens, {
				path: args.path,
				language: args.language,
				kind: args.kind as any,
				fresh: args.fresh,
			}), signal);
		}),
		capability("fovea.dwell", "Widen the current Fovea focus by a bounded diffusion factor.", foveaDwellParameters, async (args, ctx, signal) => {
			const { dwell } = await abortable(() => foveaOperations(), signal);
			return abortable(async () => dwell(await foveaRootPath(ctx, args.root, signal), args.factor, args.maxTokens), signal);
		}),
		capability("fovea.impact", "Predict the likely review surface of repository changes with Fovea.", foveaImpactParameters, async (args, ctx, signal) => {
			const impactArgs: ImpactArgs = {
				files: args.files,
				symbols: args.symbols,
				includeUncommitted: args.includeUncommitted,
				base: args.base,
				budget: args.maxTokens,
			};
			const { impact } = await abortable(() => foveaOperations(), signal);
			return abortable(async () => impact(await foveaRootPath(ctx, args.root, signal), impactArgs), signal);
		}),
	];
}

export function createNotesReadCapabilities(): HostCapability[] {
	return [
		capability("notes.list", "List visible Markdown notes in the configured notes vault.", notesListParameters, async (args, _ctx, signal) => {
			const entries = await abortable(() => notes().listNotes(args.path?.trim() || ".", args.limit ?? 100), signal);
			return boundedNoteText(entries.length
				? entries.map((note) => `${note.path} (${note.bytes} bytes, modified ${note.modifiedAt})`).join("\n")
				: "No Markdown notes found.");
		}),
		capability("notes.search", "Search the configured notes vault without modifying it.", notesSearchParameters, async (args, _ctx, signal) => {
			const matches = await notes().search(args.query, args.path?.trim() || ".", args.limit ?? 20, {
				mode: args.mode as NotesSearchMode | undefined,
				glob: args.glob,
				caseSensitive: args.caseSensitive,
				contextLines: args.contextLines,
				pathsOnly: args.pathsOnly,
				signal,
			});
			const text = matches.length
				? args.pathsOnly
					? matches.map((match) => match.path).join("\n")
					: matches.map((match) => `${match.path}${match.line ? `:${match.line}` : ""}${match.snippet ? `\n${match.snippet}` : ""}`).join("\n\n")
				: `No notes matched: ${args.query}`;
			return boundedNoteText(text);
		}),
		capability("notes.read", `Read one Markdown note (maximum ${MAX_NOTE_BYTES} bytes).`, notesReadParameters, async (args, _ctx, signal) => {
			const note = await abortable(() => notes().readNote(args.path), signal);
			return boundedNoteText(note.content);
		}),
	];
}

export function createMemoryReadCapabilities(): HostCapability[] {
	const read = (operation: (store: MemoryStore) => MemorySearchResult[] | MemoryRecord[], signal?: AbortSignal) =>
		withMemoryStoreReadOnly(operation, signal);
	return [
		capability("memory.search", "Search durable memories without recording usage or changing memory.", memorySearchParameters, async (args, _ctx, signal) => {
			const results = await read((store) => store.search(args.query ?? "", {
				scopes: args.scope ? [args.scope] : undefined,
				limit: args.limit,
				recordUsage: false,
			}), signal);
			return formatBoundedMemories(results ?? [], MAX_NESTED_RESULT_BYTES);
		}),
		capability("memory.list", "List durable memories without recording usage or changing memory.", memoryListParameters, async (args, _ctx, signal) => {
			const results = await read((store) => store.list({ scopes: args.scope ? [args.scope] : undefined, limit: args.limit }), signal);
			return formatBoundedMemories(results ?? [], MAX_NESTED_RESULT_BYTES);
		}),
	];
}

export function createDatadogCapabilities(provider: DatadogCapabilityProvider = getDatadogCapabilityProvider()): HostCapability[] {
	return [
		{ name: "datadog.search", description: "Search the parent-owned Datadog MCP catalog without exposing credentials.", access: "dynamic-read", parameters: datadogSearchParameters, execute: async (args, ctx, signal) => provider.search(args.query, args.limit ?? 5, ctx, signal) },
		{ name: "datadog.describe", description: "Describe one currently available parent-owned Datadog MCP capability.", access: "dynamic-read", parameters: datadogNameParameters, execute: async (args, ctx, signal) => provider.describe(args.name, ctx, signal) },
		{ name: "datadog.call", description: "Call one revalidated read-only Datadog MCP capability through the parent OAuth lifecycle.", access: "dynamic-read", parameters: datadogCallParameters, execute: async (args, ctx, signal) => provider.call(args.name, args.arguments ?? {}, ctx, signal) },
	];
}
