export const PLAN_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "ask_questions", "plan"]);

/** Preserve tools activated while read-only without re-adding the temporary plan-only set. */
export function restoreActiveTools(beforeReadOnly: readonly string[], activeDuringReadOnly: readonly string[]): string[] {
	return [...new Set([...beforeReadOnly, ...activeDuringReadOnly.filter((tool) => !PLAN_TOOLS.has(tool))])];
}
