import assert from "node:assert/strict";
import test from "node:test";
import { estimatedCost, extractProviderUsage, globalProviderRoute, isTransientModelError } from "../src/lib/server/provider-runtime.ts";
import { validateModelConfig } from "../src/lib/server/model-routing.ts";

test("provider usage extraction accepts AgentController cumulative fields without inventing values", () => {
  assert.deepEqual(extractProviderUsage({ promptTokens: 12, completionTokens: 8, totalTokens: 20, cachedInputTokens: 3, reasoningTokens: 2 }), { inputTokens:12, outputTokens:8, totalTokens:20, cachedInputTokens:3, reasoningTokens:2 });
  assert.deepEqual(extractProviderUsage({ promptTokens: -1, completionTokens: 1.5 }), { inputTokens:null, outputTokens:null, totalTokens:null, cachedInputTokens:null, reasoningTokens:null });
  assert.deepEqual(extractProviderUsage({ promptTokens: 12 }), { inputTokens:12, outputTokens:null, totalTokens:null, cachedInputTokens:null, reasoningTokens:null });
});

test("cost accounting distinguishes configured pricing, local inference, and unknown usage", async () => {
  const oldIn = process.env.OPENCREWBOT_OPENAI_COMPATIBLE_INPUT_PER_M; const oldOut = process.env.OPENCREWBOT_OPENAI_COMPATIBLE_OUTPUT_PER_M;
  process.env.OPENCREWBOT_OPENAI_COMPATIBLE_INPUT_PER_M = "2"; process.env.OPENCREWBOT_OPENAI_COMPATIBLE_OUTPUT_PER_M = "4";
  try {
    assert.deepEqual(await estimatedCost({ providerId:"openai-compatible", model:"controlled", category:"general", reason:"test", fallbackAttempt:0 }, { inputTokens:1_000_000, outputTokens:500_000, totalTokens:1_500_000, cachedInputTokens:null, reasoningTokens:null }), { cost:4, pricingVersion:"owner-configured" });
    assert.deepEqual(await estimatedCost({ providerId:"ollama", model:"local", category:"general", reason:"test", fallbackAttempt:0 }, { inputTokens:1, outputTokens:1, totalTokens:2, cachedInputTokens:null, reasoningTokens:null }), { cost:null, pricingVersion:null });
    assert.deepEqual(await estimatedCost({ providerId:"openai-compatible", model:"controlled", category:"general", reason:"test", fallbackAttempt:0 }, { inputTokens:null, outputTokens:null, totalTokens:null, cachedInputTokens:null, reasoningTokens:null }), { cost:null, pricingVersion:null });
  } finally { if (oldIn === undefined) delete process.env.OPENCREWBOT_OPENAI_COMPATIBLE_INPUT_PER_M; else process.env.OPENCREWBOT_OPENAI_COMPATIBLE_INPUT_PER_M = oldIn; if (oldOut === undefined) delete process.env.OPENCREWBOT_OPENAI_COMPATIBLE_OUTPUT_PER_M; else process.env.OPENCREWBOT_OPENAI_COMPATIBLE_OUTPUT_PER_M = oldOut; }
});

test("only transient provider failures are retry candidates", () => {
  assert.equal(isTransientModelError(new Error("HTTP 503 temporarily unavailable")), true);
  assert.equal(isTransientModelError(new Error("HTTP 401 invalid API key")), false);
  assert.equal(isTransientModelError(new Error("HTTP 401 network authorization failed")), false);
});

test("global planner and Agent Factory routes are owner-selected, never model-instruction selected", () => {
  const prior = {
    plannerProvider: process.env.OPENCREWBOT_PLANNER_PROVIDER,
    plannerModel: process.env.OPENCREWBOT_PLANNER_MODEL,
    factoryProvider: process.env.OPENCREWBOT_AGENT_FACTORY_PROVIDER,
    factoryModel: process.env.OPENCREWBOT_AGENT_FACTORY_MODEL,
  };
  process.env.OPENCREWBOT_PLANNER_PROVIDER = "ollama";
  process.env.OPENCREWBOT_PLANNER_MODEL = "planner-local";
  process.env.OPENCREWBOT_AGENT_FACTORY_PROVIDER = "openai-compatible";
  process.env.OPENCREWBOT_AGENT_FACTORY_MODEL = "factory-hosted";
  try {
    assert.deepEqual(globalProviderRoute("planner", "ignored-by-owner"), { providerId:"ollama", model:"planner-local", category:"planning", fallbackAttempt:0, reason:"Owner-selected planner provider." });
    assert.deepEqual(globalProviderRoute("agent-factory", "ignored-by-owner"), { providerId:"openai-compatible", model:"factory-hosted", category:"structured", fallbackAttempt:0, reason:"Owner-selected agent-factory provider." });
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      const env = key === "plannerProvider" ? "OPENCREWBOT_PLANNER_PROVIDER" : key === "plannerModel" ? "OPENCREWBOT_PLANNER_MODEL" : key === "factoryProvider" ? "OPENCREWBOT_AGENT_FACTORY_PROVIDER" : "OPENCREWBOT_AGENT_FACTORY_MODEL";
      if (value === undefined) delete process.env[env]; else process.env[env] = value;
    }
  }
});

test("unsupported hard cost budget is rejected instead of being claimed as enforced", () => {
  assert.throws(() => validateModelConfig({ providerId:"ollama", primaryModel:"local", routingMode:"fixed", maxEstimatedCostUsd: 1 }), /Hard cost budgets/);
});
