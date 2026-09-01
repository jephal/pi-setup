/** The original conservative tool set used by Review mode. */
export const REVIEW_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "ask_questions", "plan"]);

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
