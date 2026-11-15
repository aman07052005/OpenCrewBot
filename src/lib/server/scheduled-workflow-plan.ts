import type { Bot, CreateExecutionRunInput } from "../shared/types.ts";
import { EXECUTABLE_SKILL_IDS } from "../shared/agent-skills.ts";
import { validateExecutionRunInput } from "./execution-engine.ts";
import { InputError } from "./errors.ts";

type LiveModelValidator = (bot: Bot, taskInput: unknown) => Promise<unknown>;

export async function validateScheduledWorkflowPlan(plan: unknown, bots: Bot[], validateLiveModel?: LiveModelValidator): Promise<{ plan: CreateExecutionRunInput; agentIds: string[] }> {
  validateExecutionRunInput(plan as CreateExecutionRunInput);
  const clean = structuredClone(plan as CreateExecutionRunInput);
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  for (const task of clean.tasks) {
    const bot = byId.get(task.agentId);
    if (!bot) throw new InputError(`Task ${task.key} refers to an unknown bot.`);
    const embeddedExternalAction = task.input && typeof task.input === "object" && "externalAction" in task.input;
    if (task.externalAction || embeddedExternalAction) throw new InputError(`Task ${task.key} cannot schedule an external operation. External reads require a fresh persistent approval task and are never replayed automatically.`);
    if (task.skillId) {
      if (!EXECUTABLE_SKILL_IDS.includes(task.skillId as never) || !bot.agentConfig?.skillIds.includes(task.skillId)) throw new InputError(`Task ${task.key} uses a skill not enabled for its agent.`);
      task.input = { ...(task.input && typeof task.input === "object" ? task.input as Record<string, unknown> : {}), skillId: task.skillId, skillInput: task.skillInput };
    }
    if (clean.executionMode === "live" && validateLiveModel) {
      try { await validateLiveModel(bot, task.input); }
      catch (error) { throw new InputError(`Task ${task.key} cannot run LIVE with its assigned agent: ${error instanceof Error ? error.message : "model configuration is invalid"}`); }
    }
  }
  return { plan: clean, agentIds: [...new Set(clean.tasks.map((task) => task.agentId))] };
}
