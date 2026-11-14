import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";
import { migrateExecutionSchema } from "../src/lib/server/execution-schema.ts";
import { migrateSchedulerSchema } from "../src/lib/server/scheduler-schema.ts";
import { nextWorkflowRun, validateTimezone, validateWorkflowSchedule } from "../src/lib/server/workflow-schedule.ts";

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

test("the occurrence key is a durable single-claim boundary", async (t) => {
  const client = await fixture(t);
  const now = "2026-01-05T00:00:00.000Z";
  await client.execute({ sql: "INSERT INTO scheduled_workflows (id,name,description,objective,plan_json,agent_ids_json,schedule_json,timezone,status,created_at,updated_at,next_run_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", args: ["workflow", "Workflow", "", "Objective", '{"name":"x","tasks":[]}', "[]", '{"kind":"minutes","every":1}', "UTC", "active", now, now, now] });
  const claim = () => client.execute({ sql: "INSERT INTO scheduled_workflow_occurrences (id,workflow_id,occurrence_key,trigger,scheduled_for,status,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(occurrence_key) DO NOTHING RETURNING id", args: [crypto.randomUUID(), "workflow", "automatic:workflow:2026-01-05T00:00:00.000Z", "automatic", now, "claimed", now] });
  const claims = await Promise.all([claim(), claim(), claim()]);
  assert.equal(claims.filter((result) => result.rows.length === 1).length, 1);
  assert.equal(Number((await client.execute("SELECT COUNT(*) AS n FROM scheduled_workflow_occurrences")).rows[0].n), 1);
  await assert.rejects(client.execute({ sql: "INSERT INTO scheduled_workflow_occurrences (id,workflow_id,occurrence_key,trigger,scheduled_for,status,created_at) VALUES (?,?,?,?,?,?,?)", args: [crypto.randomUUID(), "workflow", "manual:other", "manual", now, "claimed", now] }), /UNIQUE constraint failed/);
});
