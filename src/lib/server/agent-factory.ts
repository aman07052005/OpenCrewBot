import { z } from "zod";
import type { AgentFactoryDraft, AgentFactoryMetadata, Bot, BotTools } from "@/lib/shared/types";
import { AGENT_SKILLS, type AgentSkillId } from "../shared/agent-skills.ts";

export { AGENT_SKILLS };
const skillIds = AGENT_SKILLS.map((skill) => skill.id) as [AgentSkillId, ...AgentSkillId[]];

export const AgentToolsSchema = z.object({
  webSearch: z.boolean(),
  memory: z.boolean(),
  codeMode: z.boolean(),
  browser: z.boolean(),
  askUser: z.boolean(),
}).strict();

const SkillsSchema = z.array(z.enum(skillIds)).max(AGENT_SKILLS.length).refine((ids) => new Set(ids).size === ids.length, "Skill identifiers must be unique.");

export const AgentFactoryMetadataSchema = z.object({
  source: z.enum(["factory", "template"]),
  generationMode: z.enum(["mock", "live", "template"]),
  templateId: z.string().regex(/^[a-z0-9-]{1,60}$/).optional(),
  creationRequest: z.string().trim().min(1).max(4_000),
  skillIds: SkillsSchema,
  memory: z.object({ enabled: z.boolean(), storage: z.literal("markdown") }).strict(),
  expectedOutputFormat: z.string().trim().min(1).max(1_000),
}).strict().superRefine((metadata, context) => {
  if (metadata.source === "template" && !metadata.templateId) {
    context.addIssue({ code: "custom", path: ["templateId"], message: "Template agents need a template ID." });
  }
  if (metadata.source === "factory" && metadata.templateId) {
    context.addIssue({ code: "custom", path: ["templateId"], message: "Factory agents cannot claim a workforce template ID." });
  }
  if (metadata.source === "template" && metadata.generationMode !== "template") {
    context.addIssue({ code: "custom", path: ["generationMode"], message: "Template agents must use template generation mode." });
  }
  if (metadata.source === "factory" && metadata.generationMode === "template") {
    context.addIssue({ code: "custom", path: ["generationMode"], message: "Factory agents need mock or live generation mode." });
  }
});

export const AgentFactoryRequestSchema = z.object({
  description: z.string().trim().min(1, "Describe the agent you want to create.").max(4_000, "Agent descriptions are limited to 4,000 characters."),
  generationMode: z.enum(["mock", "live"]),
}).strict();

export const AgentFactoryModelOutputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(40),
  description: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(8_000),
  model: z.string().trim().min(1).max(200),
  tools: AgentToolsSchema,
  skillIds: SkillsSchema,
  memoryEnabled: z.boolean(),
  expectedOutputFormat: z.string().trim().min(1).max(1_000),
}).strict();

export const AgentFactoryDraftSchema = z.object({
  name: z.string().trim().min(1).max(40),
  handle: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,23}$/).refine((handle) => !["all", "everyone"].includes(handle), "This handle is reserved."),
  title: z.string().trim().min(1).max(40),
  description: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(8_000),
  emoji: z.string().trim().min(1).max(12),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  model: z.string().trim().min(1).max(200),
  tools: AgentToolsSchema,
  connections: z.array(z.string().max(160)).max(40),
  approval: z.enum(["ask", "full"]),
  pinned: z.boolean(),
  agentConfig: AgentFactoryMetadataSchema,
  generationLabel: z.string().trim().min(1).max(120),
}).strict().superRefine((draft, context) => {
  if (draft.agentConfig.memory.enabled !== draft.tools.memory) {
    context.addIssue({ code: "custom", path: ["agentConfig", "memory", "enabled"], message: "Memory metadata must match the Memory tool setting." });
  }
});

export const AgentFactorySaveSchema = z.object({ draft: AgentFactoryDraftSchema }).strict();

export type AgentFactoryModelOutput = z.infer<typeof AgentFactoryModelOutputSchema>;
export type AgentFactoryLiveGenerator = (input: {
  description: string;
  modelIds: string[];
  skills: typeof AGENT_SKILLS;
}) => Promise<unknown>;

export class AgentFactoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentFactoryError";
  }
}

function slug(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "agent";
}

