/** Read-only tools available in Review mode; request-sensitive tools are filtered below. */
import { isDatadogReadOnlyToolName } from "./datadog-mcp.ts";
import { classifyVisualizationRequest, isPreviewVisualizationRequest } from "./visualization-request.ts";

export const REVIEW_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "ask_questions", "plan", "repo_search", "plan_board", "visualize"]);

// Read-only shell commands allowed by Plan and Review modes.
const SAFE_BASH = [
	/^\s*(cat|head|tail|less|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|uptime|ps|free)\b/i,
	/^\s*git\s+(status|log|diff|show|rev-parse)(?:\s+.*)?$/i,
	/^\s*git\s+(?:branch(?:\s+(?:--show-current|--list(?:\s+.*)?))?|remote(?:\s+-v)?|ls-(?:files|tree|remote))\s*$/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*(rg|fd|bat|eza)\b/i,
];

export function isSafePlanBash(command: string): boolean {
	// Do not attempt to interpret shell composition in a read-only mode.
	if (!command || /[;&|<>`\n\r]|\$\(/.test(command)) return false;
	return SAFE_BASH.some((pattern) => pattern.test(command));
}

/**
 * Plan mode can use every registered non-code-changing/context tool. Generic
 * write/edit tools and subagents stay out because they can change project code;
 * visualization calls are separately restricted to previews below.
 */
export const PLAN_VISUALIZATION_TOOL = "visualize";
export const PLAN_VISUALIZATION_ACTION = "preview";

/** Plan mode may inspect visualizations, but must not start or control either viewer or write artifacts. */
export function isPlanModeVisualizationAllowed(input: unknown): boolean {
	return isPreviewVisualizationRequest(input);
}

/** Review permits previews and the existing browser viewer, but not persistent writes or terminal panes. */
export function isReviewModeVisualizationAllowed(input: unknown): boolean {
	const kind = classifyVisualizationRequest(input);
	return kind === "preview-mermaid" || kind === "preview-excalidraw" || kind === "browser-viewer";
}

export const PLAN_TOOLS = new Set([
	...REVIEW_TOOLS,
	// Plan mode may inspect notes and the Notes UI, but it must not mutate the
	// vault, move files, save human edits, or activate administration tools.
	"notes_list", "notes_search", "notes_read", "notes_open_viewer", "notes_open_note", "notes_refresh",
	// Scheduled-task listing is observational; create/delete/run remain gated.
	"scheduled_task_list",
	"fovea_sketch", "fovea_focus", "fovea_dwell", "fovea_impact",
	"datadog_search_tools",
	"plan_board",
	PLAN_VISUALIZATION_TOOL,
]);

export type ReadOnlyMode = "review" | "plan";

export function readOnlyToolNames(mode: ReadOnlyMode, availableTools: readonly string[]): string[] {
	const available = new Set(availableTools);
	const allowed = mode === "plan" ? PLAN_TOOLS : REVIEW_TOOLS;
	return [...allowed].filter((tool) => available.has(tool));
}

/** Dynamic Datadog tools and request-sensitive visualization tools are read-only only when allowed. */
export function isPlanModeToolAllowed(toolName: string, input?: unknown): boolean {
	if (toolName === PLAN_VISUALIZATION_TOOL) return isPlanModeVisualizationAllowed(input);
	return PLAN_TOOLS.has(toolName) || isDatadogReadOnlyToolName(toolName);
}

export function isReviewModeToolAllowed(toolName: string, input?: unknown): boolean {
	if (toolName === PLAN_VISUALIZATION_TOOL) return isReviewModeVisualizationAllowed(input);
	return REVIEW_TOOLS.has(toolName);
}

/** Preserve tools activated while read-only without re-adding temporary tools. */
export function restoreActiveTools(
	beforeReadOnly: readonly string[],
	activeDuringReadOnly: readonly string[],
	temporaryTools: ReadonlySet<string> = REVIEW_TOOLS,
): string[] {
	return [...new Set([
		...beforeReadOnly,
		...activeDuringReadOnly.filter((tool) => !temporaryTools.has(tool) || beforeReadOnly.includes(tool)),
	])];
}
