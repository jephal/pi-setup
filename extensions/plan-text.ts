/** Shared model-facing plan text for the primary extension and its standalone fallback. */
export const PLAN_TOOL_DESCRIPTION =
	"Create, update, inspect, or clear a Markdown implementation plan scoped to the current Git branch.";

export const PLAN_TOOL_PROMPT_SNIPPET =
	"Plan substantial multi-step work with tracked checkpoints";

export const PLAN_TOOL_PROMPT_GUIDELINES = [
	"Use create for substantial multi-step changes; handle small, localized work directly.",
	"Start with In short (3–7 bullets), then What happens next; put concise technical detail below.",
	"Use update for feedback and include structured steps on create/update for checkpoints.",
	"Use status to inspect the active branch plan and clear when work is complete or abandoned.",
	"During approved execution, report each completed checkpoint as [DONE:n] before continuing.",
];
