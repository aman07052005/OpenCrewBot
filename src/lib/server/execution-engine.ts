import { randomUUID } from "node:crypto";
import { mockCollaborationOutput } from "./collaboration-protocol.ts";
import type { Client, InStatement } from "@libsql/client";
import type { CreateExecutionRunInput, ExecutionDependencyOutput, ExecutionMode, ExecutionRun, ExecutionTask, ExecutionTaskStatus, ExecutionRunStatus } from "@/lib/shared/types";
import { EXECUTABLE_SKILL_IDS } from "../shared/agent-skills.ts";
import { validateSkillInput } from "./skills.ts";

export type { CreateExecutionRunInput, ExecutionMode, ExecutionRun, ExecutionTask, ExecutionTaskInput } from "@/lib/shared/types";
export type RunStatus = ExecutionRunStatus;
export type TaskStatus = ExecutionTaskStatus;

export type { ExecutionDependencyOutput } from "@/lib/shared/types";

export interface TaskExecutor {
  /** Retries are only enabled when an executor guarantees idempotent effects. */
  retrySafety: "idempotent" | "never";
  execute: (task: ExecutionTask, context: { signal: AbortSignal; idempotencyKey: string; dependencies: ExecutionDependencyOutput[] }) => Promise<unknown>;
}

const TERMINAL_TASKS = ["succeeded", "failed", "cancelled", "skipped"] as const;
const TERMINAL_RUNS = ["completed", "failed", "cancelled"] as const;
const MAX_TASKS = 100;
const MAX_TITLE_LENGTH = 300;
const g = globalThis as unknown as {
  __opencrewbotExecutionJobs?: Map<string, Promise<void>>;
  __opencrewbotExecutionControllers?: Map<string, AbortController>;
};
const jobs = (g.__opencrewbotExecutionJobs ??= new Map());
const controllers = (g.__opencrewbotExecutionControllers ??= new Map());

