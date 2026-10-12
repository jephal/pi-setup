/** Shared model-facing plan text for the primary extension and its standalone fallback. */
export const PLAN_MODE_RESEARCH_GATE =
	"Use Plan mode only after read-only research and discovery are complete enough to make a decision. The saved plan is the final decision and execution contract, not an initial research log, evidence dump, or unresolved question list. If material uncertainty remains, continue research or ask a focused question before creating the plan.";

export const PLAN_MODE_WRITING_STYLE =
	"Full Plan mode plans use decision-first writing: start with `## In short` stating scope, audience, and conclusion plus 3–5 key decisions; follow with `## What happens next`; then cover concise reasoning, alternatives and consequences, trade-offs, and risks; end with the next decision. Use short sections and progressive disclosure, not a wall of text.";

export const PLAN_MODE_TOOL_ACCESS =
	"Plan mode allows read-only context tools such as note listing/search/read, Fovea, Datadog investigation, scheduled-task listing, safe read-only shell inspection, and visualization previews. It does not write notes or memory, change schedules, run Herdr commands, edit project code, write visualization artifacts, or use unsafe shell commands.";

export const VISUALIZATION_ALL_MODE_GUIDANCE =
	"visualize: persistent Excalidraw diagrams belong in Herdr's dedicated visualization-viewer pane, where terminal_viewer open/update/status/close returns compact pane/revision/status acknowledgements; keep Mermaid and preview wireframes in Pi chat. Use the preserved browser viewer only when an external loopback browser URL is explicitly requested; it is non-default and read-only in Review mode. Use artifact only for an explicit project-relative .excalidraw write. No remote or CDN assets are used.";

export const PLAN_MODE_VISUALIZATION_GUIDANCE =
	"In Plan mode, use visualize with action preview only for a bounded Mermaid preview or Excalidraw wireframe in Pi chat. Persistent Herdr pane control, browser viewer startup, and artifact writes are blocked until normal execution. After approval, put persistent diagrams in Herdr with action terminal_viewer; use the preserved browser viewer only for an explicitly requested external loopback URL, and use action artifact only with an explicit project-relative .excalidraw path.";

export const PLAN_UPDATE_RESPONSE_GUIDANCE =
	"After updating an existing plan, do not continue silently: explain to the user what changed, why it changed, and the consequence or next step.";

export const PLAN_BOARD_GUIDANCE =
	"The Plan Board is a derived display of the authoritative Pi plan. Open it explicitly with plan_board action open; use update, status, or close for its fixed display lifecycle. It renders a bounded Markdown projection with shared Pi styling, preserves Mermaid preprocessing and Excalidraw scenes, and falls back to plain lines safely. never use herdr_shell, Notes, or arbitrary commands for the board. Plan and Review may use this fixed display operation, while approval and HITL decisions remain in Pi.";

export const PLAN_TOOL_DESCRIPTION =
	`Mode-sensitive planning tool. In Plan mode, create and refine a full Markdown implementation plan with review and execution checkpoints. Outside Plan mode, create or update only a small-task checklist; do not use it to plan substantial work. Inspect or clear the current branch plan in either mode. ${PLAN_MODE_RESEARCH_GATE} ${PLAN_MODE_WRITING_STYLE} ${PLAN_BOARD_GUIDANCE}`;

export const PLAN_TOOL_PROMPT_SNIPPET =
	"Research first, then use Plan mode for the final decision and execution contract; use only small checklists outside Plan mode";

export const PLAN_TOOL_PROMPT_GUIDELINES = [
	"In Plan mode, use create/update for substantial multi-step work with full Markdown, then wait for the review selector before execution.",
	PLAN_MODE_RESEARCH_GATE,
	PLAN_MODE_WRITING_STYLE,
	PLAN_MODE_TOOL_ACCESS,
	PLAN_MODE_VISUALIZATION_GUIDANCE,
	VISUALIZATION_ALL_MODE_GUIDANCE,
	PLAN_UPDATE_RESPONSE_GUIDANCE,
	PLAN_BOARD_GUIDANCE,
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
