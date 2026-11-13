import type { CreateExecutionRunInput } from "./execution-engine";
import type { ExecutionRun, ExecutionTaskCounts, ExecutionTaskStatus } from "@/lib/shared/types";
import { approveExecutionTask, cancelExecutionRun, createExecutionRun, getExecutionRun, listExecutionRuns, rejectExecutionTask, startExecutionRun, type ExecutionMode } from "./execution-engine";
import { executionTaskExecutor } from "./execution-adapter";
import { InputError } from "./errors";
import { db, listBots } from "./db";
import { configuredExecutionMode, keys } from "./config";

function engineError(error: unknown): never {
  throw new InputError(error instanceof Error ? error.message : "Invalid execution request.");
}

export async function createRun(input: CreateExecutionRunInput) {
  const executionMode = (input?.executionMode ?? configuredExecutionMode()) as ExecutionMode;
  const botIds = new Set((await listBots()).map((bot) => bot.id));
  for (const task of input?.tasks ?? []) {
    if (!botIds.has(task.agentId)) throw new InputError(`Task ${task.key} refers to an unknown bot: ${task.agentId}.`);
  }
  try {
    return await createExecutionRun(await db(), { ...input, executionMode });
  } catch (error) {
    return engineError(error);
  }
}

export async function runs(limit: number, offset = 0, before?: { createdAt: string; id: string }) {
  const client = await db();
  const items = await listExecutionRuns(client, limit, offset, before);
  if (!items.length) return items;
  const counts = await client.execute({
    sql: `SELECT run_id,status,COUNT(*) AS n FROM execution_tasks
          WHERE run_id IN (${items.map(() => "?").join(",")}) GROUP BY run_id,status`,
    args: items.map((run) => run.id),
  });
  const allStatuses: ExecutionTaskStatus[] = ["pending", "blocked", "running", "succeeded", "failed", "cancelled", "skipped"];
  const byRun = new Map<string, ExecutionTaskCounts>();
  for (const run of items) byRun.set(run.id, Object.fromEntries(allStatuses.map((status) => [status, 0])) as ExecutionTaskCounts);
  for (const row of counts.rows) {
    const target = byRun.get(String(row.run_id));
    if (target && allStatuses.includes(String(row.status) as ExecutionTaskStatus)) target[String(row.status) as ExecutionTaskStatus] = Number(row.n);
  }
  return items.map((run): ExecutionRun => {
    const taskCounts = byRun.get(run.id)!;
    return { ...run, taskCounts, taskCount: Object.values(taskCounts).reduce((sum, count) => sum + count, 0) };
  });
}

export async function inspectRun(id: string) {
  const run = await getExecutionRun(await db(), id);
  if (!run) throw new InputError("Execution run not found.");
  return run;
}

export async function startRun(id: string) {
  const client = await db();
  const existing = await getExecutionRun(client, id);
  if (!existing) throw new InputError("Execution run not found.");
  requireLiveKey(existing.executionMode);
  const run = await startExecutionRun(client, id, executionTaskExecutor(existing.executionMode));
  if (!run) throw new InputError("Execution run not found.");
  if (!["running", "blocked", "completed", "failed", "cancelled"].includes(run.status)) throw new InputError(`Execution run cannot be started from ${run.status}.`);
  return run;
}

export async function approveTask(runId: string, taskId: string) {
  const client = await db();
  const run = await getExecutionRun(client, runId);
  if (!run) throw new InputError("Execution run not found.");
  requireLiveKey(run.executionMode);
  const task = await approveExecutionTask(client, runId, taskId, executionTaskExecutor(run.executionMode));
  if (!task) throw new InputError("Task is not awaiting approval in this execution run.");
  return task;
}

export async function rejectTask(runId: string, taskId: string) {
  const client = await db();
  const run = await getExecutionRun(client, runId);
  if (!run) throw new InputError("Execution run not found.");
  const task = await rejectExecutionTask(client, runId, taskId, executionTaskExecutor(run.executionMode));
  if (!task) throw new InputError("Task is not awaiting approval in this execution run.");
  return task;
}

function requireLiveKey(mode: ExecutionMode): void {
  if (mode === "live" && !keys.nebius()) throw new InputError("This run is configured for live execution. Add NEBIUS_API_KEY and restart; mock output will not be substituted.");
}

export async function cancelRun(id: string) {
  const client = await db();
  const cancelled = await cancelExecutionRun(client, id);
  if (!cancelled) {
    const run = await getExecutionRun(client, id);
    if (!run) throw new InputError("Execution run not found.");
    throw new InputError(`Execution run cannot be cancelled from ${run.status}.`);
  }
  return getExecutionRun(client, id);
}
