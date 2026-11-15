import type { CreateExecutionRunInput } from "./execution-engine";
import type { ExecutionRun, ExecutionTaskCounts, ExecutionTaskStatus } from "@/lib/shared/types";
import { approveExecutionTask, cancelExecutionRun, createExecutionRun, getExecutionRun, listExecutionRuns, rejectExecutionTask, startExecutionRun, type ExecutionMode } from "./execution-engine";
import { executionTaskExecutor } from "./execution-adapter";
import { InputError } from "./errors";
import { db, listBots } from "./db";
import { configuredExecutionMode, isMock, keys } from "./config";
import {
  ChiefOfStaffRequestSchema,
  CreateChiefOfStaffRunSchema,
  discoverAgentCapabilities,
  planChiefOfStaff,
  toExecutionRunInput,
  validateChiefOfStaffPlan,
} from "./chief-of-staff";
import { createLiveChiefOfStaffPlanGenerator } from "./chief-of-staff-model";
import { EXECUTABLE_SKILL_IDS } from "@/lib/shared/agent-skills";
import { authorizeAction } from "./approval-service.ts";
import { EXECUTION_EXTERNAL_OPERATIONS, prepareExecutionActions, synchronizeExecutionAction } from "./execution-actions.ts";
import type { ActionRequest } from "@/lib/shared/types";
import { enabledReadToolCatalog } from "./mcp-servers.ts";
import { expireActions } from "./approval-service.ts";
import { validateSkillInput } from "./skills.ts";

function engineError(error: unknown): never {
  throw new InputError(error instanceof Error ? error.message : "Invalid execution request.");
}

export async function createRun(input: CreateExecutionRunInput) {
  const executionMode = (input?.executionMode ?? configuredExecutionMode()) as ExecutionMode;
  const bots = await listBots();
  const botIds = new Set(bots.map((bot) => bot.id));
  for (const task of input?.tasks ?? []) {
    if (!botIds.has(task.agentId)) throw new InputError(`Task ${task.key} refers to an unknown bot: ${task.agentId}.`);
    if (task.skillId) {
      if (!EXECUTABLE_SKILL_IDS.includes(task.skillId as never)) throw new InputError(`Task ${task.key} refers to an unknown skill.`);
      if (!bots.find((bot) => bot.id === task.agentId)?.agentConfig?.skillIds.includes(task.skillId)) throw new InputError(`Task ${task.key} assigns a skill disabled for its agent.`);
      try { validateSkillInput(task.skillId as never, task.skillInput); } catch (error) { throw new InputError(`Task ${task.key} has invalid skill input: ${error instanceof Error ? error.message : "validation failed"}.`); }
      task.input = { ...(task.input && typeof task.input === "object" ? task.input as Record<string, unknown> : {}), skillId: task.skillId, skillInput: task.skillInput };
    }
    if (task.externalAction) {
      if (task.skillId) throw new InputError(`Task ${task.key} cannot combine a skill and an external operation.`);
      if (executionMode !== "live") throw new InputError(`Task ${task.key} uses a real integration and requires LIVE execution mode.`);
      if (!EXECUTION_EXTERNAL_OPERATIONS.has(task.externalAction.operation)) throw new InputError(`Task ${task.key} refers to an unsupported execution operation.`);
      const assigned = bots.find((bot) => bot.id === task.agentId)!;
      const authorization = authorizeAction(assigned, task.externalAction.operation, task.externalAction.arguments);
      if (authorization.decision === "denied") throw new InputError(`Task ${task.key}: ${authorization.reason}`);
      task.input = { ...(task.input && typeof task.input === "object" ? task.input as Record<string, unknown> : {}), externalAction: task.externalAction };
    }
  }
  try {
    const client = await db();
    const run = await createExecutionRun(client, { ...input, executionMode });
    await prepareExecutionActions(client, run, bots);
    return (await getExecutionRun(client, run.id))!;
  } catch (error) {
    return engineError(error);
  }
}

export async function synchronizeActionExecution(action: ActionRequest): Promise<void> {
  const client = await db();
  const link = await synchronizeExecutionAction(client, action);
  if (!link?.shouldResume) return;
  const run = await getExecutionRun(client, link.runId);
  if (run && run.status === "blocked") {
    requireLiveKey(run.executionMode);
    await startExecutionRun(client, run.id, executionTaskExecutor(run.executionMode));
  }
}

export async function planChiefOfStaffRequest(input: unknown) {
  let request: ReturnType<typeof ChiefOfStaffRequestSchema.parse>;
  try {
    request = ChiefOfStaffRequestSchema.parse(input);
  } catch (error) {
    throw new InputError(error instanceof Error ? error.message : "Invalid Chief of Staff request.");
  }
  if (request.planningMode === "live" && isMock()) {
    throw new InputError("Live planning requires an owner-configured live provider. Select mock planning for a deterministic development plan; no fallback is performed.");
  }
  try {
    const agents = discoverAgentCapabilities(await listBots(), { tavilyAvailable: keys.tavily(), mcpReadTools: await enabledReadToolCatalog() });
    const plan = await planChiefOfStaff(request, {
      agents,
      generateLivePlan: request.planningMode === "live" ? createLiveChiefOfStaffPlanGenerator() : undefined,
    });
    return { plan };
  } catch (error) {
    throw new InputError(error instanceof Error ? error.message : "Chief of Staff planning failed.");
  }
}

export async function createChiefOfStaffRun(input: unknown) {
  let request: ReturnType<typeof CreateChiefOfStaffRunSchema.parse>;
  try {
    request = CreateChiefOfStaffRunSchema.parse(input);
  } catch (error) {
    throw new InputError(error instanceof Error ? error.message : "Invalid Chief of Staff run request.");
  }
  if (request.plan.planningMode !== request.planningMode) throw new InputError("Planning mode does not match the generated plan.");
  const bots = await listBots();
  try {
    const agents = discoverAgentCapabilities(bots, { tavilyAvailable: keys.tavily(), mcpReadTools: await enabledReadToolCatalog() });
    validateChiefOfStaffPlan(request.plan, agents);
    const executionInput = toExecutionRunInput(request, agents);
    return await createRun(executionInput);
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(error instanceof Error ? error.message : "The Chief of Staff plan could not be saved.");
  }
}

/** Scheduler hook: expiry is durable even when no approvals page is open. */
export async function tickExpiredExecutionActions(): Promise<void> {
  const client = await db();
  for (const action of await expireActions(client)) await synchronizeActionExecution(action);
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
  if (mode === "live" && isMock()) throw new InputError("This run is configured for live execution. Configure an owner-selected live provider and restart; mock output will not be substituted.");
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
