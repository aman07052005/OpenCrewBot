import { requestOllamaStructured } from "./ollama-structured.ts";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelProviderId, ModelRoute } from "@/lib/shared/types";
import { costUsd, findModel } from "./models.ts";
import { allowedCompatibleModel } from "./model-routing.ts";

export interface ProviderUsage { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedInputTokens: number | null; reasoningTokens: number | null; }
export function extractProviderUsage(value: unknown): ProviderUsage {
  const raw = value as Record<string, unknown> | null;
  const number = (key: string) => typeof raw?.[key] === "number" && Number.isSafeInteger(raw[key]) && Number(raw[key]) >= 0 ? Number(raw[key]) : null;
  const inputTokens = number("promptTokens") ?? number("inputTokens") ?? number("prompt_tokens");
  const outputTokens = number("completionTokens") ?? number("outputTokens") ?? number("completion_tokens");
  const totalTokens = number("totalTokens") ?? number("total_tokens") ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  return { inputTokens, outputTokens, totalTokens, cachedInputTokens:number("cachedInputTokens"), reasoningTokens:number("reasoningTokens") };
}
export async function estimatedCost(route: ModelRoute, usage: ProviderUsage): Promise<{ cost: number | null; pricingVersion: string | null }> {
  if (route.providerId === "ollama" || route.providerId === "mock" || usage.inputTokens === null || usage.outputTokens === null) return { cost:null, pricingVersion:null };
  if (route.providerId === "nebius") return { cost:costUsd(await findModel(route.model), usage.inputTokens, usage.outputTokens), pricingVersion:"nebius-catalog" };
  const inputText = process.env.OPENCREWBOT_OPENAI_COMPATIBLE_INPUT_PER_M?.trim(); const outputText = process.env.OPENCREWBOT_OPENAI_COMPATIBLE_OUTPUT_PER_M?.trim();
  if (!inputText || !outputText) return { cost:null, pricingVersion:null };
  const input = Number(inputText); const output = Number(outputText);
  return Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0 ? { cost:(usage.inputTokens * input + usage.outputTokens * output) / 1_000_000, pricingVersion:"owner-configured" } : { cost:null, pricingVersion:null };
}

type ProviderSettings = { baseURL: string; apiKey?: string; local: boolean };
function endpointFor(providerId: ModelProviderId): ProviderSettings {
  if (providerId === "openai-compatible") {
    const baseURL = process.env.OPENCREWBOT_OPENAI_COMPATIBLE_BASE_URL;
    const apiKey = process.env.OPENCREWBOT_OPENAI_COMPATIBLE_API_KEY;
    if (!baseURL || !apiKey) throw new Error("OpenAI-compatible provider is not configured.");
    const url = new URL(baseURL);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("OpenAI-compatible provider endpoint is unsafe.");
    return { baseURL: url.toString().replace(/\/$/, ""), apiKey, local: false };
  }
  if (providerId === "ollama") {
    if (process.env.OPENCREWBOT_OLLAMA_ENABLED !== "1") throw new Error("Ollama provider is not enabled.");
    const url = new URL(process.env.OPENCREWBOT_OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1");
    if (url.protocol !== "http:" || url.username || url.password || !["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "11434") throw new Error("Ollama endpoint must be the configured loopback server.");
    return { baseURL: url.toString().replace(/\/$/, ""), local: true };
  }
  throw new Error(`Provider ${providerId} does not use the OpenAI-compatible adapter.`);
}
function pinnedFetch(settings: ProviderSettings): typeof fetch {
  const allowed = new URL(settings.baseURL).origin;
  return async (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (target.origin !== allowed || target.protocol !== new URL(settings.baseURL).protocol) throw new Error("Provider request escaped the configured endpoint.");
    return fetch(input, { ...init, redirect: "error" });
  };
}

/** Creates an actual AI SDK language model; configuration is entirely server-owned. */
export function languageModelFor(route: ModelRoute) {
  if (route.providerId === "nebius") return `nebius/${route.model}`;
  if (route.providerId === "mock") throw new Error("MOCK is not a fallback for LIVE inference.");
  if (!allowedCompatibleModel(route.providerId, route.model)) throw new Error("Model is not in the owner-configured allowlist.");
  const settings = endpointFor(route.providerId);
  return createOpenAICompatible({ name: route.providerId, baseURL: settings.baseURL, apiKey: settings.apiKey, includeUsage: true, fetch: pinnedFetch(settings) }).chatModel(route.model);
}
/** Native JSON-schema format for local tool-free planning and factory generation. */
export function generateLocalStructured(route: ModelRoute, system: string, prompt: string, schema: object, limits?: { timeoutMs?: number; maxOutputTokens?: number }) {
  if (route.providerId !== "ollama" || !allowedCompatibleModel("ollama", route.model)) throw new Error("Local model is not in the owner-configured allowlist.");
  const settings = endpointFor("ollama");
  return requestOllamaStructured(settings.baseURL, route.model, system, prompt, schema, pinnedFetch(settings), limits);
}
export async function verifyProviderConnection(providerId: Exclude<ModelProviderId, "mock" | "nebius">): Promise<{ models: string[] }> {
  const settings = endpointFor(providerId);
  const response = await pinnedFetch(settings)(new URL("models", `${settings.baseURL}/`), { headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Provider verification failed (${response.status}).`);
  const body = await response.json() as { data?: Array<{ id?: string }> };
  return { models: (body.data ?? []).map((row) => row.id).filter((id): id is string => Boolean(id)).slice(0, 200) };
}
export function isTransientModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(400|401|403|404|405|422)\b|invalid api key|unauthori[sz]ed|forbidden/i.test(message)) return false;
  return /\b(408|409|429|500|502|503|504|timeout|timed out|network|temporar)/i.test(message);
}

/** Owner-only global route for one-shot planning/configuration inference. */
export function globalProviderRoute(kind: "planner" | "agent-factory", fallbackModel: string): ModelRoute {
  const prefix = kind === "planner" ? "OPENCREWBOT_PLANNER" : "OPENCREWBOT_AGENT_FACTORY";
  const providerId = (process.env[`${prefix}_PROVIDER`] ?? "nebius") as ModelProviderId;
  const model = process.env[`${prefix}_MODEL`]?.trim() || fallbackModel;
  if (providerId !== "nebius" && providerId !== "openai-compatible" && providerId !== "ollama") throw new Error(`${prefix}_PROVIDER must select a supported live provider.`);
  if (!model || model.length > 200) throw new Error(`${prefix}_MODEL must select a valid model.`);
  return { providerId, model, category: kind === "planner" ? "planning" : "structured", fallbackAttempt: 0, reason: `Owner-selected ${kind} provider.` };
}
