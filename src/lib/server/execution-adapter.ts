import { deterministicMockExecutor, type ExecutionMode, type TaskExecutor } from "./execution-engine";
import { getBot } from "./db";
import { runIsolatedExecutionTask } from "./runtime";
import { createMastraTaskExecutor } from "./execution-task-executor";

/** Choose the persisted run mode without ever falling back from live to mock. */
export function executionTaskExecutor(mode: ExecutionMode): TaskExecutor {
  if (mode === "mock") return deterministicMockExecutor;
  if (mode === "live") return createMastraTaskExecutor({ getBot, runtime: { runTask: runIsolatedExecutionTask } });
  throw new Error(`Unsupported execution mode: ${String(mode)}.`);
}
