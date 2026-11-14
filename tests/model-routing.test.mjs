import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";
import { migrateExecutionSchema } from "../src/lib/server/execution-schema.ts";
import { migrateSchedulerSchema } from "../src/lib/server/scheduler-schema.ts";
import { migrateModelSchema } from "../src/lib/server/model-schema.ts";
import { classifyTask, validateModelConfig } from "../src/lib/server/model-routing.ts";

test("model routing categories and configuration validation are deterministic", () => {
  assert.equal(classifyTask("Fix a TypeScript repository bug"), "coding");
  assert.equal(classifyTask("Write a customer email"), "writing");
  assert.equal(classifyTask("Create a plan with sources"), "research");
  validateModelConfig({ providerId:"nebius", primaryModel:"model", routingMode:"automatic", fallbackModels:[{ providerId:"ollama", model:"local" }], localOnly:false, maxOutputTokens:512 });
  assert.throws(() => validateModelConfig({ providerId:"invalid", primaryModel:"x", routingMode:"fixed" }), /configured provider/);
  assert.throws(() => validateModelConfig({ providerId:"nebius", primaryModel:"x", routingMode:"fixed", maxOutputTokens:0 }), /limits/);
});

test("model usage migration is additive and preserves prior module tables", async (t) => {
  const client = createClient({ url:"file::memory:" }); t.after(() => client.close());
  await client.execute("CREATE TABLE preserved (id TEXT PRIMARY KEY)");
  await migrateExecutionSchema(client); await migrateSchedulerSchema(client); await migrateModelSchema(client); await migrateModelSchema(client);
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const names = new Set(tables.rows.map((row) => row.name));
  assert.ok(names.has("preserved")); assert.ok(names.has("model_usage_records")); assert.ok(names.has("scheduled_workflows"));
});
