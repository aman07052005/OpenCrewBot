import type { Client } from "@libsql/client";
import type { ActionRequest, Bot, ExecutionExternalAction, ExecutionRun, ExecutionTask } from "@/lib/shared/types";
import { authorizeAction, executeApprovedAction, getExecutionTaskAction, proposeAction, type ActionHandlers, type McpReadArgs } from "./approval-service.ts";
import { inspectGitHub, type GitHubRequest } from "./github-integration.ts";

export const EXECUTION_EXTERNAL_OPERATIONS = new Set<ExecutionExternalAction["operation"]>(["github.public.read", "mcp.read.invoke"]);

export function taskExternalAction(task: Pick<ExecutionTask, "input">): ExecutionExternalAction | null {
  if (!task.input || typeof task.input !== "object") return null;
  const value = (task.input as { externalAction?: unknown }).externalAction;
  if (!value || typeof value !== "object") return null;
  const operation = (value as { operation?: unknown }).operation;
  if (typeof operation !== "string" || !EXECUTION_EXTERNAL_OPERATIONS.has(operation as ExecutionExternalAction["operation"])) return null;
  return { operation: operation as ExecutionExternalAction["operation"], arguments: (value as { arguments?: unknown }).arguments };
}

/** Create the persistent Module G records before a run can contact a provider. */
export async function prepareExecutionActions(client: Client, run: ExecutionRun, bots: Bot[]): Promise<void> {
  for (const task of run.tasks ?? []) {
    const external = taskExternalAction(task);
    if (!external) continue;
    const bot = bots.find((candidate) => candidate.id === task.agentId);
    if (!bot) throw new Error(`Assigned bot ${task.agentId} no longer exists.`);
    const authorization = authorizeAction(bot, external.operation, external.arguments);
    if (authorization.decision === "denied") throw new Error(authorization.reason);
    const action = await proposeAction(client, bot, { operation: external.operation, arguments: external.arguments, executionRunId: run.id, executionTaskId: task.id });
    if (action.status === "pending") {
      await client.execute({ sql: "UPDATE execution_tasks SET status='blocked',error=? WHERE id=? AND status='pending'", args: ["External read is waiting for persistent approval in Approvals.", task.id] });
    } else if (action.status === "rejected") {
      await client.execute({ sql: "UPDATE execution_tasks SET status='failed',error=?,finished_at=?,updated_at=? WHERE id=?", args: [action.reason, new Date().toISOString(), new Date().toISOString(), task.id] });
    }
  }
}

async function githubRead(args: GitHubRequest): Promise<unknown> {
  const status = await import("./integration-status.ts");
  try { const result = await inspectGitHub(args); await status.recordIntegrationSuccess("github"); return result; }
  catch (error) { await status.recordIntegrationFailure("github", error); throw error; }
}

async function mcpRead(args: McpReadArgs): Promise<unknown> {
  return (await import("./mcp-servers.ts")).invokeEnabledReadTool(args.serverId, args.tool, args.input);
}

export const executionActionHandlers: ActionHandlers = { githubRead, mcpRead };

/** Execute or replay the one durable action associated with this claimed task. */
export async function executeTaskExternalAction(client: Client, task: ExecutionTask, bot: Bot, handlers: ActionHandlers = executionActionHandlers): Promise<unknown> {
  const expected = taskExternalAction(task);
  if (!expected) throw new Error("Execution task has no registered external operation.");
  let action = await getExecutionTaskAction(client, task.id);
  if (!action) throw new Error("Persistent approval record is missing for this external operation.");
  if (action.agentId !== bot.id || action.executionRunId !== task.runId || action.operation !== expected.operation) throw new Error("Persistent approval record does not match this task.");
  if (action.status === "approved") action = await executeApprovedAction(client, action.id, bot, handlers);
  if (!action || action.status !== "succeeded") throw new Error(action?.error ?? `External operation is ${action?.status ?? "unavailable"}.`);
  return { mode: "live", simulated: false, externalAction: true, actionId: action.id, operation: action.operation, result: action.result };
}

/** Move a blocked task after the owner executes/rejects its Module G action. */
export async function synchronizeExecutionAction(client: Client, action: ActionRequest): Promise<{ runId: string; shouldResume: boolean } | null> {
  if (!action.executionRunId || !action.executionTaskId) return null;
  const run = await client.execute({ sql: "SELECT status FROM execution_runs WHERE id=?", args: [action.executionRunId] });
  if (!run.rows[0] || String(run.rows[0].status) === "cancelled") return null;
  const now = new Date().toISOString();
  if (action.status === "succeeded") {
    await client.execute({ sql: "UPDATE execution_tasks SET status='pending',error=NULL,updated_at=? WHERE id=? AND run_id=? AND status='blocked'", args: [now, action.executionTaskId, action.executionRunId] });
  } else if (["rejected", "cancelled", "expired", "failed"].includes(action.status)) {
    await client.execute({ sql: "UPDATE execution_tasks SET status='failed',error=?,updated_at=?,finished_at=? WHERE id=? AND run_id=? AND status='blocked'", args: [action.error ?? `External operation ${action.status}.`, now, now, action.executionTaskId, action.executionRunId] });
  }
  return { runId: action.executionRunId, shouldResume: String(run.rows[0].status) === "blocked" };
}
