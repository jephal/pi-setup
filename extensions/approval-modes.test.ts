import assert from "node:assert/strict";
import test from "node:test";
import { isPlanModeToolAllowed, PLAN_TOOLS, restoreActiveTools, REVIEW_TOOLS } from "./approval-tools.ts";

test("Plan mode allows context tools while Review mode keeps the conservative set", () => {
	for (const tool of ["notes_list", "notes_write", "memory", "herdr_shell", "fovea_focus", "datadog_search_tools", "scheduled_task_list"]) {
		assert.equal(PLAN_TOOLS.has(tool), true, tool);
	}
	assert.equal(REVIEW_TOOLS.has("notes_list"), false);
	assert.equal(isPlanModeToolAllowed("datadog_logs"), true);
	assert.equal(isPlanModeToolAllowed("write"), false);
});

test("leaving read-only mode preserves dynamically activated tools", () => {
	assert.deepEqual(
		restoreActiveTools(
			["read", "notes_admin_tools", "datadog_search_tools"],
			["read", "grep", "plan", "notes_git", "datadog_logs", "notes_git"],
		),
		["read", "notes_admin_tools", "datadog_search_tools", "notes_git", "datadog_logs"],
	);
	assert.deepEqual(
		restoreActiveTools(
			["read"],
			["read", "notes_list", "fovea_focus", "datadog_logs"],
			PLAN_TOOLS,
		),
		["read", "datadog_logs"],
	);
});
