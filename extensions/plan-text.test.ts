import assert from "node:assert/strict";
import test from "node:test";
import {
	checklistMarkdown,
	PLAN_BOARD_GUIDANCE,
	PLAN_FORMAT_GUIDANCE,
	PLAN_CONTEXT_GUIDANCE,
	PLAN_DISCUSSION_GUIDANCE,
	PLAN_TOOL_DESCRIPTION,
	PLAN_TOOL_PROMPT_GUIDELINES,
	PLAN_TOOL_PROMPT_SNIPPET,
	PLAN_UPDATE_RESPONSE_GUIDANCE,
	taskListWidgetLines,
	VISUALIZATION_ALL_MODE_GUIDANCE,
	planUpdateNotice,
	summarizePlanChanges,
} from "./plan-text.ts";

test("plan guidance keeps saved content to a short numbered task list with user-led grilling", () => {
	assert.match(PLAN_TOOL_DESCRIPTION, /every approval mode/);
	assert.match(PLAN_TOOL_DESCRIPTION, /short numbered task list shown above the editor/);
	assert.match(PLAN_TOOL_DESCRIPTION, /Review mode may save tasks but cannot execute/);
	assert.match(PLAN_DISCUSSION_GUIDANCE, /do not force a research or grilling session/);
	assert.match(PLAN_DISCUSSION_GUIDANCE, /only when an important unknown blocks/);
	assert.match(PLAN_DISCUSSION_GUIDANCE, /when the user asks to talk the details through/);
	assert.match(PLAN_FORMAT_GUIDANCE, /Save only a short numbered task list/);
	assert.match(PLAN_FORMAT_GUIDANCE, /Do not save decision summaries, rationale, prose sections, or large implementation plans/);
	assert.match(PLAN_FORMAT_GUIDANCE, /Keep discussion in chat/);
	assert.match(PLAN_FORMAT_GUIDANCE, /add more numbered tasks only when the user asks for detail/);
	assert.match(PLAN_CONTEXT_GUIDANCE, /Review mode remains read-only/);
	assert.match(PLAN_TOOL_PROMPT_SNIPPET, /short numbered task list to the above-editor task view in any mode/);
	assert.match(PLAN_FORMAT_GUIDANCE, /short numbered task list \(1\., 2\., 3\.\)/);
	assert.match(PLAN_TOOL_PROMPT_GUIDELINES.join(" "), /Review mode remains read-only/);
	assert.match(PLAN_TOOL_PROMPT_GUIDELINES.join(" "), /pass each task through `steps`/);
	assert.match(PLAN_UPDATE_RESPONSE_GUIDANCE, /briefly summarize material changes/);
	assert.match(PLAN_BOARD_GUIDANCE, /authoritative Pi plan/);
	assert.match(VISUALIZATION_ALL_MODE_GUIDANCE, /No remote or CDN assets/);
	assert.doesNotMatch(`${PLAN_TOOL_DESCRIPTION} ${PLAN_TOOL_PROMPT_GUIDELINES.join(" ")}`, /Plan mode|PLAN MODE EXITED|review selector/);
});

test("task widget shows numbered tasks and completion state", () => {
	assert.deepEqual(taskListWidgetLines([
		{ id: 1, title: "Inspect", status: "pending" },
		{ id: 2, title: "Implement", status: "completed" },
		{ id: 3, title: "Verify", status: "in_progress" },
	]), ["Task list · 1/3 complete", "☐ 1. Inspect", "☑ 2. Implement", "◐ 3. Verify"]);
});

test("plan updates summarize changed task lists and checklist steps", () => {
	const previous = {
		name: "initial plan",
		content: "1. Inspect implementation\n2. Implement feature",
		steps: [
			{ id: 1, title: "Inspect", status: "pending" },
			{ id: 2, title: "Implement", status: "pending" },
		],
	};
	const next = {
		name: "revised plan",
		content: "1. Inspect implementation\n2. Implement feature\n3. Validate behavior",
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
	assert.match(summary, /Updated the plan's content/);
	const notice = planUpdateNotice(previous, next);
	assert.match(notice, /PLAN UPDATE CONTEXT/);
	assert.match(notice, /briefly summarize material changes/);
	assert.match(notice, /Do not add this explanation to the saved plan/);
});

test("checklist Markdown is compact and preserves completed step state", () => {
	assert.equal(
		checklistMarkdown("small task", [
			{ id: 1, title: "First", status: "pending" },
			{ id: 2, title: "Second", status: "completed" },
		]),
		"- [ ] 1. First\n- [x] 2. Second",
	);
});
