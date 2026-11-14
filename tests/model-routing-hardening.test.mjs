import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A separate process and isolated environment; no network calls or real keys.
const dir = mkdtempSync(join(tmpdir(), "crew-routing-"));
process.env.OPENCREWBOT_DATA_DIR = dir;
delete process.env.NEBIUS_API_KEY;
process.env.OPENCREWBOT_OLLAMA_ENABLED = "1";
process.env.OPENCREWBOT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
process.env.OPENCREWBOT_OLLAMA_MODELS = "general-local,code-local,backup-local";
process.env.OPENCREWBOT_OPENAI_COMPATIBLE_BASE_URL = "https://example.invalid/v1";
process.env.OPENCREWBOT_OPENAI_COMPATIBLE_API_KEY = "synthetic-test-key";
process.env.OPENCREWBOT_OPENAI_COMPATIBLE_MODELS = "hosted-test";
const { resolveModelRoutes, classifyTask, validateModelConfig } = await import("../src/lib/server/model-routing.ts");
process.on("exit", () => rmSync(dir, { recursive:true, force:true }));
const config = { providerId:"ollama", primaryModel:"general-local", routingMode:"automatic", fallbackModels:[{providerId:"ollama",model:"code-local",preferredCategory:"coding"},{providerId:"ollama",model:"backup-local"}] };
const bot = (modelConfig = config) => ({model:"legacy-model",modelConfig});

test("automatic routing selects owner-designated coding model, while writing retains the primary", async () => {
  const coding = await resolveModelRoutes(bot(), {instructions:"Review TypeScript code",planningRationale:"Research all choices"});
  assert.deepEqual(coding.map((r) => r.model), ["code-local","general-local","backup-local"]);
  assert.deepEqual(coding.map((r) => r.fallbackAttempt), [0,1,2]);
  assert.match(coding[0].reason,/owner-designated coding/);
  assert.equal((await resolveModelRoutes(bot(), "Write a customer email"))[0].model,"general-local");
  assert.equal(classifyTask({instructions:"Write a customer email",planningRationale:"Search"}),"writing");
});

test("fixed routing ignores category preferences and removes duplicate alternatives", async () => {
  const routes = await resolveModelRoutes(bot({...config,routingMode:"fixed",fallbackModels:[...config.fallbackModels,{providerId:"ollama",model:"code-local"}]}),"Review code");
  assert.deepEqual(routes.map((r) => r.model),["general-local","code-local","backup-local"]);
});

test("unlisted model IDs never dispatch and unknown primary fails clearly", async () => {
  const routes = await resolveModelRoutes(bot({...config,fallbackModels:[{providerId:"ollama",model:"unlisted",preferredCategory:"coding"},...config.fallbackModels]}),"Review code");
  assert.equal(routes.some((r) => r.model === "unlisted"),false);
  await assert.rejects(resolveModelRoutes(bot({...config,primaryModel:"unlisted"}),"Hello"),/primary model is unavailable/);
});

test("local-only model configuration rejects hosted routes and LIVE cannot select MOCK", async () => {
  assert.throws(() => validateModelConfig({...config,localOnly:true,fallbackModels:[{providerId:"openai-compatible",model:"hosted-test"}]}),/hosted fallbacks/);
  assert.throws(() => validateModelConfig({...config,localOnly:true,providerId:"openai-compatible"}),/Ollama primary/);
  assert.throws(() => validateModelConfig({...config,providerId:"mock"}),/live model/);
  assert.throws(() => validateModelConfig({...config,fallbackModels:[{providerId:"mock",model:"mock"}]}),/Fallback model/);
  assert.ok((await resolveModelRoutes(bot({...config,localOnly:true}),"Review code")).every((r) => r.providerId === "ollama"));
});

test("fallback configuration is bounded and rejects invalid task categories", () => {
  assert.throws(() => validateModelConfig({...config,fallbackModels:Array(6).fill({providerId:"ollama",model:"backup-local"})}),/at most five/);
  assert.throws(() => validateModelConfig({...config,fallbackModels:[{providerId:"ollama",model:"backup-local",preferredCategory:"unknown"}]}),/Fallback model/);
});
