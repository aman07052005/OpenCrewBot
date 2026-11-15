import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";
import { migrateExecutionSchema } from "../src/lib/server/execution-schema.ts";
import { migrateSchedulerSchema } from "../src/lib/server/scheduler-schema.ts";
import { nextWorkflowRun, validateTimezone, validateWorkflowSchedule } from "../src/lib/server/workflow-schedule.ts";
import { createExecutionRun, getExecutionRun } from "../src/lib/server/execution-engine.ts";
import { validateScheduledWorkflowPlan } from "../src/lib/server/scheduled-workflow-plan.ts";
import { createSingleTaskSchedulePlan, reviseSingleTaskSchedulePlan, scheduledTaskDefaultTimeoutMs } from "../src/lib/shared/scheduled-workflow-plan.ts";

const bot = {
  id: "agent-live", name: "Live Agent", handle: "live-agent", title: "Analyst", description: "", instructions: "", emoji: "", color: "", model: "local-model",
  modelConfig: { providerId: "ollama", primaryModel: "local-model", routingMode: "fixed", localOnly: true },
  tools: { webSearch: false, memory: false, codeMode: false, browser: false, askUser: false }, connections: [], approval: "ask", pinned: false, createdAt: "2026-01-01T00:00:00Z",
};

async function fixture(t) {
  const client = createClient({ url: "file::memory:" });
  await migrateExecutionSchema(client);
  await migrateSchedulerSchema(client);
  t.after(() => client.close());
  return client;
}

test("scheduled-workflow migration is additive and idempotent", async (t) => {
  const client = await fixture(t);
  await client.execute("CREATE TABLE IF NOT EXISTS preserved_module_data (id TEXT PRIMARY KEY)");
  await migrateSchedulerSchema(client);
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const names = new Set(tables.rows.map((row) => row.name));
  assert.ok(names.has("preserved_module_data"));
  assert.ok(names.has("scheduled_workflows"));
  assert.ok(names.has("scheduled_workflow_occurrences"));
  const columns = await client.execute("PRAGMA table_info(execution_runs)");
  assert.ok(columns.rows.some((column) => column.name === "scheduled_workflow_id"));
  assert.ok(columns.rows.some((column) => column.name === "schedule_trigger"));
});

test("schedule validation accepts the one-minute demo interval and rejects unsafe input", () => {
  assert.deepEqual(validateWorkflowSchedule({ kind: "minutes", every: 1 }), { kind: "minutes", every: 1 });
  assert.deepEqual(validateWorkflowSchedule({ kind: "weekly", day: 1, time: "09:30" }), { kind: "weekly", day: 1, time: "09:30" });
  assert.throws(() => validateWorkflowSchedule({ kind: "minutes", every: 0 }), /Minute interval/);
  assert.throws(() => validateWorkflowSchedule({ kind: "hours", every: 721 }), /Hour interval/);
  assert.throws(() => validateWorkflowSchedule({ kind: "daily", time: "25:00" }), /supported schedule/);
  assert.throws(() => validateTimezone("Not/A_Zone"), /IANA timezone/);
});

test("calendar and interval schedules persist their next execution as UTC", () => {
  const after = new Date("2026-01-05T03:29:30.000Z");
  assert.equal(nextWorkflowRun({ kind: "minutes", every: 1 }, "UTC", after), "2026-01-05T03:30:30.000Z");
  assert.equal(nextWorkflowRun({ kind: "daily", time: "09:00" }, "Asia/Kolkata", after), "2026-01-05T03:30:00.000Z");
  assert.equal(nextWorkflowRun({ kind: "weekly", day: 1, time: "09:00" }, "Asia/Kolkata", after), "2026-01-05T03:30:00.000Z");
});

test("single-task schedule creation uses MOCK and LIVE defaults", () => {
  const mock = createSingleTaskSchedulePlan({ name: "Mock schedule", objective: "Summarize locally", agentId: bot.id, executionMode: "mock" });
  const live = createSingleTaskSchedulePlan({ name: "Live schedule", objective: "Use the configured model", agentId: bot.id, executionMode: "live" });
  assert.equal(scheduledTaskDefaultTimeoutMs("mock"), 30_000);
  assert.equal(scheduledTaskDefaultTimeoutMs("live"), 300_000);
  assert.equal(mock.executionMode, "mock"); assert.equal(mock.tasks[0].timeoutMs, 30_000);
  assert.equal(live.executionMode, "live"); assert.equal(live.tasks[0].timeoutMs, 300_000);
});

