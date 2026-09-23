import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Access classification for host capabilities. Only read classes may cross pi_program. */
export type CapabilityAccess = "read-only" | "dynamic-read" | "write" | "interactive";

export interface HostCapability {
	name: string;
	description: string;
	access: CapabilityAccess;
	parameters: Record<string, unknown>;
	execute(args: unknown, ctx: ExtensionContext, signal?: AbortSignal): Promise<unknown>;
}

/** Explicit registry of host capabilities permitted inside CallScript. */
export const PI_PROGRAM_CAPABILITY_NAMES = [
	"repo.read", "repo.find", "repo.grep", "repo.ls", "repo.search",
	"fovea.sketch", "fovea.focus", "fovea.dwell", "fovea.impact",
	"notes.list", "notes.search", "notes.read", "memory.search", "memory.list",
	"datadog.search", "datadog.describe", "datadog.call",
] as const;
export const PI_PROGRAM_ALLOWED_CAPABILITIES = new Set<string>(PI_PROGRAM_CAPABILITY_NAMES);

const allowedNames = PI_PROGRAM_ALLOWED_CAPABILITIES;

/** Names which remain direct-only, even if a future extension exposes a similar tool. */
export const PI_PROGRAM_REJECTED_CAPABILITIES = [
	"bash",
	"write",
	"edit",
	"herdr_shell",
	"scheduled_task_list",
	"scheduled_task_create",
	"scheduled_task_cancel",
	"scheduled_task_delete",
	"scheduled_task_run",
	"scheduled_task_run_now",
	"subagent",
	"ask_questions",
	"plan",
	"notes_admin_tools",
	"notes.write",
	"notes.transfer",
	"notes.open_viewer",
	"notes.open_note",
	"notes.refresh",
	"notes.save",
	"notes.git",
	"notes_list",
	"notes_search",
	"notes_read",
	"notes_write",
	"notes_transfer",
	"notes_open_viewer",
	"notes_open_note",
	"notes_refresh",
	"notes_save",
	"notes_git",
	"memory",
	"memory.save",
	"memory.update",
	"memory.delete",
] as const;

const rejectedNames = new Set<string>(PI_PROGRAM_REJECTED_CAPABILITIES);

export function isPiProgramCapabilityAllowed(capability: Pick<HostCapability, "name" | "access">): boolean {
	return allowedNames.has(capability.name)
		&& !rejectedNames.has(capability.name)
		&& (capability.access === "read-only" || capability.access === "dynamic-read");
}

export function assertPiProgramCapabilityAllowed(capability: Pick<HostCapability, "name" | "access">): void {
	if (!isPiProgramCapabilityAllowed(capability)) {
		throw new Error(`Capability "${capability.name}" is direct-only and cannot run inside pi_program`);
	}
}

export const MAX_NESTED_RESULT_BYTES = 64 * 1024;
export const MAX_PROGRAM_RESULT_BYTES = 96 * 1024;

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
	return typeof value === "object" && value !== null
		&& (value as { type?: unknown }).type === "text"
		&& typeof (value as { text?: unknown }).text === "string";
}

/** Keep nested host results textual and omit images, UI payloads, and binary data. */
export function compactCapabilityResult(result: unknown): string {
	if (typeof result === "string") return result;
	if (result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
		const textBlocks = (result as { content: unknown[] }).content.filter(isTextBlock);
		if (textBlocks.length > 0) return textBlocks.map((block) => block.text).join("\n");
		return "(non-text output omitted)";
	}
	if (result && typeof result === "object" && typeof (result as { text?: unknown }).text === "string") {
		return (result as { text: string }).text;
	}
	if (result === undefined) return "(no output)";
	try {
		return JSON.stringify(result) ?? String(result);
	} catch {
		return String(result);
	}
}

/** Bound UTF-8 output without splitting a multibyte code point. */
export function boundCapabilityText(text: string, maxBytes: number): string {
	const budget = Math.max(0, Math.floor(maxBytes));
	const encoder = new TextEncoder();
	if (encoder.encode(text).byteLength <= budget) return text;
	const fit = (value: string, limit: number): string => {
		let result = new TextDecoder().decode(encoder.encode(value).slice(0, limit));
		while (encoder.encode(result).byteLength > limit) result = result.slice(0, -1);
		return result;
	};
	const marker = `\n… output truncated at ${budget} bytes`;
	const markerBytes = encoder.encode(marker).byteLength;
	if (markerBytes >= budget) return fit(text, budget);
	return `${fit(text, budget - markerBytes)}${marker}`;
}

export function normalizeCapabilityResult(result: unknown, maxBytes = MAX_NESTED_RESULT_BYTES): string {
	return boundCapabilityText(compactCapabilityResult(result), maxBytes);
}
