/** Shared model-facing plan text for the primary extension and its standalone fallback. */
export const PLAN_MODE_RESEARCH_GATE =
	"Use Plan mode only after read-only research and discovery are complete enough to make a decision. The saved plan is the final decision and execution contract, not an initial research log, evidence dump, or unresolved question list. If material uncertainty remains, continue research or ask a focused question before creating the plan.";

export const PLAN_MODE_WRITING_STYLE =
	"Full Plan mode plans use decision-first writing: start with `## In short` stating scope, audience, and conclusion plus 3–5 key decisions; follow with `## What happens next`; then cover concise reasoning, alternatives and consequences, trade-offs, and risks; end with the next decision. Use short sections and progressive disclosure, not a wall of text.";

export const PLAN_MODE_TOOL_ACCESS =
	"Plan mode allows non-code-changing context tools such as notes, memory, Fovea, Herdr inspection, Datadog investigation, scheduled tasks, and safe read-only shell commands. Do not edit project code or use unsafe shell commands.";

export const PLAN_UPDATE_RESPONSE_GUIDANCE =
	"After updating an existing plan, do not continue silently: explain to the user what changed, why it changed, and the consequence or next step.";

export const PLAN_TOOL_DESCRIPTION =
	`Mode-sensitive planning tool. In Plan mode, create and refine a full Markdown implementation plan with review and execution checkpoints. Outside Plan mode, create or update only a small-task checklist; do not use it to plan substantial work. Inspect or clear the current branch plan in either mode. ${PLAN_MODE_RESEARCH_GATE} ${PLAN_MODE_WRITING_STYLE}`;

export const PLAN_TOOL_PROMPT_SNIPPET =
	"Research first, then use Plan mode for the final decision and execution contract; use only small checklists outside Plan mode";

export const PLAN_TOOL_PROMPT_GUIDELINES = [
	"In Plan mode, use create/update for substantial multi-step work with full Markdown, then wait for the review selector before execution.",
	PLAN_MODE_RESEARCH_GATE,
	PLAN_MODE_WRITING_STYLE,
	PLAN_MODE_TOOL_ACCESS,
	PLAN_UPDATE_RESPONSE_GUIDANCE,
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

export interface PlanChangeSnapshot {
	name: string;
	content: string;
	steps: readonly ChecklistStep[];
}

function listChanges(values: string[]): string {
	const limited = values.slice(0, 4);
	return `${limited.join(", ")}${values.length > limited.length ? `, and ${values.length - limited.length} more` : ""}`;
}

function sectionHeadings(content: string): Set<string> {
	return new Set(
		[...content.matchAll(/^#{1,6}\s+(.+)$/gm)]
			.map((match) => match[1].trim())
			.filter(Boolean),
	);
}

export function summarizePlanChanges(previous: PlanChangeSnapshot | undefined, next: PlanChangeSnapshot): string {
	if (!previous) return "- Created the initial plan; there was no earlier version to compare.";

	const changes: string[] = [];
	if (previous.name !== next.name) changes.push(`Renamed the plan from ${JSON.stringify(previous.name)} to ${JSON.stringify(next.name)}.`);

	const previousSteps = new Map(previous.steps.map((step) => [step.id, step]));
	const nextSteps = new Map(next.steps.map((step) => [step.id, step]));
	const added = [...nextSteps.values()].filter((step) => !previousSteps.has(step.id)).map((step) => `${step.id}. ${step.title}`);
	const removed = [...previousSteps.values()].filter((step) => !nextSteps.has(step.id)).map((step) => `${step.id}. ${step.title}`);
	const changed = [...nextSteps.values()]
		.filter((step) => {
			const prior = previousSteps.get(step.id);
			return prior && (prior.title !== step.title || prior.status !== step.status);
		})
		.map((step) => {
			const prior = previousSteps.get(step.id)!;
			const details = prior.title !== step.title ? "title" : "status";
			return `${step.id} (${details})`;
		});
	if (added.length) changes.push(`Added checklist steps: ${listChanges(added)}.`);
	if (removed.length) changes.push(`Removed checklist steps: ${listChanges(removed)}.`);
	if (changed.length) changes.push(`Changed checklist steps: ${listChanges(changed)}.`);

	if (previous.content !== next.content) {
		const previousSections = sectionHeadings(previous.content);
		const nextSections = sectionHeadings(next.content);
		const addedSections = [...nextSections].filter((section) => !previousSections.has(section));
		const removedSections = [...previousSections].filter((section) => !nextSections.has(section));
		if (addedSections.length) changes.push(`Added plan sections: ${listChanges(addedSections)}.`);
		if (removedSections.length) changes.push(`Removed plan sections: ${listChanges(removedSections)}.`);
		if (!addedSections.length && !removedSections.length) changes.push("Updated the plan's rationale or supporting details.");
	}

	return changes.length ? changes.map((change) => `- ${change}`).join("\n") : "- No material changes; the existing plan content and checklist steps are unchanged.";
}

export function planUpdateNotice(previous: PlanChangeSnapshot | undefined, next: PlanChangeSnapshot): string {
	return `[PLAN UPDATE CONTEXT — NOT PLAN CONTENT]\nPlan changes:\n${summarizePlanChanges(previous, next)}\n\n${PLAN_UPDATE_RESPONSE_GUIDANCE} Do not add this explanation to the saved plan.`;
}
