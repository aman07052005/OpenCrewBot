import { tickScheduledWorkflows } from "./scheduled-workflows";

const INTERVAL_MS = 30_000;
const g = globalThis as unknown as { __opencrewbotScheduler?: ReturnType<typeof setInterval>; __opencrewbotSchedulerTick?: Promise<void> };

function allowed(): boolean {
  return process.env.NODE_ENV !== "test"
    && process.env.NEXT_PHASE !== "phase-production-build"
    && process.env.OPENCREWBOT_DISABLE_SCHEDULER !== "1";
}

/** Starts one process-local ticker. Durable occurrence claims prevent duplicates across processes. */
export function startScheduler(): void {
  if (!allowed() || g.__opencrewbotScheduler) return;
  const tick = () => {
    if (g.__opencrewbotSchedulerTick) return;
    g.__opencrewbotSchedulerTick = tickScheduledWorkflows().catch((error) => {
      console.error("[opencrewbot scheduler]", error);
    }).finally(() => { g.__opencrewbotSchedulerTick = undefined; });
  };
  tick();
  g.__opencrewbotScheduler = setInterval(tick, INTERVAL_MS);
}

export function stopSchedulerForTests(): void {
  if (g.__opencrewbotScheduler) clearInterval(g.__opencrewbotScheduler);
  g.__opencrewbotScheduler = undefined;
}
