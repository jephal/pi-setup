import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCompactionCap,
  applyModelContextCap,
  CAPPED_CONTEXT_WINDOW_TOKENS,
  LARGE_CONTEXT_MODEL_IDS,
  PROVIDER_ID,
  RESPONSE_RESERVE_TOKENS,
} from "./configure-context-cap.mjs";

test("model context cap preserves unrelated provider/model metadata", () => {
  const source = {
    providers: {
      [PROVIDER_ID]: {
        apiKey: "preserve-me",
        modelOverrides: {
          "gpt-6-luna": { name: "Custom Luna", contextWindow: 1_000_000 },
          "other-model": { contextWindow: 256_000 },
        },
      },
      other: { models: [{ id: "small", contextWindow: 128_000 }] },
    },
  };

  const result = applyModelContextCap(source);

  assert.equal(result.providers[PROVIDER_ID].apiKey, "preserve-me");
  assert.equal(result.providers[PROVIDER_ID].modelOverrides["gpt-6-luna"].name, "Custom Luna");
  assert.equal(result.providers[PROVIDER_ID].modelOverrides["gpt-6-luna"].contextWindow, CAPPED_CONTEXT_WINDOW_TOKENS);
  assert.deepEqual(result.providers[PROVIDER_ID].modelOverrides["other-model"], { contextWindow: 256_000 });
  assert.deepEqual(result.providers.other, source.providers.other);
  assert.equal(source.providers[PROVIDER_ID].modelOverrides["gpt-6-luna"].contextWindow, 1_000_000);
  assert.equal(LARGE_CONTEXT_MODEL_IDS.length, 18);
});

test("compaction cap enables auto-compaction and preserves unrelated settings", () => {
  const source = {
    defaultModel: "gpt-6-luna",
    compaction: {
      enabled: false,
      keepRecentTokens: 12_000,
      modelOverrides: {
        "github-copilot/gpt-6-luna": { keepRecentTokens: 8_000, reserveTokens: 100_000 },
        "other-provider/big-model": { reserveTokens: 50_000 },
      },
    },
  };

  const result = applyCompactionCap(source);

  assert.equal(result.defaultModel, "gpt-6-luna");
  assert.equal(result.compaction.enabled, true);
  assert.equal(result.compaction.keepRecentTokens, 12_000);
  assert.deepEqual(result.compaction.modelOverrides["github-copilot/gpt-6-luna"], {
    keepRecentTokens: 8_000,
    reserveTokens: RESPONSE_RESERVE_TOKENS,
  });
  assert.deepEqual(result.compaction.modelOverrides["other-provider/big-model"], { reserveTokens: 50_000 });
  assert.equal(source.compaction.enabled, false);
});

test("applying the cap twice is idempotent", () => {
  const models = applyModelContextCap({});
  const settings = applyCompactionCap({});
  assert.deepEqual(applyModelContextCap(models), models);
  assert.deepEqual(applyCompactionCap(settings), settings);
});

test("invalid existing config shapes are rejected rather than replaced", () => {
  assert.throws(() => applyModelContextCap({ providers: [] }), /providers must be a JSON object/);
  assert.throws(() => applyModelContextCap({ providers: { [PROVIDER_ID]: { modelOverrides: "broken" } } }), /modelOverrides must be a JSON object/);
  assert.throws(() => applyCompactionCap({ compaction: { modelOverrides: null } }), /modelOverrides must be a JSON object/);
});