function str(value: unknown): string { return String(value ?? ""); }
function nullable(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function number(value: unknown): number { return Number(value ?? 0); }
function bool(value: unknown): boolean { return Number(value) === 1; }
function json(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  return JSON.parse(String(value)) as unknown;
}
function isoNow(): string { return new Date().toISOString(); }

export function validateExecutionRunInput(input: CreateExecutionRunInput): void {
  if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > MAX_TITLE_LENGTH) throw new Error("Run name must be 1–300 characters.");
  const concurrency = input.concurrencyLimit ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("Concurrency limit must be between 1 and 32.");
  if (input.executionMode !== undefined && input.executionMode !== "mock" && input.executionMode !== "live") throw new Error("executionMode must be 'mock' or 'live'.");
  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > MAX_TASKS) throw new Error(`A run must contain between 1 and ${MAX_TASKS} tasks.`);

  const keys = new Set<string>();
  for (const task of input.tasks) {
    if (!task || typeof task.key !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(task.key) || keys.has(task.key)) throw new Error("Task keys must be unique and contain 1–80 letters, numbers, underscores or hyphens.");
    keys.add(task.key);
    if (typeof task.title !== "string" || !task.title.trim() || task.title.length > MAX_TITLE_LENGTH) throw new Error(`Task ${task.key} needs a title of 1–${MAX_TITLE_LENGTH} characters.`);
    if (typeof task.agentId !== "string" || !task.agentId.trim() || task.agentId.length > 200) throw new Error(`Task ${task.key} needs an assigned agentId.`);
    if (task.skillId !== undefined) {
      if (!EXECUTABLE_SKILL_IDS.includes(task.skillId as never)) throw new Error(`Task ${task.key} refers to an unknown executable skill.`);
      try { validateSkillInput(task.skillId as never, task.skillInput); } catch (error) { throw new Error(`Task ${task.key} has invalid skill input: ${error instanceof Error ? error.message : "validation failed"}`); }
    }
    if (task.maxAttempts !== undefined && (!Number.isInteger(task.maxAttempts) || task.maxAttempts < 1 || task.maxAttempts > 10)) throw new Error("maxAttempts must be between 1 and 10.");
    if (task.timeoutMs !== undefined && (!Number.isInteger(task.timeoutMs) || task.timeoutMs < 10 || task.timeoutMs > 300_000)) throw new Error("timeoutMs must be between 10 and 300000.");
    if (task.dependsOn && (!Array.isArray(task.dependsOn) || new Set(task.dependsOn).size !== task.dependsOn.length)) throw new Error(`Task ${task.key} has invalid or duplicate dependencies.`);
  }

  const byKey = new Map(input.tasks.map((task) => [task.key, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error("Task dependencies contain a circular dependency.");
    if (visited.has(key)) return;
    const task = byKey.get(key);
    if (!task) throw new Error(`Unknown task dependency: ${key}.`);
    visiting.add(key);
    for (const dep of task.dependsOn ?? []) {
      if (dep === key || !byKey.has(dep)) throw new Error(`Task ${key} has an invalid dependency: ${dep}.`);
      visit(dep);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const task of input.tasks) visit(task.key);
  if (input.originalInstruction !== undefined && (typeof input.originalInstruction !== "string" || !input.originalInstruction.trim() || input.originalInstruction.length > 12_000)) {
    throw new Error("Original instruction must be 1–12000 characters.");
  }
  if (input.planningRationale !== undefined && (typeof input.planningRationale !== "string" || !input.planningRationale.trim() || input.planningRationale.length > 8_000)) {
    throw new Error("Planning rationale must be 1–8000 characters.");
  }
  if (input.planningMode !== undefined && input.planningMode !== "mock" && input.planningMode !== "live") throw new Error("planningMode must be 'mock' or 'live'.");
}

function runFrom(row: Record<string, unknown>): ExecutionRun {
  return {
    id: str(row.id), name: str(row.name), status: str(row.status) as RunStatus,
    concurrencyLimit: number(row.concurrency_limit), createdAt: str(row.created_at), updatedAt: str(row.updated_at),
    startedAt: nullable(row.started_at), finishedAt: nullable(row.finished_at), error: nullable(row.error),
    executionMode: str(row.execution_mode ?? "mock") as ExecutionMode,
    originalInstruction: nullable(row.original_instruction),
    planningRationale: nullable(row.planning_rationale),
    planningMode: row.planning_mode === null || row.planning_mode === undefined ? null : str(row.planning_mode) as ExecutionMode,
  };
}

function taskFrom(row: Record<string, unknown>, dependencies: string[] = []): ExecutionTask {
  return {
    id: str(row.id), runId: str(row.run_id), title: str(row.title), agentId: str(row.agent_id),
    status: str(row.status) as TaskStatus, requiresApproval: bool(row.requires_approval), approvedAt: nullable(row.approved_at),
    dependencies, input: json(row.input_json), output: json(row.output_json), error: nullable(row.error),
    attempts: number(row.attempts), maxAttempts: number(row.max_attempts), timeoutMs: number(row.timeout_ms),
    createdAt: str(row.created_at), updatedAt: str(row.updated_at), startedAt: nullable(row.started_at), finishedAt: nullable(row.finished_at),
  };
}

async function dependenciesFor(client: Client, taskId: string): Promise<string[]> {
  const res = await client.execute({ sql: "SELECT depends_on_task_id FROM execution_task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id", args: [taskId] });
  return res.rows.map((row) => str(row.depends_on_task_id));
}

async function dependencyOutputsFor(client: Client, taskId: string): Promise<ExecutionDependencyOutput[]> {
  const res = await client.execute({
    sql: `SELECT dep.id,dep.title,dep.agent_id,dep.output_json
          FROM execution_task_dependencies d JOIN execution_tasks dep ON dep.id=d.depends_on_task_id
          WHERE d.task_id=? ORDER BY dep.created_at,dep.id`,
    args: [taskId],
  });
  return res.rows.map((row) => ({ taskId: str(row.id), title: str(row.title), agentId: str(row.agent_id), output: json(row.output_json) }));
}

export async function createExecutionRun(client: Client, input: CreateExecutionRunInput, linkedStatements?: (runId: string) => InStatement[]): Promise<ExecutionRun> {
  validateExecutionRunInput(input);
  const id = randomUUID();
  const now = isoNow();
  const idsByKey = new Map(input.tasks.map((task) => [task.key, randomUUID()]));
  const statements: InStatement[] = [
    { sql: "INSERT INTO execution_runs (id,name,status,concurrency_limit,execution_mode,original_instruction,planning_rationale,planning_mode,created_at,updated_at) VALUES (?,?, 'pending',?,?,?,?,?,?,?)", args: [id, input.name.trim(), input.concurrencyLimit ?? 3, input.executionMode ?? "mock", input.originalInstruction ?? null, input.planningRationale ?? null, input.planningMode ?? null, now, now] },
  ];
  for (const task of input.tasks) {
    const taskId = idsByKey.get(task.key)!;
    statements.push({
      sql: `INSERT INTO execution_tasks (id,run_id,title,agent_id,status,requires_approval,input_json,attempts,max_attempts,timeout_ms,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [taskId, id, task.title.trim(), task.agentId.trim(), task.requiresApproval ? "blocked" : "pending", task.requiresApproval ? 1 : 0, JSON.stringify(task.input ?? null), 0, task.maxAttempts ?? 2, task.timeoutMs ?? 30_000, now, now],
    });
    for (const dep of task.dependsOn ?? []) statements.push({
      sql: "INSERT INTO execution_task_dependencies (run_id,task_id,depends_on_task_id) VALUES (?,?,?)",
      args: [id, taskId, idsByKey.get(dep)!],
    });
  }
  if (linkedStatements) statements.push(...linkedStatements(id));
  await client.batch(statements, "write");
  return (await getExecutionRun(client, id))!;
}

export async function listExecutionRuns(client: Client, limit = 100, offset = 0, before?: { createdAt: string; id: string }): Promise<ExecutionRun[]> {
  const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 200)) : 100;
  const safeOffset = Number.isInteger(offset) ? Math.max(0, offset) : 0;
  const hasCursor = Boolean(before?.createdAt && before.id);
  const sql = hasCursor
    ? "SELECT * FROM execution_runs WHERE (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?"
    : "SELECT * FROM execution_runs ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?";
  const args = hasCursor ? [before!.createdAt, before!.createdAt, before!.id, safeLimit, safeOffset] : [safeLimit, safeOffset];
  const res = await client.execute({ sql, args });
  return res.rows.map((row) => runFrom(row as Record<string, unknown>));
}

export async function getExecutionRun(client: Client, id: string): Promise<ExecutionRun | null> {
  const res = await client.execute({ sql: "SELECT * FROM execution_runs WHERE id = ?", args: [id] });
  if (!res.rows[0]) return null;
  const run = runFrom(res.rows[0] as Record<string, unknown>);
  const tasks = await client.execute({ sql: "SELECT * FROM execution_tasks WHERE run_id = ? ORDER BY created_at, id", args: [id] });
  run.tasks = await Promise.all(tasks.rows.map(async (row) => {
    const task = taskFrom(row as Record<string, unknown>);
    task.dependencies = await dependenciesFor(client, task.id);
    return task;
  }));
  return run;
}

export async function startExecutionRun(client: Client, runId: string, executor: TaskExecutor): Promise<ExecutionRun | null> {
  const now = isoNow();
  await client.execute({
    sql: `UPDATE execution_runs SET status='running', started_at=COALESCE(started_at,?), updated_at=?, finished_at=NULL, error=NULL
          WHERE id=? AND status IN ('pending','blocked')`, args: [now, now, runId],
  });
  const run = await getExecutionRun(client, runId);
  if (run?.status === "running") scheduleExecutionRun(client, runId, executor);
  return run;
}

export function scheduleExecutionRun(client: Client, runId: string, executor: TaskExecutor): void {
  if (jobs.has(runId)) return;
  const job = runScheduler(client, runId, executor).catch(async (error: unknown) => {
    await client.execute({ sql: "UPDATE execution_runs SET status='failed', error=?, updated_at=?, finished_at=? WHERE id=? AND status='running'", args: [error instanceof Error ? error.message : String(error), isoNow(), isoNow(), runId] }).catch(() => {});
  }).finally(() => {
    if (jobs.get(runId) === job) jobs.delete(runId);
  });
  jobs.set(runId, job);
}

export async function claimNextExecutionTask(client: Client, runId: string): Promise<{ task: ExecutionTask; token: string } | null> {
  const token = randomUUID();
  const now = isoNow();
  const res = await client.execute({
    sql: `UPDATE execution_tasks SET status='running', attempts=attempts+1, started_at=?, finished_at=NULL, updated_at=?, claim_token=?
          WHERE id = (
            SELECT t.id FROM execution_tasks t
            WHERE t.run_id=? AND t.status='pending'
              AND (t.requires_approval=0 OR t.approved_at IS NOT NULL)
              AND NOT EXISTS (
                SELECT 1 FROM execution_task_dependencies d JOIN execution_tasks dep ON dep.id=d.depends_on_task_id
                WHERE d.task_id=t.id AND dep.status!='succeeded'
              )
              AND EXISTS (
                SELECT 1 FROM execution_runs r WHERE r.id=t.run_id AND r.status='running'
                  AND (SELECT COUNT(*) FROM execution_tasks active WHERE active.run_id=t.run_id AND active.status='running') < r.concurrency_limit
              )
            ORDER BY t.created_at,t.id LIMIT 1
          ) AND status='pending' RETURNING id`,
    args: [now, now, token, runId],
  });
  if (!res.rows[0]) return null;
  const taskId = str(res.rows[0].id);
  const row = await client.execute({ sql: "SELECT * FROM execution_tasks WHERE id=? AND claim_token=?", args: [taskId, token] });
  if (!row.rows[0]) return null;
  return { task: taskFrom(row.rows[0] as Record<string, unknown>, await dependenciesFor(client, taskId)), token };
}

async function executeClaimed(client: Client, runId: string, task: ExecutionTask, token: string, executor: TaskExecutor): Promise<void> {
  const controller = new AbortController();
  const key = `${runId}:${task.id}`;
  controllers.set(key, controller);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let abortListener: (() => void) | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`Task timed out after ${task.timeoutMs}ms.`));
        reject(new Error(`Task timed out after ${task.timeoutMs}ms.`));
      }, task.timeoutMs);
    });
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason ?? new Error("Task cancelled."));
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    const dependencies = await dependencyOutputsFor(client, task.id);
    const output = await Promise.race([executor.execute(task, { signal: controller.signal, idempotencyKey: task.id, dependencies }), timeoutPromise, aborted]);
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Task cancelled.");
    const now = isoNow();
    await client.execute({ sql: `UPDATE execution_tasks SET status='succeeded', output_json=?, error=NULL, updated_at=?, finished_at=?, claim_token=NULL WHERE id=? AND status='running' AND claim_token=?`, args: [JSON.stringify(output ?? null), now, now, task.id, token] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = isoNow();
    const retry = executor.retrySafety === "idempotent" && task.attempts < task.maxAttempts && (!controller.signal.aborted || timedOut);
    await client.execute({
      sql: `UPDATE execution_tasks SET status=?, error=?, updated_at=?, finished_at=?, claim_token=NULL
            WHERE id=? AND status='running' AND claim_token=?`,
      args: [retry ? "pending" : "failed", message, now, retry ? null : now, task.id, token],
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
    controllers.delete(key);
  }
}

async function skipFailedDependencies(client: Client, runId: string): Promise<void> {
  const now = isoNow();
  await client.execute({
    sql: `UPDATE execution_tasks SET status='skipped', error='A dependency did not succeed.', updated_at=?, finished_at=?
          WHERE run_id=? AND status='pending' AND EXISTS (
            SELECT 1 FROM execution_task_dependencies d JOIN execution_tasks dep ON dep.id=d.depends_on_task_id
            WHERE d.task_id=execution_tasks.id AND dep.status IN ('failed','cancelled','skipped')
          )`, args: [now, now, runId],
  });
}

async function settleRun(client: Client, runId: string): Promise<"active" | "settled"> {
  await skipFailedDependencies(client, runId);
  const res = await client.execute({ sql: "SELECT status,COUNT(*) AS n FROM execution_tasks WHERE run_id=? GROUP BY status", args: [runId] });
  const counts = new Map(res.rows.map((row) => [str(row.status), number(row.n)]));
  if ((counts.get("running") ?? 0)) return "active";
  const now = isoNow();
  if ((counts.get("blocked") ?? 0) > 0) {
    await client.execute({ sql: "UPDATE execution_runs SET status='blocked', updated_at=?, finished_at=NULL WHERE id=? AND status='running'", args: [now, runId] });
  } else if ((counts.get("pending") ?? 0) > 0) {
    return "active";
  } else {
    const failed = (counts.get("failed") ?? 0) + (counts.get("skipped") ?? 0) > 0;
    await client.execute({ sql: "UPDATE execution_runs SET status=?, updated_at=?, finished_at=? WHERE id=? AND status='running'", args: [failed ? "failed" : "completed", now, now, runId] });
  }
  return "settled";
}

async function runScheduler(client: Client, runId: string, executor: TaskExecutor): Promise<void> {
  const running = new Set<Promise<void>>();
  while (true) {
    const current = await client.execute({ sql: "SELECT status FROM execution_runs WHERE id=?", args: [runId] });
    if (str(current.rows[0]?.status) !== "running") {
      for (const [key, controller] of controllers) if (key.startsWith(`${runId}:`)) controller.abort(new Error("Run is no longer active."));
      await Promise.allSettled([...running]);
      break;
    }
    await skipFailedDependencies(client, runId);
    const run = await client.execute({ sql: "SELECT concurrency_limit FROM execution_runs WHERE id=?", args: [runId] });
    const limit = Math.max(1, number(run.rows[0]?.concurrency_limit));
    while (running.size < limit) {
      const claim = await claimNextExecutionTask(client, runId);
      if (!claim) break;
      const work = executeClaimed(client, runId, claim.task, claim.token, executor).finally(() => running.delete(work));
      running.add(work);
    }
    if (running.size) {
      await Promise.race(running);
      continue;
    }
    const state = await settleRun(client, runId);
    if (state === "settled") {
      // A blocked task may be awaiting an explicit human decision.
      break;
    }
    // No task was claimable and no worker is active. A valid DAG can only be
    // here when approval is outstanding; settleRun changes the run to blocked.
    const after = await client.execute({ sql: "SELECT status FROM execution_runs WHERE id=?", args: [runId] });
    if (str(after.rows[0]?.status) !== "running") break;
    const persistedWorkers = await client.execute({ sql: "SELECT COUNT(*) AS n FROM execution_tasks WHERE run_id=? AND status='running'", args: [runId] });
    if (number(persistedWorkers.rows[0]?.n) > 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    await client.execute({ sql: "UPDATE execution_runs SET status='failed',error='Scheduler found no runnable task.',updated_at=?,finished_at=? WHERE id=? AND status='running'", args: [isoNow(), isoNow(), runId] });
    break;
  }
}

export async function approveExecutionTask(client: Client, runId: string, taskId: string, executor: TaskExecutor): Promise<ExecutionTask | null> {
  const now = isoNow();
  const res = await client.execute({
    sql: "UPDATE execution_tasks SET status='pending',approved_at=?,updated_at=?,error=NULL WHERE id=? AND run_id=? AND status='blocked' AND requires_approval=1",
    args: [now, now, taskId, runId],
  });
  if (!res.rowsAffected) return null;
  await client.execute({ sql: "UPDATE execution_runs SET status='running',updated_at=?,finished_at=NULL WHERE id=? AND status='blocked'", args: [now, runId] });
  const row = await client.execute({ sql: "SELECT * FROM execution_tasks WHERE id=?", args: [taskId] });
  const run = await client.execute({ sql: "SELECT status FROM execution_runs WHERE id=?", args: [runId] });
  if (str(run.rows[0]?.status) === "running") scheduleExecutionRun(client, runId, executor);
  return row.rows[0] ? taskFrom(row.rows[0] as Record<string, unknown>, await dependenciesFor(client, taskId)) : null;
}

export async function cancelExecutionRun(client: Client, runId: string): Promise<boolean> {
  const now = isoNow();
  const res = await client.execute({ sql: "UPDATE execution_runs SET status='cancelled',updated_at=?,finished_at=? WHERE id=? AND status IN ('pending','running','blocked')", args: [now, now, runId] });
  if (!res.rowsAffected) return false;
  for (const [key, controller] of controllers) if (key.startsWith(`${runId}:`)) controller.abort(new Error("Run cancelled."));
  await client.execute({
    sql: "UPDATE execution_tasks SET status='cancelled',error='Run cancelled.',updated_at=?,finished_at=?,claim_token=NULL WHERE run_id=? AND status NOT IN ('succeeded','failed','cancelled','skipped')",
    args: [now, now, runId],
  });
  return true;
}

export async function recoverExecutionRuns(
  client: Client,
  executorForMode: (mode: ExecutionMode) => TaskExecutor,
): Promise<void> {
  const active = await client.execute("SELECT id,execution_mode FROM execution_runs WHERE status='running'");
  for (const row of active.rows) {
    const runId = str(row.id);
    const mode = str(row.execution_mode ?? "mock") as ExecutionMode;
    const now = isoNow();
    if (mode === "live") {
      await client.execute({
        sql: `UPDATE execution_tasks SET status='failed',error='Interrupted live execution was not retried because its side effects are unknown.',
                started_at=NULL,finished_at=?,claim_token=NULL,updated_at=?
              WHERE run_id=? AND status='running'`, args: [now, now, runId],
      });
    } else {
      await client.execute({
        sql: `UPDATE execution_tasks SET status=CASE WHEN attempts < max_attempts THEN 'pending' ELSE 'failed' END,
                error='Execution interrupted by server restart.', started_at=NULL,
                finished_at=CASE WHEN attempts < max_attempts THEN NULL ELSE ? END, claim_token=NULL, updated_at=?
              WHERE run_id=? AND status='running'`, args: [now, now, runId],
      });
    }
    scheduleExecutionRun(client, runId, executorForMode(mode));
  }
}

/** Deterministic local executor. It never calls a model, browser, or external tool. */
export const deterministicMockExecutor: TaskExecutor = {
  retrySafety: "idempotent",
  execute: async (task, { signal, dependencies }) => {
    if (signal.aborted) throw signal.reason ?? new Error("Task cancelled.");
    const collaboration = mockCollaborationOutput(task, dependencies);
    if (collaboration) return collaboration;
    return {
      mode: "mock",
      simulated: true,
      label: "SIMULATED OUTPUT — deterministic mock executor",
      taskId: task.id,
      agentId: task.agentId,
      input: task.input,
    };
  },
};

export async function rejectExecutionTask(client: Client, runId: string, taskId: string, executor: TaskExecutor): Promise<ExecutionTask | null> {
  const now = isoNow();
  const res = await client.execute({
    sql: `UPDATE execution_tasks SET status='failed',error='Approval rejected by user.',updated_at=?,finished_at=?
          WHERE id=? AND run_id=? AND status='blocked' AND requires_approval=1 AND approved_at IS NULL`,
    args: [now, now, taskId, runId],
  });
  if (!res.rowsAffected) return null;
  await client.execute({ sql: "UPDATE execution_runs SET status='running',updated_at=?,finished_at=NULL WHERE id=? AND status='blocked'", args: [now, runId] });
  const row = await client.execute({ sql: "SELECT * FROM execution_tasks WHERE id=?", args: [taskId] });
  const run = await client.execute({ sql: "SELECT status FROM execution_runs WHERE id=?", args: [runId] });
  if (str(run.rows[0]?.status) === "running") scheduleExecutionRun(client, runId, executor);
  return row.rows[0] ? taskFrom(row.rows[0] as Record<string, unknown>, await dependenciesFor(client, taskId)) : null;
}

export function isTerminalRun(status: RunStatus): boolean { return (TERMINAL_RUNS as readonly string[]).includes(status); }
export function isTerminalTask(status: TaskStatus): boolean { return (TERMINAL_TASKS as readonly string[]).includes(status); }

