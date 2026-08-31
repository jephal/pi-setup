import assert from "node:assert/strict";
import test from "node:test";
import { restoreActiveTools } from "./approval-tools.ts";

test("leaving read-only mode preserves dynamically activated tools", () => {
	assert.deepEqual(
		restoreActiveTools(
			["read", "notes_admin_tools", "datadog_search_tools"],
			["read", "grep", "plan", "notes_git", "datadog_logs", "notes_git"],
		),
		["read", "notes_admin_tools", "datadog_search_tools", "notes_git", "datadog_logs"],
	);
});