test("single-task editing updates mode and timeout without mutating the prior plan", () => {
  const original = createSingleTaskSchedulePlan({ name: "Daily summary", objective: "Old objective", agentId: bot.id, executionMode: "mock" });
  const snapshot = structuredClone(original);
  const revised = reviseSingleTaskSchedulePlan(original, { name: "Daily live summary", objective: "New objective", executionMode: "live", timeoutMs: 120_000 });
  assert.deepEqual(original, snapshot);
  assert.equal(revised.executionMode, "live"); assert.equal(revised.tasks[0].timeoutMs, 120_000);
  assert.equal(revised.tasks[0].input, "New objective"); assert.equal(revised.tasks[0].agentId, bot.id);
});

test("multi-task plans cannot be silently replaced by the single-task editor", () => {
  const plan = { name: "Pipeline", executionMode: "live", concurrencyLimit: 2, tasks: [
    { key: "one", title: "One", agentId: bot.id, input: "First", timeoutMs: 80_000 },
    { key: "two", title: "Two", agentId: bot.id, input: "Second", dependsOn: ["one"], timeoutMs: 90_000 },
  ] };
  const snapshot = structuredClone(plan);
  assert.throws(() => reviseSingleTaskSchedulePlan(plan, { name: "Changed", objective: "Changed", executionMode: "mock", timeoutMs: 30_000 }), /preserved unchanged/);
  assert.deepEqual(plan, snapshot);
});

test("LIVE validation and execution-run creation propagate mode and timeout", async (t) => {
  const client = await fixture(t); let validations = 0;
  const plan = createSingleTaskSchedulePlan({ name: "Live occurrence", objective: "Run inference", agentId: bot.id, executionMode: "live", timeoutMs: 125_000 });
  const validated = await validateScheduledWorkflowPlan(plan, [bot], async (assigned, input) => { validations++; assert.equal(assigned.id, bot.id); assert.equal(input, "Run inference"); });
  assert.equal(validations, 1);
  const run = await createExecutionRun(client, validated.plan);
  const saved = await getExecutionRun(client, run.id);
  assert.equal(saved.executionMode, "live"); assert.equal(saved.tasks[0].timeoutMs, 125_000);
  await assert.rejects(validateScheduledWorkflowPlan(plan, [bot], async () => { throw new Error("No configured, allowlisted live model satisfies this agent's settings."); }), /cannot run LIVE.*No configured/);
  await assert.rejects(validateScheduledWorkflowPlan({ ...plan, tasks: [{ ...plan.tasks[0], externalAction: { operation: "github.public.read", arguments: { operation: "metadata", repository: "openai/openai-node" } } }] }, [bot], async () => ({})), /cannot schedule an external operation/);
});

test("the occurrence key is a durable single-claim boundary", async (t) => {
  const client = await fixture(t);
  const now = "2026-01-05T00:00:00.000Z";
  await client.execute({ sql: "INSERT INTO scheduled_workflows (id,name,description,objective,plan_json,agent_ids_json,schedule_json,timezone,status,created_at,updated_at,next_run_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", args: ["workflow", "Workflow", "", "Objective", '{"name":"x","tasks":[]}', "[]", '{"kind":"minutes","every":1}', "UTC", "active", now, now, now] });
  const claim = () => client.execute({ sql: "INSERT INTO scheduled_workflow_occurrences (id,workflow_id,occurrence_key,trigger,scheduled_for,status,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(occurrence_key) DO NOTHING RETURNING id", args: [crypto.randomUUID(), "workflow", "automatic:workflow:2026-01-05T00:00:00.000Z", "automatic", now, "claimed", now] });
  const claims = await Promise.all([claim(), claim(), claim()]);
  assert.equal(claims.filter((result) => result.rows.length === 1).length, 1);
  assert.equal(Number((await client.execute("SELECT COUNT(*) AS n FROM scheduled_workflow_occurrences")).rows[0].n), 1);
  await client.execute({ sql: "UPDATE scheduled_workflows SET plan_json=?,updated_at=? WHERE id=?", args: [JSON.stringify(createSingleTaskSchedulePlan({ name: "Edited", objective: "Live", agentId: bot.id, executionMode: "live", timeoutMs: 60_000 })), new Date().toISOString(), "workflow"] });
  assert.equal(Number((await client.execute("SELECT COUNT(*) AS n FROM scheduled_workflow_occurrences WHERE workflow_id='workflow'")).rows[0].n), 1, "editing a plan preserves occurrence history");
  await assert.rejects(client.execute({ sql: "INSERT INTO scheduled_workflow_occurrences (id,workflow_id,occurrence_key,trigger,scheduled_for,status,created_at) VALUES (?,?,?,?,?,?,?)", args: [crypto.randomUUID(), "workflow", "manual:other", "manual", now, "claimed", now] }), /UNIQUE constraint failed/);
});
