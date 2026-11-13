import type { AgentFactoryDraft, Bot, BotInput, ModelOption } from "@/lib/shared/types";
import {
  AgentFactoryDraftSchema,
  AgentFactoryError,
  AgentFactoryRequestSchema,
  AgentFactorySaveSchema,
  generateAgentFactoryDraft,
  normalizedAgentName,
  uniqueAgentHandle,
  type AgentFactoryLiveGenerator,
} from "./agent-factory.ts";
import { workforceTemplateDraft, WORKFORCE_TEMPLATES } from "../shared/agent-factory-templates.ts";

export interface AgentFactoryDependencies {
  listBots: () => Promise<Bot[]>;
  createBot: (input: BotInput) => Promise<Bot>;
  listModels: () => Promise<ModelOption[]>;
  defaultModel: string;
  hasLiveKey: () => boolean;
  liveGenerator?: AgentFactoryLiveGenerator;
  redactSecrets?: (value: string) => string;
}

export interface TemplateInstallResult {
  installed: string[];
  alreadyInstalled: string[];
  conflicts: Array<{ templateId: string; agentName: string }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid Agent Factory request.";
}

function scrubText(value: string, redact: (value: string) => string): string {
  return redact(value);
}

function scrubGeneratedValue(value: unknown, redact: (value: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => scrubGeneratedValue(item, redact));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubGeneratedValue(item, redact)]));
  }
  return value;
}

function sanitizeDraft(draft: AgentFactoryDraft, redact: (value: string) => string): AgentFactoryDraft {
  return {
    ...draft,
    name: scrubText(draft.name, redact),
    handle: scrubText(draft.handle, redact),
    title: scrubText(draft.title, redact),
    description: scrubText(draft.description, redact),
    instructions: scrubText(draft.instructions, redact),
    agentConfig: {
      ...draft.agentConfig,
      creationRequest: scrubText(draft.agentConfig.creationRequest, redact),
      expectedOutputFormat: scrubText(draft.agentConfig.expectedOutputFormat, redact),
    },
  };
}

function collisionForTemplate(templateId: string, templateName: string, templateHandle: string, bots: Bot[]): Bot | undefined {
  return bots.find((bot) => bot.agentConfig?.templateId === templateId)
    ?? bots.find((bot) => normalizedAgentName(bot.name) === normalizedAgentName(templateName) || bot.handle.toLowerCase() === templateHandle.toLowerCase());
}

export function createAgentFactoryService(dependencies: AgentFactoryDependencies) {
  const redact = dependencies.redactSecrets ?? ((value: string) => value);
  let installQueue: Promise<void> = Promise.resolve();

  async function generate(input: unknown): Promise<AgentFactoryDraft> {
    let request: ReturnType<typeof AgentFactoryRequestSchema.parse>;
    try {
      request = AgentFactoryRequestSchema.parse(input);
    } catch (error) {
      throw new AgentFactoryError(errorMessage(error));
    }
    if (request.generationMode === "live" && !dependencies.hasLiveKey()) {
      throw new AgentFactoryError("Live agent generation requires NEBIUS_API_KEY. Select mock mode for a deterministic configuration; no fallback is performed.");
    }
    const description = redact(request.description);
    const [bots, models] = await Promise.all([dependencies.listBots(), dependencies.listModels()]);
    const modelIds = models.map((model) => model.id);
    let generateLive = dependencies.liveGenerator;
    if (request.generationMode === "live" && generateLive) {
      const original = generateLive;
      generateLive = async (context) => scrubGeneratedValue(await original(context), redact);
    }
    const draft = await generateAgentFactoryDraft({ ...request, description }, {
      bots,
      modelIds,
      defaultModel: dependencies.defaultModel,
      generateLive,
    });
    return sanitizeDraft(draft, redact);
  }

  async function save(input: unknown): Promise<Bot> {
    let draft: AgentFactoryDraft;
    try {
      draft = AgentFactorySaveSchema.parse(input).draft;
    } catch (error) {
      throw new AgentFactoryError(errorMessage(error));
    }
    if (draft.agentConfig.source === "template" && !WORKFORCE_TEMPLATES.some((template) => template.id === draft.agentConfig.templateId)) {
      throw new AgentFactoryError("Unknown workforce template ID.");
    }
    const models = await dependencies.listModels();
    if (!models.some((model) => model.id === draft.model)) {
      throw new AgentFactoryError(`Model ID ${draft.model} is not in the available model catalog.`);
    }
    const bots = await dependencies.listBots();
    const duplicateName = bots.find((bot) => normalizedAgentName(bot.name) === normalizedAgentName(draft.name));
    if (duplicateName) throw new AgentFactoryError(`An agent named “${duplicateName.name}” already exists. Choose a different name.`);

    const safeDraft = sanitizeDraft(draft, redact);
    const botInput: BotInput = {
      name: safeDraft.name,
      handle: uniqueAgentHandle(safeDraft.handle, bots),
      title: safeDraft.title,
      description: safeDraft.description,
      instructions: safeDraft.instructions,
      emoji: safeDraft.emoji,
      color: safeDraft.color,
      model: safeDraft.model,
      tools: safeDraft.tools,
      connections: [],
      approval: safeDraft.approval,
      agentConfig: safeDraft.agentConfig,
      pinned: safeDraft.pinned,
    };
    return dependencies.createBot(botInput);
  }

  async function installOnce(): Promise<TemplateInstallResult> {
    const models = await dependencies.listModels();
    if (!models.length) throw new AgentFactoryError("No models are available. Configure a model before installing workforce templates.");
    const model = models.some((item) => item.id === dependencies.defaultModel) ? dependencies.defaultModel : models[0].id;
    const result: TemplateInstallResult = { installed: [], alreadyInstalled: [], conflicts: [] };
    let bots = await dependencies.listBots();

    for (const template of WORKFORCE_TEMPLATES) {
      const existing = collisionForTemplate(template.id, template.name, template.handle, bots);
      if (existing?.agentConfig?.templateId === template.id) {
        result.alreadyInstalled.push(template.name);
        continue;
      }
      if (existing) {
        result.conflicts.push({ templateId: template.id, agentName: existing.name });
        continue;
      }

      const draft = AgentFactoryDraftSchema.parse(workforceTemplateDraft(template, model));
      const botInput: BotInput = {
        name: draft.name,
        handle: draft.handle,
        title: draft.title,
        description: draft.description,
        instructions: draft.instructions,
        emoji: draft.emoji,
        color: draft.color,
        model: draft.model,
        tools: draft.tools,
        connections: [],
        approval: draft.approval,
        pinned: draft.pinned,
        agentConfig: draft.agentConfig,
      };
      const bot = await dependencies.createBot(botInput);
      bots = [...bots, bot];
      result.installed.push(bot.name);
    }
    return result;
  }

  function installTemplates(): Promise<TemplateInstallResult> {
    const work = installQueue.then(installOnce);
    installQueue = work.then(() => undefined, () => undefined);
    return work;
  }

  return { generate, save, installTemplates };
}