export function uniqueAgentHandle(wanted: string, bots: Pick<Bot, "handle">[]): string {
  const taken = new Set(bots.map((bot) => bot.handle.toLowerCase()));
  const base = slug(wanted);
  if (!["all", "everyone"].includes(base) && !taken.has(base)) return base;
  for (let n = 2; n < 100_000; n++) {
    const suffix = String(n);
    const candidate = `${base.slice(0, 24 - suffix.length)}${suffix}`;
    if (!["all", "everyone"].includes(candidate) && !taken.has(candidate)) return candidate;
  }
  throw new AgentFactoryError("A unique handle could not be generated.");
}

export function normalizedAgentName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function titleCase(text: string): string {
  return text.trim().split(/\s+/).map((part) => part ? `${part[0].toLocaleUpperCase()}${part.slice(1)}` : "").join(" ");
}

function extractNamedAgent(description: string): { name?: string; remaining: string } {
  const quoted = description.match(/\b(?:named|called)\s+(?:"([^"]{1,40})"|'([^']{1,40})'|“([^”]{1,40})”)/iu);
  if (quoted) {
    const name = (quoted[1] ?? quoted[2] ?? quoted[3] ?? "").trim().replace(/\s+/g, " ");
    const start = quoted.index ?? 0;
    return { name: name || undefined, remaining: `${description.slice(0, start)} ${description.slice(start + quoted[0].length)}` };
  }

  const unquoted = description.match(/\b(?:named|called)\s+([\p{L}\p{N}][\p{L}\p{N}_'’-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}_'’-]*){0,2})/iu);
  if (!unquoted) return { remaining: description };
  const rawName = unquoted[1];
  const stopWords = new Set(["who", "that", "which", "to", "for", "as", "is", "specializing", "specialising", "focused", "responsible", "and"]);
  const words = rawName.split(/\s+/);
  const stopAt = words.findIndex((word, index) => index > 0 && stopWords.has(word.toLowerCase()));
  const name = words.slice(0, stopAt < 0 ? words.length : stopAt).join(" ").trim();
  const capturedNameOffset = unquoted[0].lastIndexOf(rawName);
  const start = unquoted.index ?? 0;
  const removalEnd = start + capturedNameOffset + name.length;
  return {
    name: name || undefined,
    remaining: `${description.slice(0, start)} ${description.slice(removalEnd)}`,
  };
}

