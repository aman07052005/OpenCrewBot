import { deterministicMockExecutor, type ExecutionMode, type TaskExecutor } from "./execution-engine";
import { db, getBot, getRoom } from "./db";
import { collaborationContext } from "./collaboration-protocol";
import { runIsolatedExecutionTask } from "./runtime";
import { DATA_DIR } from "./config";
import { collectSharedMemory, sharedMemoryPrompt, attachMockMemory } from "./memory-store";
import type { ExecutionTask } from "./execution-engine";
import type { Bot } from "@/lib/shared/types";
import { createMastraTaskExecutor } from "./execution-task-executor";
import { executeSkill } from "./skills.ts";
import { EXECUTABLE_SKILL_IDS } from "@/lib/shared/agent-skills";

async function verifiedRoomId(task: ExecutionTask): Promise<string | undefined> {
  if (!collaborationContext(task.input)) return undefined;
  const row = (await (await db()).execute({ sql: `SELECT s.room_id,s.member_ids,s.closed_at FROM collaboration_rounds r JOIN collaboration_sessions s ON s.id=r.session_id WHERE r.run_id=?`, args: [task.runId] })).rows[0];
  const room = row ? await getRoom(String(row.room_id)) : null;
  const members = row ? JSON.parse(String(row.member_ids)) as string[] : [];
  if (!row || row.closed_at != null || !room || !members.includes(task.agentId) || !room.memberIds.includes(task.agentId) || !await getBot(task.agentId)) throw new Error("Collaboration agent is no longer an authorized room member.");
  return room.id;
}
async function loadMemory(task: ExecutionTask, bot: Bot) {
  return bot.tools.memory ? sharedMemoryPrompt(collectSharedMemory(DATA_DIR, await verifiedRoomId(task))) : "";
}

/** Choose the persisted run mode without ever falling back from live to mock. */
export function executionTaskExecutor(mode: ExecutionMode): TaskExecutor {
  const base = mode === "mock" ? deterministicMockExecutor : mode === "live" ? createMastraTaskExecutor({ getBot, runtime: { runTask: runIsolatedExecutionTask }, loadMemory }) : null;
  if (!base) throw new Error(`Unsupported execution mode: ${String(mode)}.`);
  return { retrySafety: base.retrySafety, execute: async (task, context) => {
    const roomId = await verifiedRoomId(task);
    const input = task.input && typeof task.input === "object" ? task.input as Record<string, unknown> : null;
    const skillId = input?.skillId;
    if (typeof skillId === "string") {
      if (!EXECUTABLE_SKILL_IDS.includes(skillId as never)) throw new Error(`Unknown skill ${skillId}.`);
      const bot = await getBot(task.agentId);
      if (!bot?.agentConfig?.skillIds.includes(skillId)) throw new Error(`Assigned agent is not authorized to use ${skillId}.`);
      return executeSkill(skillId as never, input!.skillInput, mode);
    }
    const result = await base.execute(task, context);
    if (mode !== "mock") return result;
    const bot = await getBot(task.agentId);
    if (!bot?.tools.memory || !result || typeof result !== "object") return result;
    return attachMockMemory(DATA_DIR, bot.id, roomId, result as Record<string, unknown>);
  } };
}
