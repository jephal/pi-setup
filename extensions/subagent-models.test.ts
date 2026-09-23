import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_ROUTE_SUMMARY, MODEL_TIERS, THINKING_LEVELS, modelRoute, parseModelTier, parseThinkingLevel, resolveAgentModel, thinkingRoute } from "./subagent/models.ts";

test("model tiers accept only the canonical fast, medium, and complex values", () => {
	assert.deepEqual(MODEL_TIERS, ["fast", "medium", "complex"]);
	assert.equal(parseModelTier(" fast "), "fast");
	assert.equal(parseModelTier("MEDIUM"), "medium");
	assert.equal(parseModelTier("normal"), undefined);
	assert.equal(parseModelTier(undefined), undefined);
});

test("thinking levels accept only canonical values", () => {
	assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	assert.equal(parseThinkingLevel(" high "), "high");
	assert.equal(parseThinkingLevel("MEDIUM"), "medium");
	assert.equal(parseThinkingLevel("normal"), undefined);
	assert.equal(parseThinkingLevel(undefined), undefined);
});

test("each bundled role routes every model tier and thinking level", () => {
	const expected = {
		scout: [
			["openai/gpt-6-luna", "medium"],
			["openai/gpt-6-luna", "high"],
			["openai/gpt-6-luna", "xhigh"],
		],
		planner: [
			["openai/gpt-6-luna", "high"],
			["anthropic/claude-opus-5.5", "low"],
			["anthropic/claude-opus-5.5", "medium"],
		],
		reviewer: [
			["openai/gpt-6-luna", "high"],
			["anthropic/claude-opus-5.5", "low"],
			["anthropic/claude-opus-5.5", "medium"],
		],
		worker: [
			["openai/gpt-6-luna", "high"],
			["openai/gpt-6-sol", "medium"],
			["anthropic/claude-opus-5.5", "medium"],
		],
		"datadog-investigator": [
			["openai/gpt-6-luna", "medium"],
			["openai/gpt-6-luna", "high"],
			["openai/gpt-6-luna", "xhigh"],
		],
	} as const;
	const tiers = ["fast", "medium", "complex"] as const;

	for (const [agent, routes] of Object.entries(expected)) {
		for (const [index, tier] of tiers.entries()) {
			assert.equal(modelRoute(agent, tier), routes[index][0], `${agent} ${tier} model`);
			assert.equal(thinkingRoute(agent, tier), routes[index][1], `${agent} ${tier} thinking`);
		}
	}
	assert.equal(modelRoute("custom", "medium"), "openai/gpt-6-sol");
	assert.equal(thinkingRoute("custom", "medium"), undefined);
	assert.match(MODEL_ROUTE_SUMMARY, /gpt-6-luna/);
});

test("model resolution gives explicit tiers precedence over agent defaults and exact models", () => {
	const planner = { name: "planner", model: "claude-opus-5.5", modelTier: "medium" as const };
	assert.deepEqual(resolveAgentModel(planner, { provider: "openai", id: "gpt-5.6" }), {
		model: "anthropic/claude-opus-5.5",
		tier: "medium",
		source: "tier",
	});
	assert.deepEqual(resolveAgentModel(planner, { provider: "openai", id: "gpt-5.6" }, "complex"), {
		model: "anthropic/claude-opus-5.5",
		tier: "complex",
		source: "tier",
	});
});

test("logical tier routes prefer the parent provider over the legacy provider regardless of catalog order", () => {
	assert.deepEqual(resolveAgentModel({ name: "scout", modelTier: "fast" }, { provider: "github-copilot", id: "gpt-6-luna" }, undefined, [
		{ provider: "openai", id: "gpt-6-luna" },
		{ provider: "github-copilot", id: "gpt-6-luna" },
	]), {
		model: "github-copilot/gpt-6-luna",
		tier: "fast",
		source: "tier",
	});
	assert.deepEqual(resolveAgentModel({ name: "scout", modelTier: "fast" }, { provider: "anthropic", id: "claude-sonnet-5" }, undefined, [
		{ provider: "github-copilot", id: "gpt-6-luna" },
	]), {
		model: "github-copilot/gpt-6-luna",
		tier: "fast",
		source: "tier",
	});
});

test("tier routes fall back to the active parent model when the logical target is unavailable", () => {
	assert.deepEqual(resolveAgentModel({ name: "scout", modelTier: "fast" }, { provider: "github-copilot", id: "gpt-5.6-luna" }, undefined, []), {
		model: "github-copilot/gpt-5.6-luna",
		tier: "fast",
		source: "parent",
	});
	assert.deepEqual(resolveAgentModel({ name: "scout", modelTier: "fast" }, { provider: "github-copilot", id: "gpt-5.6-luna" }, undefined, [
		{ provider: "openai", id: "gpt-6-luna" },
	]), {
		model: "openai/gpt-6-luna",
		tier: "fast",
		source: "tier",
	});
});

test("legacy exact models and parent models remain fallbacks", () => {
	assert.deepEqual(resolveAgentModel({ name: "custom", model: "custom/provider-model" }, { provider: "openai", id: "gpt-5.6" }, undefined, [
		{ provider: "github-copilot", id: "gpt-5.6-sol" },
	]), {
		model: "custom/provider-model",
		source: "agent",
	});
	assert.deepEqual(resolveAgentModel({ name: "custom" }, { provider: "openai", id: "gpt-5.6" }), {
		model: "openai/gpt-5.6",
		source: "parent",
	});
});