function roleFromDescription(description: string): string {
  const { remaining } = extractNamedAgent(description);
  let source = remaining
    .replace(/^\s*(?:please\s+)?(?:(?:i|we)(?:'d)?\s+(?:(?:would\s+)?like|want|need)(?:\s+you)?(?:\s+to)?|can\s+you)\s+/i, "")
    .replace(/^\s*(?:please\s+)?(?:create|build|make|design|set\s+up|configure|need|want)\s+(?:(?:me|us)\s+)?/i, "")
    .replace(/^\s*(?:an?|the)\s+(?:(?:artificial intelligence|AI|virtual|digital)\s+)?(?:agent|assistant|bot)\b/i, "")
    .replace(/^[\s,:-]+/, "")
    .replace(/^(?:who|that)\s+is\s+/i, "")
    .trim();

  const focus = source.match(/^(?:who\s+)?(?:that\s+)?speciali[sz](?:e|es|ing)\s+(?:in|on)\s+(.+?)(?=[.!?;]|$)/i)
    ?? source.match(/^(?:focused\s+on|responsible\s+for|working\s+on)\s+(.+?)(?=[.!?;]|$)/i)
    ?? source.match(/^(?:for|to)\s+(?:help\s+(?:with|to)\s+)?(.+?)(?=[.!?;]|$)/i);
  let candidate = focus?.[1];

  if (!candidate) {
    source = source.replace(/^(?:an?|the)\s+/i, "");
    candidate = source.match(/^(.+?)(?=\s+(?:speciali[sz]ing|focused|responsible|who|that|which|for|to)\b|[,;.!?]|$)/i)?.[1];
  }

  const fallback = source.split(/[.!?\n]/)[0];
  const normalized = (candidate || fallback || "Specialist Agent").trim().replace(/\s+/g, " ");
  return titleCase(normalized.slice(0, 40)) || "Specialist Agent";
}

function skillsForDescription(description: string): AgentSkillId[] {
  const value = description.toLowerCase();
  const matches: Array<[RegExp, AgentSkillId]> = [
    [/research|source|market|evidence|verify/, "skill.research"],
    [/analys|interpret|business performance/, "skill.analysis"],
    [/data|spreadsheet|visuali[sz]|calculation/, "skill.data-analysis"],
    [/software|developer|code|repository|engineering/, "skill.software-engineering"],
    [/marketing|campaign|audience|content strategy/, "skill.marketing-strategy"],
    [/financial|finance|revenue|forecast|business performance/, "skill.financial-analysis"],
    [/quality|review|fact|error|check/, "skill.quality-review"],
    [/write|draft|content|communication/, "skill.writing"],
    [/plan|strategy|roadmap/, "skill.planning"],
  ];
  return matches.filter(([pattern]) => pattern.test(value)).map(([, id]) => id);
}

function mockOutput(description: string, modelIds: string[], defaultModel: string): AgentFactoryModelOutput {
  const role = roleFromDescription(description);
  const namedAgent = extractNamedAgent(description).name;
  const tools: BotTools = {
    webSearch: /research|market|current|sources|competitive|industry|verify|audience/i.test(description),
    memory: true,
    codeMode: /data|spreadsheet|calculat|forecast|financial|software|code|analysis/i.test(description),
    browser: false,
    askUser: true,
  };
  const output = description.match(/\b(?:format|output)\s+(?:as|in|should be)\s+([^.!?\n]{1,120})/i)?.[1];
  const model = modelIds.includes(defaultModel) ? defaultModel : modelIds[0];
  return {
    name: namedAgent || role,
    title: role,
    description: description.replace(/\s+/g, " ").slice(0, 200),
    instructions: `You are a ${role}. Help with the request described below. Be accurate, explain uncertainty, and use only the tools that are enabled for this agent. Follow the user's requested audience and format.\n\nAgent brief:\n${description}`.slice(0, 8_000),
    model,
    tools,
    skillIds: skillsForDescription(description),
    memoryEnabled: true,
    expectedOutputFormat: output?.trim() || "A clear, structured response with a brief summary and useful next steps.",
  };
}

function materializeDraft(output: AgentFactoryModelOutput, input: { description: string; generationMode: "mock" | "live" }, bots: Bot[]): AgentFactoryDraft {
  const metadata: AgentFactoryMetadata = {
    source: "factory",
    generationMode: input.generationMode,
    creationRequest: input.description,
    skillIds: output.skillIds,
    memory: { enabled: output.memoryEnabled, storage: "markdown" },
    expectedOutputFormat: output.expectedOutputFormat,
  };
  return {
    name: output.name,
    handle: uniqueAgentHandle(output.name, bots),
    title: output.title,
    description: output.description,
    instructions: output.instructions,
    emoji: "🤖",
    color: "#3b82f6",
    model: output.model,
    tools: { ...output.tools, memory: output.memoryEnabled },
    connections: [],
    approval: "ask",
    pinned: false,
    agentConfig: metadata,
    generationLabel: input.generationMode === "mock" ? "MOCK · deterministic configuration · no model call" : "LIVE · generated by configured model",
  };
}

export async function generateAgentFactoryDraft(input: unknown, options: {
  bots: Bot[];
  modelIds: string[];
  defaultModel: string;
  generateLive?: AgentFactoryLiveGenerator;
}): Promise<AgentFactoryDraft> {
  const request = AgentFactoryRequestSchema.parse(input);
  if (!options.modelIds.length) throw new AgentFactoryError("No models are available. Configure a model before creating an agent.");
  let output: unknown;
  if (request.generationMode === "mock") {
    output = mockOutput(request.description, options.modelIds, options.defaultModel);
  } else {
    if (!options.generateLive) throw new AgentFactoryError("Live agent generation is unavailable. Configure NEBIUS_API_KEY and retry in live mode.");
    try {
      output = await options.generateLive({ description: request.description, modelIds: options.modelIds, skills: AGENT_SKILLS });
    } catch (error) {
      throw new AgentFactoryError(`Live agent generation failed: ${error instanceof Error ? error.message : "the configured model could not complete the request"}. No mock configuration was substituted.`);
    }
  }

  const parsed = AgentFactoryModelOutputSchema.safeParse(output);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AgentFactoryError(`Agent generation returned malformed configuration${issue?.path.length ? ` at ${issue.path.join(".")}` : ""}: ${issue?.message ?? "schema validation failed"}.`);
  }
  if (!options.modelIds.includes(parsed.data.model)) throw new AgentFactoryError(`Generated model ID ${parsed.data.model} is not in the available model catalog.`);
  const draft = materializeDraft(parsed.data, request, options.bots);
  const validated = AgentFactoryDraftSchema.safeParse(draft);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    throw new AgentFactoryError(`Generated configuration failed validation${issue?.path.length ? ` at ${issue.path.join(".")}` : ""}: ${issue?.message ?? "invalid configuration"}.`);
  }
  return validated.data;
}

