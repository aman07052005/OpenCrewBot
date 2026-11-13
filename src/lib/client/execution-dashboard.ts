import type { ExecutionMode, ExecutionRun, ExecutionTaskCounts, ExecutionTaskStatus } from "@/lib/shared/types";

const statuses: ExecutionTaskStatus[] = ["pending", "blocked", "running", "succeeded", "failed", "cancelled", "skipped"];
const terminal = new Set<ExecutionTaskStatus>(["succeeded", "failed", "cancelled", "skipped"]);

export function executionTaskCounts(run: ExecutionRun): ExecutionTaskCounts {
  if (run.taskCounts) return run.taskCounts;
  const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as ExecutionTaskCounts;
  for (const task of run.tasks ?? []) counts[task.status] += 1;
  return counts;
}

export function executionProgress(run: ExecutionRun) {
  const counts = executionTaskCounts(run);
  const total = run.taskCount ?? Object.values(counts).reduce((sum, count) => sum + count, 0);
  const finished = statuses.filter((status) => terminal.has(status)).reduce((sum, status) => sum + counts[status], 0);
  return { total, finished, succeeded: counts.succeeded, percent: total ? Math.round((finished / total) * 100) : 0, counts };
}

/** A simulated marker wins even if a malformed payload is attached to a live run. */
export function executionOutputKind(runMode: ExecutionMode, output: unknown): "simulated" | "live" | "unlabelled" {
  if (runMode === "mock") return "simulated";
  if (!output || typeof output !== "object") return "unlabelled";
  const value = output as { mode?: unknown; simulated?: unknown };
  if (value.mode === "mock" || value.simulated === true) return "simulated";
  if (value.mode === "live" && value.simulated === false) return "live";
  return "unlabelled";
}
