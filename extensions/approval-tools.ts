/** The original conservative tool set used by Review mode. */
export const REVIEW_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "ask_questions", "plan"]);

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
 * write/edit tools and subagents stay out because they can change project code.
 */
export const PLAN_TOOLS = new Set([
	...REVIEW_TOOLS,
	"notes_list", "notes_search", "notes_read", "notes_write", "notes_transfer", "notes_open_viewer",
	"notes_admin_tools", "notes_open_note", "notes_refresh", "notes_save", "notes_git",
	"memory",
	"scheduled_task_create", "scheduled_task_list", "scheduled_task_delete", "scheduled_task_run_now",
	"herdr_shell",
	"fovea_sketch", "fovea_focus", "fovea_dwell", "fovea_impact",
	"datadog_search_tools",
]);

export type ReadOnlyMode = "review" | "plan";

export function readOnlyToolNames(mode: ReadOnlyMode, availableTools: readonly string[]): string[] {
	const available = new Set(availableTools);
	const allowed = mode === "plan" ? PLAN_TOOLS : REVIEW_TOOLS;
	return [...allowed].filter((tool) => available.has(tool));
}

/** Datadog investigation tools are loaded dynamically and are read-only. */
export function isPlanModeToolAllowed(toolName: string): boolean {
	return PLAN_TOOLS.has(toolName) || toolName.startsWith("datadog_");
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
