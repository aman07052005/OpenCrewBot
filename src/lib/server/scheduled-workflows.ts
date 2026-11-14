import { randomUUID } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import type { CreateExecutionRunInput, CreateScheduledWorkflowInput, ScheduledOccurrenceStatus, ScheduledWorkflow, ScheduledWorkflowOccurrence } from "@/lib/shared/types";
import { db, listBots } from "./db";
import { createExecutionRun, getExecutionRun, startExecutionRun, validateExecutionRunInput } from "./execution-engine";
import { executionTaskExecutor } from "./execution-adapter";
import { isMock } from "./config";
import { InputError } from "./errors";
import { nextWorkflowRun, validateTimezone, validateWorkflowSchedule } from "./workflow-schedule";
import { EXECUTABLE_SKILL_IDS } from "@/lib/shared/agent-skills";

const iso = (now = new Date()) => now.toISOString();
const text = (value: unknown, label: string, maximum: number, optional = false) => {
  if ((value === undefined || value === "") && optional) return "";
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new InputError(`${label} must be 1–${maximum} characters.`);
  return value.trim();
};
function parse<T>(value: unknown, fallback: T): T { try { return value == null ? fallback : JSON.parse(String(value)) as T; } catch { return fallback; } }

function workflowFrom(row: Record<string, unknown>): ScheduledWorkflow {
  return {
    id: String(row.id), name: String(row.name), description: String(row.description), objective: String(row.objective),
    plan: parse<CreateExecutionRunInput>(row.plan_json, { name: "", tasks: [] }), agentIds: parse<string[]>(row.agent_ids_json, []),
    schedule: validateWorkflowSchedule(parse<unknown>(row.schedule_json, null)), timezone: String(row.timezone), status: String(row.status) as ScheduledWorkflow["status"],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), lastExecutedAt: row.last_executed_at == null ? null : String(row.last_executed_at), nextRunAt: row.next_run_at == null ? null : String(row.next_run_at),
    lastRunStatus: row.last_run_status == null ? null : String(row.last_run_status) as ScheduledWorkflow["lastRunStatus"], lastRunId: row.last_run_id == null ? null : String(row.last_run_id), lastError: row.last_error == null ? null : String(row.last_error),
  };
}
function occurrenceFrom(row: Record<string, unknown>): ScheduledWorkflowOccurrence {
  return { id: String(row.id), workflowId: String(row.workflow_id), trigger: String(row.trigger) as "automatic" | "manual", scheduledFor: String(row.scheduled_for), status: String(row.status) as ScheduledOccurrenceStatus, runId: row.run_id == null ? null : String(row.run_id), createdAt: String(row.created_at), startedAt: row.started_at == null ? null : String(row.started_at), finishedAt: row.finished_at == null ? null : String(row.finished_at), error: row.error == null ? null : String(row.error) };
}

async function validatePlan(plan: unknown): Promise<{ plan: CreateExecutionRunInput; agentIds: string[] }> {
  validateExecutionRunInput(plan as CreateExecutionRunInput);
  const clean = structuredClone(plan as CreateExecutionRunInput);
  const bots = await listBots(); const byId = new Map(bots.map((bot) => [bot.id, bot]));
  for (const task of clean.tasks) {
    const bot = byId.get(task.agentId); if (!bot) throw new InputError(`Task ${task.key} refers to an unknown bot.`);
    if (task.skillId) {
      if (!EXECUTABLE_SKILL_IDS.includes(task.skillId as never) || !bot.agentConfig?.skillIds.includes(task.skillId)) throw new InputError(`Task ${task.key} uses a skill not enabled for its agent.`);
      task.input = { ...(task.input && typeof task.input === "object" ? task.input as Record<string, unknown> : {}), skillId: task.skillId, skillInput: task.skillInput };
    }
  }
  return { plan: clean, agentIds: [...new Set(clean.tasks.map((task) => task.agentId))] };
}

