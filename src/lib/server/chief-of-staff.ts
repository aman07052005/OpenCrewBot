import { z } from "zod";
import type { Bot, ChiefOfStaffPlan, ChiefOfStaffTask, CreateChiefOfStaffRunInput, CreateExecutionRunInput } from "@/lib/shared/types";
import { validateExecutionRunInput } from "./execution-engine.ts";
import { skillForObjective } from "./skills.ts";

export const MAX_CHIEF_OF_STAFF_TASKS = 20;
const MAX_WORK_TASKS = MAX_CHIEF_OF_STAFF_TASKS - 1;
const FINAL_TASK_KEY = "final-deliverable";

export const ChiefOfStaffRequestSchema = z.object({
  instruction: z.string().trim().min(1, "Enter a business instruction.").max(12_000, "Instructions are limited to 12,000 characters."),
  planningMode: z.enum(["mock", "live"]),
}).strict();

const TaskSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  title: z.string().trim().min(1).max(300),
  instructions: z.string().trim().min(1).max(8_000),
  agentId: z.string().trim().min(1).max(200),
  dependsOn: z.array(z.string().min(1).max(80)).max(MAX_CHIEF_OF_STAFF_TASKS),
  rationale: z.string().trim().min(1).max(2_000),
  isFinalConsolidation: z.boolean(),
  skillId: z.string().optional(),
}).strict();

export const ChiefOfStaffPlanSchema = z.object({
  rationale: z.string().trim().min(1).max(8_000),
  tasks: z.array(TaskSchema).min(2).max(MAX_CHIEF_OF_STAFF_TASKS),
  planningMode: z.enum(["mock", "live"]),
  planningLabel: z.string().trim().min(1).max(100),
}).strict();

export const CreateChiefOfStaffRunSchema = z.object({
  name: z.string().trim().min(1).max(300),
  concurrencyLimit: z.number().int().min(1).max(32),
  executionMode: z.enum(["mock", "live"]),
  originalInstruction: z.string().trim().min(1).max(12_000),
  planningMode: z.enum(["mock", "live"]),
  plan: ChiefOfStaffPlanSchema,
}).strict();

export const ChiefOfStaffModelPlanSchema = z.object({
  rationale: z.string().trim().min(1).max(8_000),
  tasks: z.array(z.object({
    key: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    title: z.string().trim().min(1).max(300),
    instructions: z.string().trim().min(1).max(8_000),
    agentId: z.string().trim().min(1).max(200),
    dependsOn: z.array(z.string().min(1).max(80)).max(MAX_CHIEF_OF_STAFF_TASKS),
    rationale: z.string().trim().min(1).max(2_000),
  }).strict()).min(1).max(MAX_WORK_TASKS),
  finalAgentId: z.string().trim().min(1).max(200),
  finalRationale: z.string().trim().min(1).max(2_000),
}).strict();

export type AgentCapability = {
  id: string;
  name: string;
  role: string;
  description: string;
  instructions: string;
  model: string;
  enabledTools: string[];
  availableDuringExecution: string[];
  unavailableDuringExecution: string[];
  connectedServices: string[];
  skillIds: string[];
  skillsAreMetadataOnly: boolean;
  expectedOutputFormat: string;
};

export type LivePlanGenerator = (input: {
  instruction: string;
  agents: AgentCapability[];
}) => Promise<unknown>;

export class ChiefOfStaffPlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChiefOfStaffPlanningError";
  }
}

export function discoverAgentCapabilities(bots: Bot[], options: { tavilyAvailable?: boolean } = {}): AgentCapability[] {
  return bots.map((bot) => {
    const enabledTools: string[] = [];
    const availableDuringExecution: string[] = [];
    const unavailableDuringExecution: string[] = [];

    if (bot.tools?.webSearch) {
      enabledTools.push("Web search");
      if (options.tavilyAvailable === false) unavailableDuringExecution.push("Web search is configured but unavailable until Tavily is configured.");
      else availableDuringExecution.push("web_search, read_page, crawl_site (read only)");
    }
    if (bot.tools?.codeMode) {
      enabledTools.push("Isolated TypeScript sandbox");
      availableDuringExecution.push("execute_typescript, limited to enabled read-only tools");
    }
    if (bot.tools?.memory) {
      enabledTools.push("Memory");
      unavailableDuringExecution.push("Memory tools are unavailable in persistent execution tasks.");
    }
    if (bot.tools?.browser) {
      enabledTools.push("Browser");
      unavailableDuringExecution.push("Browser control is unavailable in persistent execution tasks.");
    }
    if (bot.tools?.askUser) {
      enabledTools.push("Ask user");
      unavailableDuringExecution.push("Interactive questions are unavailable in persistent execution tasks.");
    }
    if ((bot.connections ?? []).length) {
      enabledTools.push("Connected services: " + bot.connections.join(", "));
      unavailableDuringExecution.push("Connected app and MCP actions are unavailable in persistent execution tasks.");
    }

    return {
      id: bot.id,
      name: bot.name,
      role: bot.title || "General teammate",
      description: bot.description || "",
      instructions: bot.instructions || "",
      model: bot.model,
      enabledTools,
      availableDuringExecution,
      unavailableDuringExecution,
      connectedServices: [...(bot.connections ?? [])],
      skillIds: [...(bot.agentConfig?.skillIds ?? [])],
      skillsAreMetadataOnly: false,
      expectedOutputFormat: bot.agentConfig?.expectedOutputFormat ?? "",
    };
  });
}

