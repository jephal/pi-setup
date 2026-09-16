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

/**
 * Resolve a tier route against the providers exposed by the active catalog.
 * Tier routes intentionally keep their legacy provider in `modelRoute`; the
 * provider is only a hint because the same logical model ID can be published
 * by another provider (for example, github-copilot).
 */
function resolveAvailableTierRoute(
	routedModel: string,
	parent: { provider?: string },
	availableModels: readonly AvailableModel[],
): string | undefined {
	const separator = routedModel.indexOf("/");
	const routedProvider = separator >= 0 ? routedModel.slice(0, separator) : undefined;
	const modelId = separator >= 0 ? routedModel.slice(separator + 1) : routedModel;

	// Prefer the active provider so the child follows the parent's configured
	// provider when that provider offers the requested logical model.
	if (parent.provider) {
		const parentProviderModel = availableModels.find((model) => model.provider === parent.provider && model.id === modelId);
		if (parentProviderModel) return `${parentProviderModel.provider}/${parentProviderModel.id}`;
	}

	// Preserve the legacy route when its original provider is still available,
	// then accept any other provider exposing the same logical model ID.
	if (routedProvider) {
		const legacyRoute = availableModels.find((model) => model.provider === routedProvider && model.id === modelId);
		if (legacyRoute) return `${legacyRoute.provider}/${legacyRoute.id}`;
	}
	const alternateRoute = availableModels.find((model) => model.id === modelId);
	return alternateRoute ? `${alternateRoute.provider}/${alternateRoute.id}` : undefined;
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
		if (!availableModels) return { model: routedModel, tier, source: "tier" };

		const availableRoute = resolveAvailableTierRoute(routedModel, parent, availableModels);
		if (availableRoute) return { model: availableRoute, tier, source: "tier" };
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
	"Treat complex as a rare exception, not a default: use it only for genuinely ambiguous architecture, security or concurrency risk, difficult debugging, high-cost failure, or a failed medium attempt.",
	"When unsure, choose medium. Do not choose complex merely because a task is long, multi-file, or important; upgrade only the affected step when the evidence justifies it.",
].join(" ");

export const MODEL_ROUTE_SUMMARY = [
	"fast: openai/gpt-5.6-luna",
	"medium: workers openai/gpt-5.6-terra; planners/reviewers anthropic/claude-sonnet-5",
	"complex: workers openai/gpt-5.6-sol; planners/reviewers anthropic/claude-opus-5",
].join("; ");