function workflowInput(input: CreateScheduledWorkflowInput, now: Date) {
  const name = text(input.name, "Workflow name", 300);
  const description = input.description === undefined ? "" : text(input.description, "Description", 2_000, true);
  const objective = text(input.objective, "Objective", 12_000);
  const schedule = validateWorkflowSchedule(input.schedule);
  const timezone = validateTimezone(input.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"));
  const active = input.active !== false;
  return { name, description, objective, schedule, timezone, active, now };
}

export async function listScheduledWorkflows(): Promise<ScheduledWorkflow[]> {
  const rows = await (await db()).execute("SELECT * FROM scheduled_workflows ORDER BY created_at DESC");
  return rows.rows.map((row) => workflowFrom(row as Record<string, unknown>));
}
export async function getScheduledWorkflow(id: string): Promise<ScheduledWorkflow | null> {
  const rows = await (await db()).execute({ sql: "SELECT * FROM scheduled_workflows WHERE id=?", args: [id] });
  return rows.rows[0] ? workflowFrom(rows.rows[0] as Record<string, unknown>) : null;
}
export async function scheduledWorkflowOccurrences(id: string, limit = 100): Promise<ScheduledWorkflowOccurrence[]> {
  const safe = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 200)) : 100;
  const rows = await (await db()).execute({ sql: "SELECT * FROM scheduled_workflow_occurrences WHERE workflow_id=? ORDER BY created_at DESC LIMIT ?", args: [id, safe] });
  return rows.rows.map((row) => occurrenceFrom(row as Record<string, unknown>));
}

