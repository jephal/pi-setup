import assert from "node:assert/strict";
import test from "node:test";
import { checklistMarkdown, PLAN_MODE_TOOL_ACCESS, PLAN_MODE_WRITING_STYLE, PLAN_TOOL_DESCRIPTION, PLAN_TOOL_PROMPT_GUIDELINES, PLAN_TOOL_PROMPT_SNIPPET, planUpdateNotice, summarizePlanChanges } from "./plan-text.ts";

test("plan tool guidance distinguishes full Plan mode plans from outside-mode checklists", () => {
	assert.match(PLAN_TOOL_DESCRIPTION, /In Plan mode/);
	assert.match(PLAN_TOOL_DESCRIPTION, /Outside Plan mode/);
	assert.match(PLAN_TOOL_DESCRIPTION, /decision-first writing/);
	assert.match(PLAN_TOOL_PROMPT_SNIPPET, /checklists outside Plan mode/);
	assert.match(PLAN_MODE_WRITING_STYLE, /scope, audience, and conclusion/);
	assert.match(PLAN_MODE_TOOL_ACCESS, /notes, memory, Fovea, Herdr inspection/);
	assert.ok(PLAN_TOOL_PROMPT_GUIDELINES.some((guideline) => /steps and no full Markdown content/.test(guideline)));
	assert.ok(PLAN_TOOL_PROMPT_GUIDELINES.some((guideline) => /Enter Plan mode first/.test(guideline)));
});

test("plan updates summarize changed sections and checklist steps", () => {
	const previous = {
		name: "initial plan",
		content: "## In short\n\nOld rationale\n\n## What happens next",
		steps: [
			{ id: 1, title: "Inspect", status: "pending" },
			{ id: 2, title: "Implement", status: "pending" },
		],
	};
	const next = {
		name: "revised plan",
		content: "## In short\n\nNew rationale\n\n## What happens next\n\n## Risks",
		steps: [
			{ id: 1, title: "Inspect", status: "completed" },
			{ id: 3, title: "Validate", status: "pending" },
		],
	};

	const summary = summarizePlanChanges(previous, next);
	assert.match(summary, /Renamed the plan/);
	assert.match(summary, /Added checklist steps: 3\. Validate/);
	assert.match(summary, /Removed checklist steps: 2\. Implement/);
	assert.match(summary, /Changed checklist steps: 1 \(status\)/);
	assert.match(summary, /Added plan sections: Risks/);
	const notice = planUpdateNotice(previous, next);
	assert.match(notice, /PLAN UPDATE CONTEXT/);
	assert.match(notice, /what changed, why it changed/);
	assert.match(notice, /Do not add this explanation to the saved plan/);
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
