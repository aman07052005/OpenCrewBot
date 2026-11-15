import type { CreateExecutionRunInput, ExecutionMode } from "./types";

export const scheduledTaskDefaultTimeoutMs = (mode: ExecutionMode): number => mode === "live" ? 300_000 : 30_000;

export function createSingleTaskSchedulePlan(input: { name: string; objective: string; agentId: string; executionMode: ExecutionMode; timeoutMs?: number }): CreateExecutionRunInput {
  return {
    name: input.name,
    executionMode: input.executionMode,
    concurrencyLimit: 1,
    tasks: [{
      key: "scheduled-task",
      title: input.name,
      agentId: input.agentId,
      input: input.objective,
      timeoutMs: input.timeoutMs ?? scheduledTaskDefaultTimeoutMs(input.executionMode),
    }],
  };
}

/** UI editing is intentionally limited to the plan shape it creates. */
export function reviseSingleTaskSchedulePlan(plan: CreateExecutionRunInput, input: { name: string; objective: string; executionMode: ExecutionMode; timeoutMs: number }): CreateExecutionRunInput {
  if (plan.tasks.length !== 1) throw new Error("Multi-task schedule plans must be preserved unchanged.");
  const task = plan.tasks[0];
  const ordinaryTextInput = typeof task.input === "string" && !task.skillId && !task.externalAction;
  return {
    ...plan,
    name: input.name,
    executionMode: input.executionMode,
    tasks: [{ ...task, title: input.name, input: ordinaryTextInput ? input.objective : task.input, timeoutMs: input.timeoutMs }],
  };
}
