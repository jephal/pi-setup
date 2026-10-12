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
	VISUALIZATION_ALL_MODE_GUIDANCE,
	planUpdateNotice,
	summarizePlanChanges,
} from "./plan-text.ts";

test("plan guidance uses bullet main points and numbered tasks with user-led grilling", () => {
	assert.match(PLAN_TOOL_DESCRIPTION, /every approval mode/);
	assert.match(PLAN_TOOL_DESCRIPTION, /under the current mode's existing permissions/);
	assert.match(PLAN_DISCUSSION_GUIDANCE, /do not force a research or grilling session/);
	assert.match(PLAN_DISCUSSION_GUIDANCE, /only when an important unknown blocks/);
	assert.match(PLAN_DISCUSSION_GUIDANCE, /when the user asks to talk the details through/);
	assert.match(PLAN_FORMAT_GUIDANCE, /bullet points for key decisions and main points/);
	assert.match(PLAN_FORMAT_GUIDANCE, /actionable tasks as a short numbered sequence/);
	assert.match(PLAN_FORMAT_GUIDANCE, /Add more bullets or numbered steps when the user asks for detail/);
	assert.match(PLAN_FORMAT_GUIDANCE, /avoid headings and long narrative sections/);
	assert.match(PLAN_CONTEXT_GUIDANCE, /Review mode remains read-only/);
	assert.match(PLAN_TOOL_PROMPT_SNIPPET, /concise bullets for main points and numbered task steps in any mode/);
	assert.match(PLAN_FORMAT_GUIDANCE, /short numbered sequence \(1\., 2\., 3\.\)/);
	assert.match(PLAN_TOOL_PROMPT_GUIDELINES.join(" "), /Review mode remains read-only/);
	assert.match(PLAN_UPDATE_RESPONSE_GUIDANCE, /briefly summarize material changes/);
	assert.match(PLAN_BOARD_GUIDANCE, /authoritative Pi plan/);
	assert.match(VISUALIZATION_ALL_MODE_GUIDANCE, /No remote or CDN assets/);
	assert.doesNotMatch(`${PLAN_TOOL_DESCRIPTION} ${PLAN_TOOL_PROMPT_GUIDELINES.join(" ")}`, /Plan mode|PLAN MODE EXITED|review selector/);
});

test("plan updates summarize changed bullet content and checklist steps", () => {
	const previous = {
		name: "initial plan",
		content: "- Decision: use existing API\n- Inspect implementation",
		steps: [
			{ id: 1, title: "Inspect", status: "pending" },
			{ id: 2, title: "Implement", status: "pending" },
		],
	};
	const next = {
		name: "revised plan",
		content: "- Decision: use existing API\n- Inspect implementation\n- Validate behavior",
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