export async function createScheduledWorkflow(input: CreateScheduledWorkflowInput): Promise<ScheduledWorkflow> {
  const now = new Date(); const clean = workflowInput(input, now); const validated = await validatePlan(input.plan);
  const id = randomUUID(); const nowIso = iso(now); const next = clean.active ? nextWorkflowRun(clean.schedule, clean.timezone, now) : null;
  await (await db()).execute({ sql: `INSERT INTO scheduled_workflows (id,name,description,objective,plan_json,agent_ids_json,schedule_json,timezone,status,created_at,updated_at,next_run_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, args: [id, clean.name, clean.description, clean.objective, JSON.stringify(validated.plan), JSON.stringify(validated.agentIds), JSON.stringify(clean.schedule), clean.timezone, clean.active ? "active" : "paused", nowIso, nowIso, next] });
  return (await getScheduledWorkflow(id))!;
}

export async function updateScheduledWorkflow(id: string, patch: Partial<CreateScheduledWorkflowInput & { active: boolean }>): Promise<ScheduledWorkflow> {
  const current = await getScheduledWorkflow(id); if (!current) throw new InputError("Scheduled workflow not found.");
  const merged = { name: patch.name ?? current.name, description: patch.description ?? current.description, objective: patch.objective ?? current.objective, plan: patch.plan ?? current.plan, schedule: patch.schedule ?? current.schedule, timezone: patch.timezone ?? current.timezone, active: patch.active ?? current.status === "active" };
  const clean = workflowInput(merged, new Date()); const validated = await validatePlan(merged.plan); const now = iso(clean.now);
  const next = clean.active ? nextWorkflowRun(clean.schedule, clean.timezone, clean.now) : null;
  await (await db()).execute({ sql: `UPDATE scheduled_workflows SET name=?,description=?,objective=?,plan_json=?,agent_ids_json=?,schedule_json=?,timezone=?,status=?,updated_at=?,next_run_at=?,last_error=NULL WHERE id=?`, args: [clean.name, clean.description, clean.objective, JSON.stringify(validated.plan), JSON.stringify(validated.agentIds), JSON.stringify(clean.schedule), clean.timezone, clean.active ? "active" : "paused", now, next, id] });
  return (await getScheduledWorkflow(id))!;
}

async function hasOpenOccurrence(client: Client, workflowId: string): Promise<boolean> {
  const rows = await client.execute({ sql: `SELECT 1 FROM scheduled_workflow_occurrences o LEFT JOIN execution_runs r ON r.id=o.run_id WHERE o.workflow_id=? AND (o.status IN ('claimed','creating') OR (o.status='started' AND (r.status IS NULL OR r.status NOT IN ('completed','failed','cancelled')))) LIMIT 1`, args: [workflowId] });
  return Boolean(rows.rows[0]);
}

/** Mirrors run completion into schedule history; no task is replayed here. */
export async function reconcileScheduledWorkflows(client?: Client): Promise<void> {
  const target = client ?? await db();
  const rows = await target.execute({ sql: `SELECT o.*,r.status AS run_status,r.error AS run_error,r.finished_at AS run_finished_at FROM scheduled_workflow_occurrences o JOIN execution_runs r ON r.id=o.run_id WHERE o.status='started' AND r.status IN ('completed','failed','cancelled')`, args: [] });
  for (const raw of rows.rows) {
    const row = raw as Record<string, unknown>; const status = String(row.run_status); const occurrenceStatus = status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed"; const finished = String(row.run_finished_at ?? iso());
    await target.batch([
      { sql: "UPDATE scheduled_workflow_occurrences SET status=?,finished_at=?,error=? WHERE id=? AND status='started'", args: [occurrenceStatus, finished, row.run_error == null ? null : String(row.run_error), String(row.id)] },
      { sql: "UPDATE scheduled_workflows SET last_run_status=?,last_error=?,updated_at=? WHERE id=? AND last_run_id=?", args: [status, row.run_error == null ? null : String(row.run_error), finished, String(row.workflow_id), String(row.run_id)] },
    ], "write");
  }
  // A process crash can leave an occurrence claimed before a run is created. Only stale claims are released.
  const stale = new Date(Date.now() - 5 * 60_000).toISOString();
  await target.execute({ sql: "UPDATE scheduled_workflow_occurrences SET status='claimed' WHERE status='creating' AND started_at<? AND run_id IS NULL", args: [stale] });
  // If a process stopped after persisting its claim but before moving next_run_at,
  // retain the claim and advance the cursor. The occurrence key makes a replay
  // impossible while still allowing the claimed work to be recovered.
  const open = await target.execute({ sql: `SELECT w.* FROM scheduled_workflows w JOIN scheduled_workflow_occurrences o ON o.workflow_id=w.id WHERE o.trigger='automatic' AND o.status IN ('claimed','creating','started') AND w.status='active' AND w.next_run_at<=o.scheduled_for GROUP BY w.id`, args: [] });
  for (const raw of open.rows) {
    const workflow = workflowFrom(raw as Record<string, unknown>);
    await target.execute({ sql: "UPDATE scheduled_workflows SET next_run_at=?,updated_at=? WHERE id=? AND next_run_at<=?", args: [nextWorkflowRun(workflow.schedule, workflow.timezone, new Date()), iso(), workflow.id, workflow.nextRunAt ?? ""] });
  }
}

async function launchOccurrence(client: Client, workflow: ScheduledWorkflow, occurrence: ScheduledWorkflowOccurrence): Promise<void> {
  const claimed = await client.execute({ sql: "UPDATE scheduled_workflow_occurrences SET status='creating',started_at=? WHERE id=? AND status='claimed' AND run_id IS NULL RETURNING id", args: [iso(), occurrence.id] });
  if (!claimed.rows[0]) return;
  try {
    const validated = await validatePlan(workflow.plan);
    if (validated.plan.executionMode === "live" && isMock()) throw new InputError("Scheduled LIVE workflow requires an owner-configured live provider; no mock fallback was used.");
    const run = await createExecutionRun(client, validated.plan, (runId): InStatement[] => [
      { sql: "UPDATE execution_runs SET scheduled_workflow_id=?,schedule_trigger=? WHERE id=?", args: [workflow.id, occurrence.trigger, runId] },
      { sql: "UPDATE scheduled_workflow_occurrences SET status='started',run_id=? WHERE id=? AND status='creating'", args: [runId, occurrence.id] },
      { sql: "UPDATE scheduled_workflows SET last_executed_at=?,last_run_id=?,last_run_status='pending',last_error=NULL,updated_at=? WHERE id=?", args: [iso(), runId, iso(), workflow.id] },
    ]);
    await startExecutionRun(client, run.id, executionTaskExecutor(run.executionMode));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client.batch([
      { sql: "UPDATE scheduled_workflow_occurrences SET status='failed',finished_at=?,error=? WHERE id=? AND run_id IS NULL", args: [iso(), message.slice(0, 2_000), occurrence.id] },
      { sql: "UPDATE scheduled_workflows SET last_error=?,last_run_status='failed',updated_at=? WHERE id=?", args: [message.slice(0, 2_000), iso(), workflow.id] },
    ], "write");
  }
}

async function claimAutomatic(client: Client, workflow: ScheduledWorkflow, now: Date): Promise<ScheduledWorkflowOccurrence | null> {
  if (!workflow.nextRunAt || await hasOpenOccurrence(client, workflow.id)) return null;
  const scheduledFor = workflow.nextRunAt; const occurrence: ScheduledWorkflowOccurrence = { id: randomUUID(), workflowId: workflow.id, trigger: "automatic", scheduledFor, status: "claimed", runId: null, createdAt: iso(now), startedAt: null, finishedAt: null, error: null };
  const inserted = await client.execute({ sql: `INSERT INTO scheduled_workflow_occurrences (id,workflow_id,occurrence_key,trigger,scheduled_for,status,created_at)
    VALUES (?,?,?,?,?,'claimed',?) ON CONFLICT(occurrence_key) DO NOTHING RETURNING id`, args: [occurrence.id, workflow.id, `automatic:${workflow.id}:${scheduledFor}`, "automatic", scheduledFor, occurrence.createdAt] });
  if (!inserted.rows[0]) return null;
  const next = nextWorkflowRun(workflow.schedule, workflow.timezone, now); // coalesces all missed intervals into one run.
  await client.execute({ sql: "UPDATE scheduled_workflows SET next_run_at=?,updated_at=? WHERE id=? AND status='active' AND next_run_at=?", args: [next, iso(now), workflow.id, scheduledFor] });
  return occurrence;
}

/** A persisted claim without a run is safe to resume after a process restart.
 * `launchOccurrence` changes it to `creating` conditionally, so another worker
 * cannot launch the same claim at the same time. */
async function recoverableClaim(client: Client, workflowId: string): Promise<ScheduledWorkflowOccurrence | null> {
  const rows = await client.execute({ sql: "SELECT * FROM scheduled_workflow_occurrences WHERE workflow_id=? AND status='claimed' AND run_id IS NULL ORDER BY created_at LIMIT 1", args: [workflowId] });
  return rows.rows[0] ? occurrenceFrom(rows.rows[0] as Record<string, unknown>) : null;
}

export async function tickScheduledWorkflows(now = new Date()): Promise<void> {
  const client = await db(); await reconcileScheduledWorkflows(client);
  const due = await client.execute({ sql: "SELECT * FROM scheduled_workflows WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at LIMIT 100", args: [iso(now)] });
  for (const raw of due.rows) {
    const workflow = workflowFrom(raw as Record<string, unknown>);
    const occurrence = await recoverableClaim(client, workflow.id) ?? await claimAutomatic(client, workflow, now);
    if (occurrence) void launchOccurrence(client, workflow, occurrence);
  }
}

export async function runScheduledWorkflowNow(id: string): Promise<ScheduledWorkflowOccurrence> {
  const client = await db(); await reconcileScheduledWorkflows(client); const workflow = await getScheduledWorkflow(id); if (!workflow) throw new InputError("Scheduled workflow not found.");
  if (await hasOpenOccurrence(client, id)) throw new InputError("This workflow already has an active occurrence; overlapping runs are disabled.");
  const now = new Date(); const occurrence: ScheduledWorkflowOccurrence = { id: randomUUID(), workflowId: id, trigger: "manual", scheduledFor: iso(now), status: "claimed", runId: null, createdAt: iso(now), startedAt: null, finishedAt: null, error: null };
  await client.execute({ sql: "INSERT INTO scheduled_workflow_occurrences (id,workflow_id,occurrence_key,trigger,scheduled_for,status,created_at) VALUES (?,?,?,?,?,'claimed',?)", args: [occurrence.id, id, `manual:${occurrence.id}`, "manual", occurrence.scheduledFor, occurrence.createdAt] });
  void launchOccurrence(client, workflow, occurrence);
  return occurrence;
}

export async function scheduledWorkflowRun(id: string) { const workflow = await getScheduledWorkflow(id); if (!workflow) throw new InputError("Scheduled workflow not found."); return workflow.lastRunId ? getExecutionRun(await db(), workflow.lastRunId) : null; }
