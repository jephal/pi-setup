import assert from "node:assert/strict";
import test from "node:test";
import { isPlanModeToolAllowed, isSafePlanBash, PLAN_TOOLS, readOnlyToolNames, restoreActiveTools, REVIEW_TOOLS } from "./approval-tools.ts";

test("Plan mode bash safety rejects mutating Git commands and shell composition", () => {
	assert.equal(isSafePlanBash("git status --short"), true);
	assert.equal(isSafePlanBash("git branch -D feature"), false);
	assert.equal(isSafePlanBash("git remote add origin https://example.test"), false);
	assert.equal(isSafePlanBash("git status && rm -rf ."), false);
	assert.equal(isSafePlanBash("git rev-parse --show-toplevel"), true);
});

test("Plan mode allows context tools while Review mode keeps the conservative set", () => {
	for (const tool of ["notes_list", "notes_write", "memory", "herdr_shell", "fovea_focus", "datadog_search_tools", "scheduled_task_list"]) {
		assert.equal(PLAN_TOOLS.has(tool), true, tool);
	}
	assert.equal(REVIEW_TOOLS.has("notes_list"), false);
	assert.equal(isPlanModeToolAllowed("datadog_logs"), true);
	assert.equal(isPlanModeToolAllowed("write"), false);
	const available = ["read", "plan", "notes_list", "memory", "fovea_focus", "datadog_logs"];
	assert.deepEqual(readOnlyToolNames("review", available), ["read", "plan"]);
	assert.deepEqual(readOnlyToolNames("plan", available), ["read", "plan", "notes_list", "memory", "fovea_focus"]);
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
