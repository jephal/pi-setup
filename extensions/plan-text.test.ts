import assert from "node:assert/strict";
import test from "node:test";
import { checklistMarkdown, PLAN_TOOL_DESCRIPTION, PLAN_TOOL_PROMPT_GUIDELINES, PLAN_TOOL_PROMPT_SNIPPET } from "./plan-text.ts";

test("plan tool guidance distinguishes full Plan mode plans from outside-mode checklists", () => {
	assert.match(PLAN_TOOL_DESCRIPTION, /In Plan mode/);
	assert.match(PLAN_TOOL_DESCRIPTION, /Outside Plan mode/);
	assert.match(PLAN_TOOL_PROMPT_SNIPPET, /checklists outside Plan mode/);
	assert.ok(PLAN_TOOL_PROMPT_GUIDELINES.some((guideline) => /steps and no full Markdown content/.test(guideline)));
	assert.ok(PLAN_TOOL_PROMPT_GUIDELINES.some((guideline) => /Enter Plan mode first/.test(guideline)));
});

test("checklist Markdown is compact and preserves completed step state", () => {
	assert.equal(
		checklistMarkdown("small task", [
			{ id: 1, title: "First", status: "pending" },
			{ id: 2, title: "Second", status: "completed" },
		]),
		"# Checklist: small task\n\n- [ ] 1. First\n- [x] 2. Second",
	);
});
