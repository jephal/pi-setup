import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_ROUTE_SUMMARY, MODEL_TIERS, modelRoute, parseModelTier, resolveAgentModel } from "./subagent/models.ts";

test("model tiers accept only the canonical fast, medium, and complex values", () => {
	assert.deepEqual(MODEL_TIERS, ["fast", "medium", "complex"]);
	assert.equal(parseModelTier(" fast "), "fast");
	assert.equal(parseModelTier("MEDIUM"), "medium");
	assert.equal(parseModelTier("normal"), undefined);
	assert.equal(parseModelTier(undefined), undefined);
});

test("role-aware routes use cheaper defaults and stronger escalation routes", () => {
	assert.equal(modelRoute("scout", "fast"), "openai/gpt-5.6-luna");
	assert.equal(modelRoute("worker", "medium"), "openai/gpt-5.6-terra");
	assert.equal(modelRoute("worker", "complex"), "openai/gpt-5.6-sol");
	assert.equal(modelRoute("planner", "medium"), "anthropic/claude-sonnet-5");
	assert.equal(modelRoute("reviewer", "complex"), "anthropic/claude-opus-5");
	assert.match(MODEL_ROUTE_SUMMARY, /gpt-5\.6-luna/);
});

test("model resolution gives explicit tiers precedence over agent defaults and exact models", () => {
	const planner = { name: "planner", model: "claude-opus-5", modelTier: "medium" as const };
	assert.deepEqual(resolveAgentModel(planner, { provider: "openai", id: "gpt-5.6" }), {
		model: "anthropic/claude-sonnet-5",
		tier: "medium",
		source: "tier",
	});
	assert.deepEqual(resolveAgentModel(planner, { provider: "openai", id: "gpt-5.6" }, "complex"), {
		model: "anthropic/claude-opus-5",
		tier: "complex",
		source: "tier",
	});
});

test("legacy exact models and parent models remain fallbacks", () => {
	assert.deepEqual(resolveAgentModel({ name: "custom", model: "custom/provider-model" }, { provider: "openai", id: "gpt-5.6" }), {
		model: "custom/provider-model",
		source: "agent",
	});
	assert.deepEqual(resolveAgentModel({ name: "custom" }, { provider: "openai", id: "gpt-5.6" }), {
		model: "openai/gpt-5.6",
		source: "parent",
	});
});
