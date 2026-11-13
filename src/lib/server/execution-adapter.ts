import { deterministicMockExecutor, type ExecutionMode, type TaskExecutor } from "./execution-engine";
import { db, getBot, getRoom } from "./db";
import { collaborationContext } from "./collaboration-protocol";
import { runIsolatedExecutionTask } from "./runtime";
import { createMastraTaskExecutor } from "./execution-task-executor";

/** Choose the persisted run mode without ever falling back from live to mock. */
export function executionTaskExecutor(mode: ExecutionMode): TaskExecutor {
  const base = mode === "mock" ? deterministicMockExecutor : mode === "live" ? createMastraTaskExecutor({ getBot, runtime: { runTask: runIsolatedExecutionTask } }) : null;
  if (!base) throw new Error(`Unsupported execution mode: ${String(mode)}.`);
  return { retrySafety: base.retrySafety, execute: async (task, context) => {
    if (collaborationContext(task.input)) {
      const row = (await (await db()).execute({ sql: `SELECT s.room_id,s.member_ids,s.closed_at FROM collaboration_rounds r JOIN collaboration_sessions s ON s.id=r.session_id WHERE r.run_id=?`, args: [task.runId] })).rows[0];
      const room = row ? await getRoom(String(row.room_id)) : null;
      const members = row ? JSON.parse(String(row.member_ids)) as string[] : [];
      if (!row || row.closed_at != null || !room || !members.includes(task.agentId) || !room.memberIds.includes(task.agentId) || !await getBot(task.agentId)) throw new Error("Collaboration agent is no longer an authorized room member.");
    }
    return base.execute(task, context);
  } };
}
