/** Shared model-facing plan text for the primary extension and its standalone fallback. */
export const PLAN_MODE_WRITING_STYLE =
	"Full Plan mode plans use decision-first writing: start with `## In short` stating scope, audience, and conclusion plus 3–5 key decisions; follow with `## What happens next`; then cover concise reasoning, alternatives and consequences, trade-offs, and risks; end with the next decision. Use short sections and progressive disclosure, not a wall of text.";

export const PLAN_TOOL_DESCRIPTION =
	`Mode-sensitive planning tool. In Plan mode, create and refine a full Markdown implementation plan with review and execution checkpoints. Outside Plan mode, create or update only a small-task checklist; do not use it to plan substantial work. Inspect or clear the current branch plan in either mode. ${PLAN_MODE_WRITING_STYLE}`;

export const PLAN_TOOL_PROMPT_SNIPPET =
	"Use full plans in Plan mode; use only small checklists outside Plan mode";

export const PLAN_TOOL_PROMPT_GUIDELINES = [
	"In Plan mode, use create/update for substantial multi-step work with full Markdown, then wait for the review selector before execution.",
	PLAN_MODE_WRITING_STYLE,
	"Outside Plan mode, use create/update only for a short checklist for a small task; provide steps and no full Markdown content.",
	"Do not use the outside-Plan-mode checklist as a substitute for planning a substantial task. Enter Plan mode first.",
	"Start full plans with In short (3–5 bullets), then What happens next; put concise technical detail below.",
	"Use status to inspect the active branch plan and clear when work is complete or abandoned.",
	"During approved execution, report each completed checkpoint as [DONE:n] before continuing.",
];

export interface ChecklistStep {
	id: number;
	title: string;
	status: string;
}

export function checklistMarkdown(name: string, steps: readonly ChecklistStep[]): string {
	const items = steps.map((step) => `- [${["complete", "completed", "done"].includes(step.status.trim().toLowerCase()) ? "x" : " "}] ${step.id}. ${step.title}`);
	return `# Checklist: ${name}\n\n${items.join("\n")}`;
}
