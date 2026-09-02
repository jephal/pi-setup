/** Role-aware model tiers for isolated subagents. */

export const MODEL_TIERS = ["fast", "medium", "complex"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export type ModelResolutionSource = "tier" | "agent" | "parent" | "none";
export type AvailableModel = { provider: string; id: string };

export interface ResolvedAgentModel {
	model?: string;
	tier?: ModelTier;
	source: ModelResolutionSource;
}

const DEFAULT_ROUTES: Record<ModelTier, string> = {
	fast: "openai/gpt-5.6-luna",
	medium: "openai/gpt-5.6-terra",
	complex: "openai/gpt-5.6-sol",
};

const ROLE_ROUTES: Record<string, Partial<Record<ModelTier, string>>> = {
	planner: {
		fast: "openai/gpt-5.6-luna",
		medium: "anthropic/claude-sonnet-5",
		complex: "anthropic/claude-opus-5",
	},
	reviewer: {
		fast: "openai/gpt-5.6-luna",
		medium: "anthropic/claude-sonnet-5",
		complex: "anthropic/claude-opus-5",
	},
};

export function parseModelTier(value: unknown): ModelTier | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return MODEL_TIERS.includes(normalized as ModelTier) ? (normalized as ModelTier) : undefined;
}

export function modelRoute(agentName: string, tier: ModelTier): string {
	return ROLE_ROUTES[agentName]?.[tier] ?? DEFAULT_ROUTES[tier];
}

export function resolveAgentModel(
	agent: { name?: string; model?: string; modelTier?: ModelTier },
	parent: { provider?: string; id?: string },
	overrideTier?: ModelTier,
	availableModels?: readonly AvailableModel[],
): ResolvedAgentModel {
	const tier = overrideTier ?? agent.modelTier;
	if (tier) {
		const routedModel = modelRoute(agent.name ?? "", tier);
		const routeIsAvailable = !availableModels || availableModels.some((model) => `${model.provider}/${model.id}` === routedModel);
		if (routeIsAvailable) return { model: routedModel, tier, source: "tier" };
		if (parent.provider && parent.id) return { model: `${parent.provider}/${parent.id}`, tier, source: "parent" };
		return { model: routedModel, tier, source: "tier" };
	}
	if (agent.model) return { model: agent.model, source: "agent" };
	if (parent.provider && parent.id) return { model: `${parent.provider}/${parent.id}`, source: "parent" };
	return { source: "none" };
}

export const MODEL_SELECTION_GUIDANCE = [
	"Choose fast for reconnaissance, simple searches, short summaries, and clear low-risk tasks.",
	"Choose medium by default for ordinary planning, review, tests, bug fixes, and bounded implementation.",
	"Choose complex only for ambiguous architecture, security or concurrency risk, difficult debugging, high-cost failure, or a failed medium attempt.",
	"When unsure, choose medium. Task length alone is not a reason to choose complex.",
].join(" ");

export const MODEL_ROUTE_SUMMARY = [
	"fast: openai/gpt-5.6-luna",
	"medium: workers openai/gpt-5.6-terra; planners/reviewers anthropic/claude-sonnet-5",
	"complex: workers openai/gpt-5.6-sol; planners/reviewers anthropic/claude-opus-5",
].join("; ");
