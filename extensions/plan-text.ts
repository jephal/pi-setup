/** Shared model-facing plan text for the primary extension and its standalone fallback. */
export const PLAN_DISCUSSION_GUIDANCE =
	"Planning is available in every approval mode. Inspect repository code or documentation when useful, but do not force a research or grilling session for ordinary tasks. Make reasonable assumptions and ask focused questions only when an important unknown blocks useful or safe progress, or when the user asks to talk the details through. If the user wants a grilling session, continue the conversation until aligned before saving the plan.";

export const PLAN_BULLET_GUIDANCE =
	"Saved plans must use bullet points only. Keep them short: key decisions and actionable tasks, with useful file or documentation anchors when they help. Add more bullets when the user asks for detail; do not require headings or long narrative sections.";

export const PLAN_CONTEXT_GUIDANCE =
	`${PLAN_DISCUSSION_GUIDANCE} ${PLAN_BULLET_GUIDANCE} Review mode remains read-only: a saved plan does not authorize implementation or code changes.`;

export const VISUALIZATION_ALL_MODE_GUIDANCE =
	"visualize: persistent Excalidraw diagrams belong in Herdr's dedicated visualization-viewer pane, where terminal_viewer open/update/status/close returns compact pane/revision/status acknowledgements; keep Mermaid and preview wireframes in Pi chat. Use the preserved browser viewer only when an external loopback browser URL is explicitly requested; it is non-default and read-only in Review mode. Use artifact only for an explicit project-relative .excalidraw write. No remote or CDN assets are used.";

export const PLAN_UPDATE_RESPONSE_GUIDANCE =
	"After updating a plan, briefly summarize material changes and the next consequence. Keep that explanation outside the saved plan.";

export const PLAN_BOARD_GUIDANCE =
	"The Plan Board is a derived display of the authoritative Pi plan. Open it explicitly with plan_board action open; use update, status, or close for its fixed display lifecycle. It renders a bounded Markdown projection with shared Pi styling, preserves Mermaid preprocessing and Excalidraw scenes, and falls back to plain lines safely. Never use herdr_shell, Notes, or arbitrary commands for the board. In Review mode, board use remains read-only; approval and HITL decisions remain in Pi.";

export const PLAN_TOOL_DESCRIPTION =
	`Planning tool available in every approval mode. Create or refine a concise plan, then continue under the current mode's existing permissions. Inspect or clear the current branch plan in any mode. ${PLAN_CONTEXT_GUIDANCE} ${VISUALIZATION_ALL_MODE_GUIDANCE} ${PLAN_BOARD_GUIDANCE}`;

export const PLAN_TOOL_PROMPT_SNIPPET =
	"Create short bullet-point plans in any mode; ask questions when important details are unclear or the user wants to talk them through";

export const PLAN_TOOL_PROMPT_GUIDELINES = [
	PLAN_DISCUSSION_GUIDANCE,
	PLAN_BULLET_GUIDANCE,
	VISUALIZATION_ALL_MODE_GUIDANCE,
	PLAN_UPDATE_RESPONSE_GUIDANCE,
	PLAN_BOARD_GUIDANCE,
	"Review mode remains read-only: a saved plan does not authorize implementation or code changes.",
	"For small tasks, a compact checklist is fine. Add useful task steps when checkpoint tracking helps; a concise bullet list alone is enough otherwise.",
	"Use status to inspect the active branch plan and clear when work is complete or abandoned.",
	"During execution, report each completed checkpoint as [DONE:n] before continuing.",
];

export interface ChecklistStep {
	id: number;
	title: string;
	status: string;
}

export function checklistMarkdown(_name: string, steps: readonly ChecklistStep[]): string {
	return steps.map((step) => `- [${["complete", "completed", "done"].includes(step.status.trim().toLowerCase()) ? "x" : " "}] ${step.id}. ${step.title}`).join("\n");
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
		if (!addedSections.length && !removedSections.length) changes.push("Updated the plan's content.");
	}

	return changes.length ? changes.map((change) => `- ${change}`).join("\n") : "- No material changes; the existing plan content and checklist steps are unchanged.";
}

export function planUpdateNotice(previous: PlanChangeSnapshot | undefined, next: PlanChangeSnapshot): string {
	return `[PLAN UPDATE CONTEXT — NOT PLAN CONTENT]\nPlan changes:\n${summarizePlanChanges(previous, next)}\n\n${PLAN_UPDATE_RESPONSE_GUIDANCE} Do not add this explanation to the saved plan.`;
}
