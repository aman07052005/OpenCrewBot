/** Scheduler startup is isolated here so it runs without a browser tab. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV === "test" || process.env.NEXT_PHASE === "phase-production-build" || process.env.OPENCREWBOT_DISABLE_SCHEDULER === "1") return;
  const { startScheduler } = await import("./lib/server/scheduler");
  startScheduler();
}
