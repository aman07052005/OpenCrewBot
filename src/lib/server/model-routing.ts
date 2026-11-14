import type { AgentModelConfig, Bot, ModelProviderId, ModelProviderStatus, ModelRoute, TaskCategory } from "@/lib/shared/types";
import { keys } from "./config.ts";
import { findModel, listModels } from "./models.ts";

const PROVIDERS: Record<ModelProviderId, Omit<ModelProviderStatus, "models" | "status" | "lastVerifiedAt" | "error">> = {
  nebius: { id:"nebius", name:"Nebius Token Factory", kind:"hosted" },
  "openai-compatible": { id:"openai-compatible", name:"Owner-configured OpenAI-compatible", kind:"hosted" },
  ollama: { id:"ollama", name:"Local Ollama", kind:"local" },
  mock: { id:"mock", name:"Deterministic MOCK", kind:"simulated" },
};
const split = (value?: string) => value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
function trustedHostedEndpoint(value: string | undefined): boolean { try { const url = new URL(value ?? ""); return url.protocol === "https:" && !url.username && !url.password && Boolean(url.hostname); } catch { return false; } }
function trustedOllamaEndpoint(value: string | undefined): boolean { try { const url = new URL(value ?? "http://127.0.0.1:11434/v1"); return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") && !url.username && !url.password && url.port === "11434"; } catch { return false; } }

export function configuredProviderIds(): ModelProviderId[] {
  const ids: ModelProviderId[] = ["mock"];
  if (keys.nebius()) ids.push("nebius");
  if (keys.openaiCompatible() && trustedHostedEndpoint(process.env.OPENCREWBOT_OPENAI_COMPATIBLE_BASE_URL)) ids.push("openai-compatible");
  if (process.env.OPENCREWBOT_OLLAMA_ENABLED === "1" && trustedOllamaEndpoint(process.env.OPENCREWBOT_OLLAMA_BASE_URL)) ids.push("ollama");
  return ids;
}
export async function listProviders(): Promise<ModelProviderStatus[]> {
  const nebiusModels = await listModels();
  return (Object.keys(PROVIDERS) as ModelProviderId[]).map((id) => {
    const configured = configuredProviderIds().includes(id);
    const models = id === "nebius" ? nebiusModels : id === "mock" ? [{ id:"mock", label:"Deterministic mock", provider:"OpenCrewBot", context:0, tools:false, reasoning:false, vision:false, inputPerM:null, outputPerM:null, live:false }] : split(id === "ollama" ? process.env.OPENCREWBOT_OLLAMA_MODELS : process.env.OPENCREWBOT_OPENAI_COMPATIBLE_MODELS).map((model) => ({ id:model,label:model,provider:PROVIDERS[id].name,context:0,tools:false,reasoning:false,vision:false,inputPerM:null,outputPerM:null,live:false }));
    return { ...PROVIDERS[id], models, status: id === "mock" ? "verified" : configured ? (id === "nebius" && keys.nebius() ? "configured-unverified" : "configured-unverified") : "unconfigured", lastVerifiedAt:null, error:null };
  });
}
export function classifyTask(input: unknown): TaskCategory { const task = input && typeof input === "object" ? input as Record<string, unknown> : null; const text = typeof input === "string" ? input : typeof task?.instructions === "string" ? task.instructions : JSON.stringify(input ?? ""); if (/code|typescript|bug|repository/i.test(text)) return "coding"; if (/calcul|math|forecast|financial/i.test(text)) return "math"; if (/research|source|search/i.test(text)) return "research"; if (/plan|decompose/i.test(text)) return "planning"; if (/json|schema|structured/i.test(text)) return "structured"; if (/write|draft|email/i.test(text)) return "writing"; if (/tool|browser|mcp/i.test(text)) return "tools"; return "general"; }
const CATEGORIES: TaskCategory[] = ["general", "planning", "research", "coding", "math", "writing", "structured", "tools"];

/** Compatible model IDs are explicitly allowlisted by the owner. */
export function allowedCompatibleModel(providerId: ModelProviderId, model: string): boolean {
  if (providerId === "openai-compatible") return split(process.env.OPENCREWBOT_OPENAI_COMPATIBLE_MODELS).includes(model);
  if (providerId === "ollama") return split(process.env.OPENCREWBOT_OLLAMA_MODELS).includes(model);
  return providerId === "nebius";
}

export async function resolveModelRoutes(bot: Bot, taskInput?: unknown): Promise<ModelRoute[]> {
  const config: AgentModelConfig = bot.modelConfig ?? { providerId:"nebius", primaryModel:bot.model, routingMode:"fixed" };
  validateModelConfig(config);
  const category = classifyTask(taskInput);
  const primary = { providerId:config.providerId, model:config.primaryModel, preferredCategory:undefined as TaskCategory | undefined };
  const candidates = [primary, ...(config.fallbackModels ?? [])];
  const configured = configuredProviderIds();
  const compatible: typeof candidates = [];
  for (const candidate of candidates) {
    if (candidate.providerId === "mock" || !configured.includes(candidate.providerId) || (config.localOnly && candidate.providerId !== "ollama")) continue;
    if (!allowedCompatibleModel(candidate.providerId, candidate.model)) continue;
    if (candidate.providerId === "nebius" && !(await findModel(candidate.model))) continue;
    if (!compatible.some((c) => c.providerId === candidate.providerId && c.model === candidate.model)) compatible.push({ ...candidate, preferredCategory:candidate.preferredCategory });
  }
  if (!compatible.length) throw new Error("No configured, allowlisted live model satisfies this agent's settings.");
  const preferred = config.routingMode === "automatic" ? compatible.find((c) => c.preferredCategory === category) : undefined;
  const chosen = preferred ?? compatible.find((c) => c.providerId === primary.providerId && c.model === primary.model);
  if (!chosen) throw new Error("The primary model is unavailable or not allowlisted. Check owner model configuration.");
  const ordered = [chosen, ...compatible.filter((c) => c !== chosen)];
  return ordered.map(({providerId, model}, index) => ({ providerId, model, category, fallbackAttempt:index,
    reason:index ? `Owner-authorized fallback ${index} after transient inference failure.` : preferred ? `Automatic route: owner-designated ${category} model.` : config.routingMode === "automatic" ? `Automatic route: no designated ${category} model; primary selected.` : "Owner selected fixed primary model." }));
}
export async function resolveModelRoute(bot: Bot, taskInput?: unknown): Promise<ModelRoute> {
  return (await resolveModelRoutes(bot, taskInput))[0];
}
export function validateModelConfig(config: AgentModelConfig): void {
  if (!config || !Object.hasOwn(PROVIDERS, config.providerId) || config.providerId === "mock" || typeof config.primaryModel !== "string" || !config.primaryModel.trim() || config.primaryModel.length > 200) throw new Error("Choose a configured provider and valid live model.");
  if (!['fixed','automatic'].includes(config.routingMode) || (config.maxOutputTokens !== undefined && (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens < 1 || config.maxOutputTokens > 100_000))) throw new Error("Model routing limits are invalid.");
  if (config.maxEstimatedCostUsd !== undefined) throw new Error("Hard cost budgets are not supported and cannot be configured.");
  if (config.localOnly !== undefined && typeof config.localOnly !== "boolean") throw new Error("Local-only setting is invalid.");
  if (config.localOnly && config.providerId !== "ollama") throw new Error("Local-only inference requires an Ollama primary model.");
  if (config.fallbackModels !== undefined && (!Array.isArray(config.fallbackModels) || config.fallbackModels.length > 5)) throw new Error("Configure at most five fallback models.");
  for (const fallback of config.fallbackModels ?? []) {
    if (!fallback || !Object.hasOwn(PROVIDERS, fallback.providerId) || fallback.providerId === "mock" || typeof fallback.model !== "string" || !fallback.model.trim() || fallback.model.length > 200 || (fallback.preferredCategory !== undefined && !CATEGORIES.includes(fallback.preferredCategory))) throw new Error("Fallback model is invalid.");
    if (config.localOnly && fallback.providerId !== "ollama") throw new Error("Local-only inference cannot use hosted fallbacks.");
  }
}