function shortLabel(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 88 ? `${compact.slice(0, 85).trimEnd()}…` : compact;
}

function objectivesFor(instruction: string): string[] {
  const lines = instruction.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
  const items = lines.flatMap((line) => line.split(/\s*;\s*/)).filter(Boolean);
  if (items.length > 1) return items.slice(0, MAX_WORK_TASKS);
  const sentences = instruction.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((part) => part.trim()).filter(Boolean);
  if (sentences.length > 1) return sentences.slice(0, MAX_WORK_TASKS);
  return [instruction.trim()];
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

function selectAgent(capabilities: AgentCapability[], objective: string): AgentCapability {
  const target = words(objective);
  const ranked = capabilities.map((agent, index) => {
    const profile = words([agent.name, agent.role, agent.description, agent.instructions].join(" "));
    let score = 0;
    for (const token of target) if (profile.has(token)) score += 1;
    return { agent, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked[0].agent;
}

function deterministicMockPlan(instruction: string, agents: AgentCapability[]): ChiefOfStaffPlan {
  if (!agents.length) throw new ChiefOfStaffPlanningError("Create at least one agent before planning work.");
  const objectives = objectivesFor(instruction);
  const work: ChiefOfStaffTask[] = objectives.map((objective, index) => {
    const taskText = objectives.length === 1
      ? `Analyze and carry out the requested work: ${objective}`
      : `Address this requested objective: ${objective}`;
    const agent = selectAgent(agents, taskText);
    const skillId = skillForObjective(taskText, agent.skillIds);
    const score = [...words(taskText)].filter((token) => words([agent.name, agent.role, agent.description, agent.instructions].join(" ")).has(token)).length;
    return {
      key: `work-${index + 1}`,
      title: objectives.length === 1 ? "Carry out the requested work" : `Address objective ${index + 1}: ${shortLabel(objective)}`,
      instructions: objectives.length === 1
        ? "Analyze the requested outcome and produce the requested work product. Honor the audience, format, constraints, and success criteria in the original business instruction provided with this task."
        : `Complete this objective from the original business instruction provided with this task. Honor its audience, format, constraints, and success criteria.\n\nObjective:\n${objective.slice(0, 7_000)}${objective.length > 7_000 ? "… (refer to the original instruction for the full objective)" : ""}`,
      agentId: agent.id,
      dependsOn: [],
      rationale: score
        ? `Selected ${agent.name} because its configured role, description, or instructions share relevant terms with this objective.`
        : `Selected ${agent.name}; no configured agent profile had a stronger keyword match for this objective.`,
      isFinalConsolidation: false,
      skillId,
    };
  });
  const finalAgent = selectAgent(agents, "synthesize findings and produce a polished final business deliverable");
  const finalTask: ChiefOfStaffTask = {
    key: FINAL_TASK_KEY,
    title: "Consolidate the final deliverable",
    instructions: "Create the final business deliverable requested in the original instruction provided with this task. Synthesize relevant outputs from every prerequisite task, resolve inconsistencies explicitly, follow the requested format and audience, and provide a polished, usable result.",
    agentId: finalAgent.id,
    dependsOn: work.map((task) => task.key),
    rationale: `Selected ${finalAgent.name} to synthesize the completed work into the requested final deliverable.`,
    isFinalConsolidation: true,
  };
  const plan: ChiefOfStaffPlan = {
    rationale: "Deterministic development mock: the instruction was split into explicit objectives when possible, existing agent profiles were matched by keyword overlap, and a final synthesis step was added. This plan was not generated by an LLM.",
    tasks: [...work, finalTask],
    planningMode: "mock",
    planningLabel: "MOCK PLANNING · deterministic development plan · no model call",
  };
  return validateChiefOfStaffPlan(plan, agents.map((agent) => agent.id));
}

function planFromLiveModel(value: unknown, agents: AgentCapability[]): ChiefOfStaffPlan {
  const parsed = ChiefOfStaffModelPlanSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ChiefOfStaffPlanningError(`Live planning returned malformed output${issue?.path.length ? ` at ${issue.path.join(".")}` : ""}: ${issue?.message ?? "schema validation failed"}.`);
  }
  const finalTask: ChiefOfStaffTask = {
    key: FINAL_TASK_KEY,
    title: "Consolidate the final deliverable",
    instructions: "Create the final business deliverable requested in the original instruction provided with this task. Synthesize relevant outputs from every prerequisite task, resolve inconsistencies explicitly, follow the requested format and audience, and provide a polished, usable result.",
    agentId: parsed.data.finalAgentId,
    dependsOn: parsed.data.tasks.map((task) => task.key),
    rationale: parsed.data.finalRationale,
    isFinalConsolidation: true,
  };
  return validateChiefOfStaffPlan({
    rationale: parsed.data.rationale,
    tasks: [...parsed.data.tasks.map((task) => ({ ...task, isFinalConsolidation: false })), finalTask],
    planningMode: "live",
    planningLabel: "LIVE PLANNING · generated by configured model",
  }, agents.map((agent) => agent.id));
}

export function validateChiefOfStaffPlan(plan: unknown, agentIds: string[]): ChiefOfStaffPlan {
  const parsed = ChiefOfStaffPlanSchema.parse(plan);
  const finalTasks = parsed.tasks.filter((task) => task.isFinalConsolidation);
  if (finalTasks.length !== 1 || parsed.tasks.at(-1)?.key !== FINAL_TASK_KEY || finalTasks[0]?.key !== FINAL_TASK_KEY) {
    throw new ChiefOfStaffPlanningError("A plan must end with exactly one final consolidation task.");
  }
  if (parsed.tasks.length > MAX_CHIEF_OF_STAFF_TASKS) throw new ChiefOfStaffPlanningError(`A plan may contain at most ${MAX_CHIEF_OF_STAFF_TASKS} tasks.`);
  const workTasks = parsed.tasks.slice(0, -1);
  if (workTasks.some((task) => task.isFinalConsolidation || task.key === FINAL_TASK_KEY)) {
    throw new ChiefOfStaffPlanningError("Only the final task may be marked as the final consolidation task.");
  }
  const knownAgents = new Set(agentIds);
  for (const task of parsed.tasks) {
    if (!knownAgents.has(task.agentId)) throw new ChiefOfStaffPlanningError(`Task “${task.title}” refers to unknown agent ID ${task.agentId}.`);
    if (new Set(task.dependsOn).size !== task.dependsOn.length) throw new ChiefOfStaffPlanningError(`Task “${task.title}” has duplicate dependencies.`);
  }
  const expectedFinalDependencies = workTasks.map((task) => task.key).sort();
  if ([...finalTasks[0].dependsOn].sort().join("\0") !== expectedFinalDependencies.join("\0")) {
    throw new ChiefOfStaffPlanningError("The final consolidation task must depend on every work task.");
  }
  const runInput: CreateChiefOfStaffRunInput = {
    name: "Chief of Staff plan validation",
    concurrencyLimit: 1,
    executionMode: parsed.planningMode,
    originalInstruction: "Plan validation",
    planningMode: parsed.planningMode,
    plan: parsed,
  };
  try {
    validateExecutionRunInput(executionInputFromPlan(runInput, parsed));
  } catch (error) {
    throw new ChiefOfStaffPlanningError(error instanceof Error ? error.message : "The task dependency graph is invalid.");
  }
  return parsed;
}

function executionInputFromPlan(input: CreateChiefOfStaffRunInput, plan: ChiefOfStaffPlan): CreateExecutionRunInput {
  return {
    name: input.name,
    concurrencyLimit: input.concurrencyLimit,
    executionMode: input.executionMode,
    originalInstruction: input.originalInstruction,
    planningRationale: plan.rationale,
    planningMode: input.planningMode,
    tasks: plan.tasks.map((task) => ({
      key: task.key,
      title: task.title,
      agentId: task.agentId,
      input: {
        instructions: task.instructions,
        planningRationale: task.rationale,
        originalInstruction: input.originalInstruction,
        finalConsolidation: task.isFinalConsolidation,
        skillId: task.skillId,
      },
      dependsOn: task.dependsOn,
      requiresApproval: false,
    })),
  };
}

export async function planChiefOfStaff(input: unknown, options: {
  agents: AgentCapability[];
  generateLivePlan?: LivePlanGenerator;
}): Promise<ChiefOfStaffPlan> {
  const request = ChiefOfStaffRequestSchema.parse(input);
  if (!options.agents.length) throw new ChiefOfStaffPlanningError("Create at least one agent before planning work.");
  if (request.planningMode === "mock") return deterministicMockPlan(request.instruction, options.agents);
  if (!options.generateLivePlan) throw new ChiefOfStaffPlanningError("Live planning is unavailable. Configure an owner-selected live provider and retry in live planning mode.");
  let output: unknown;
  try {
    output = await options.generateLivePlan({ instruction: request.instruction, agents: options.agents });
  } catch (error) {
    throw new ChiefOfStaffPlanningError(`Live planning failed: ${error instanceof Error ? error.message : "the configured model could not complete the request"}. No mock plan was substituted.`);
  }
  return planFromLiveModel(output, options.agents);
}

export function toExecutionRunInput(input: CreateChiefOfStaffRunInput): CreateExecutionRunInput {
  if (input.plan.planningMode !== input.planningMode) throw new ChiefOfStaffPlanningError("Planning mode does not match the generated plan.");
  const plan = validateChiefOfStaffPlan(input.plan, input.plan.tasks.map((task) => task.agentId));
  return executionInputFromPlan(input, plan);
}

