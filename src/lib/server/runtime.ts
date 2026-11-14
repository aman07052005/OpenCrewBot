// The agent harness glue. Mastra's AgentController owns the agent loop,
// sessions, thread history, tool approvals and ask-user suspensions. This file
// gives each bot one controller, each conversation one session, and folds the
// controller's events into the chat messages the UI renders.
import { Agent } from "@mastra/core/agent";
import { AgentController, type AgentControllerEvent, type Session } from "@mastra/core/agent-controller";
import type { MastraBrowser } from "@mastra/core/browser";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { randomUUID } from "node:crypto";
import type { Bot, ChatMessage, ConversationId, ModelRoute, Part, RouteNote } from "@/lib/shared/types";
import { MASTRA_DB_URL, OWNER_ID, isMock } from "./config";
import { conversationGeneration, getBot, saveMessage } from "./db";
import { publish } from "./bus";
import { findModel } from "./models";
import { createMockModel } from "./mock-model";
import { announceLiveView, createSession, releaseSession } from "./browserbase";
import { buildConnectorTools, connectionsVersion } from "./connectors";
import { systemPrompt } from "./prompt";
import { conversationSharedMemory } from "./scoped-memory-service";
import { buildExecutionTools, buildTools, toolCategory, toolLabel, toolPreview, toolSources } from "./tools";
import { executionToolCategory, restrictExecutionPermissions } from "./execution-permissions";
import type { ExecutionTask } from "./execution-engine";
import { resolveModelRoute, resolveModelRoutes } from "./model-routing";
import { recordModelUsage } from "./model-usage";
import { estimatedCost, extractProviderUsage, isTransientModelError, languageModelFor } from "./provider-runtime";

// ── shared state that must survive Next.js hot reloads ─────────────────

interface BotRuntime {
  signature: string;
  modelRoute: ModelRoute;
  /** The latest saved bot; the system prompt reads it on every model call. */
  holder: { bot: Bot };
  controller: AgentController;
  ready: Promise<void>;
  /** Disconnects the bot's MCP servers. */
  closeConnectors: () => Promise<void>;
}

interface State {
  storage: LibSQLStore;
  runtimes: Map<string, BotRuntime>;
  /** `${conversationId}|${botId}` → live session */
  sessions: Map<string, Session>;
  /** `${conversationId}|${botId}` → tail of that bot's turn queue */
  chains: Map<string, Promise<unknown>>;
  /** conversationId → bots with a turn in flight */
  running: Map<ConversationId, Set<string>>;
  /** `${conversationId}|${botId}` → the turn currently folding events */
  folders: Map<string, TurnFolder>;
  /** conversationId → bumped by Stop, so turns queued before it never start */
  stopEpoch: Map<ConversationId, number>;
}

const g = globalThis as unknown as { __opencrewbotRuntime?: State; __opencrewbotRuntimeLocks?: Map<string, Promise<unknown>> };
const runtimeLocks = (g.__opencrewbotRuntimeLocks ??= new Map());
const state: State = (g.__opencrewbotRuntime ??= {
  storage: new LibSQLStore({ id: "opencrewbot-mastra", url: MASTRA_DB_URL }),
  runtimes: new Map(),
  sessions: new Map(),
  chains: new Map(),
  running: new Map(),
  folders: new Map(),
  stopEpoch: new Map(),
});

const key = (conversationId: ConversationId, botId: string) => `${conversationId}|${botId}`;

// ── one controller per bot ──────────────────────────────────────────────

/** Settings that need a new controller when they change. Persona text doesn't:
 * the system prompt is rebuilt from the latest bot on every model call. */
async function signatureOf(bot: Bot): Promise<string> {
  // Model objects are captured by Agent construction; changing settings requires a new controller.
  return JSON.stringify({
    model: bot.model,
    modelConfig: bot.modelConfig,
    tools: bot.tools,
    approval: bot.approval,
    connections: bot.connections,
    connectionsVersion: bot.connections.length ? await connectionsVersion() : 0,
    mock: isMock(),
  });
}

/** A Browserbase cloud browser, reached over CDP. The session starts on the
 * bot's first browser action and is released when its controller closes. */
async function createBrowser(bot: Bot, route: ModelRoute): Promise<MastraBrowser | undefined> {
  if (!bot.tools.browser) return undefined;
  const { AgentBrowser } = await import("@mastra/agent-browser");
  const model = route.providerId === "nebius" ? await findModel(route.model) : undefined;
  return new AgentBrowser({
    cdpUrl: () => createSession(bot.id),
    scope: "shared",
    onLaunch: () => announceLiveView(bot.id),
    onClose: () => releaseSession(bot.id),
    // A screenshot comes back as an image, which text-only models can't read.
    excludeTools: model?.vision ? [] : ["browser_screenshot"],
  }) as unknown as MastraBrowser;
}

async function buildRuntime(bot: Bot, route: ModelRoute): Promise<BotRuntime> {
  const holder = { bot };
  const memory = new Memory({ storage: state.storage, options: { lastMessages: 40 } });
  const builtIn = buildTools(bot);
  const connectors = await buildConnectorTools(bot, `bot-${bot.id}-${Date.now()}`);
  const capabilities = [...builtIn.capabilities, ...connectors.capabilities];
  const agent = new Agent({
    id: `bot-${bot.id}`,
    name: bot.name,
    instructions: () => systemPrompt(holder.bot, capabilities, builtIn.instructions),
    model: isMock() ? createMockModel(bot.name) : languageModelFor(route),
    defaultOptions: bot.modelConfig?.maxOutputTokens ? { modelSettings: { maxOutputTokens: bot.modelConfig.maxOutputTokens } } : undefined,
    tools: { ...connectors.tools, ...builtIn.tools },
    memory,
  });
  const browser = await createBrowser(bot, route);
  const controller = new AgentController({
    id: `controller-${bot.id}`,
    agent,
    storage: state.storage,
    modes: [{ id: "chat", name: "Chat", metadata: { default: true } }],
    browser,
    toolCategoryResolver: toolCategory,
    disableBuiltinTools: [
      "submit_plan",
      "task_write",
      "task_update",
      "task_complete",
      "task_check",
      "subagent",
      ...(bot.tools.askUser ? [] : (["ask_user"] as const)),
    ],
  });
  return { signature: await signatureOf(bot), modelRoute:route, holder, controller, ready: controller.init(), closeConnectors: connectors.close };
}

function isBotBusy(botId: string): boolean {
  for (const bots of state.running.values()) if (bots.has(botId)) return true;
  return false;
}

async function dropRuntime(botId: string): Promise<void> {
  const runtime = state.runtimes.get(botId);
  if (!runtime) return;
  state.runtimes.delete(botId);
  for (const k of [...state.sessions.keys()]) if (k.endsWith(`|${botId}`)) state.sessions.delete(k);
  await runtime.controller.destroy().catch(() => {});
  await runtime.closeConnectors().catch(() => {});
  await releaseSession(botId);
}

async function runtimeFor(bot: Bot, conversationId: ConversationId, modelRoute: ModelRoute): Promise<BotRuntime> {
  let runtime = state.runtimes.get(bot.id);
  if (runtime && (runtime.signature !== (await signatureOf(bot)) || runtime.modelRoute?.providerId !== modelRoute.providerId || runtime.modelRoute?.model !== modelRoute.model)) {
    // The current turn is already registered as running. Never destroy another active conversation.
    if ([...state.running].some(([id, bots]) => id !== conversationId && bots.has(bot.id))) throw new Error("Another conversation is using this agent. Finish that turn before switching models.");
    await dropRuntime(bot.id);
    runtime = undefined;
  }
  if (!runtime) {
    runtime = await buildRuntime(bot, modelRoute);
    state.runtimes.set(bot.id, runtime);
  }
  runtime.holder.bot = bot;
  await runtime.ready;
  return runtime;
}

async function sessionFor(bot: Bot, conversationId: ConversationId, modelRoute: ModelRoute): Promise<Session> {
  const previous = runtimeLocks.get(bot.id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => openSession(bot, conversationId, modelRoute));
  runtimeLocks.set(bot.id, next);
  try { return await next; } finally { if (runtimeLocks.get(bot.id) === next) runtimeLocks.delete(bot.id); }
}

async function openSession(bot: Bot, conversationId: ConversationId, modelRoute: ModelRoute): Promise<Session> {
  const runtime = await runtimeFor(bot, conversationId, modelRoute);
  const generation = await conversationGeneration(conversationId);
  const threadId = `${conversationId}:${bot.id}:${generation}`;
  const k = key(conversationId, bot.id);
  const cached = state.sessions.get(k);
  if (cached && cached.thread.getId() === threadId) return cached;
  const session = await runtime.controller.createSession({ resourceId: OWNER_ID, scope: conversationId, threadId });
  await session.permissions.setForCategory({ category: "read", policy: "allow" });
  await session.permissions.setForCategory({ category: "edit", policy: "allow" });
  await session.permissions.setForCategory({ category: "other", policy: "allow" });
  // Connected apps and MCP servers act on real accounts: ask first unless the bot has full access.
  // These provider-level actions are not persistent Module G action records yet.
  // Keep their existing human prompt even for Full Access rather than bypassing the central boundary.
  await session.permissions.setForCategory({ category: "mcp", policy: "ask" });
  await session.permissions.setForCategory({ category: "execute", policy: "ask" });
  state.sessions.set(k, session);
  return session;
}

export interface IsolatedExecutionRequest {
  bot: Bot;
  task: ExecutionTask;
  content: string;
  sessionId: string;
  signal: AbortSignal;
}

export interface IsolatedExecutionResult {
  text: string;
  model: string;
}

/** Run one live task in a fresh controller, session, resource, and thread. */
export async function runIsolatedExecutionTask(request: IsolatedExecutionRequest): Promise<IsolatedExecutionResult> {
  if (request.signal.aborted) throw request.signal.reason ?? new Error("Task cancelled.");
  const routes = await resolveModelRoutes(request.bot, request.task.input);
  let lastError: unknown;
  for (const [index, route] of routes.entries()) {
    try { return await runIsolatedExecutionAttempt(request, route); }
    catch (error) {
      lastError = error;
      // A streamed response, cancellation, validation/auth error, or final attempt
      // is not a safe inference boundary for a provider retry.
      if (request.signal.aborted || index === routes.length - 1 || !isTransientModelError(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All configured model attempts failed.");
}

async function runIsolatedExecutionAttempt(request: IsolatedExecutionRequest, route: ModelRoute): Promise<IsolatedExecutionResult> {
  if (request.signal.aborted) throw request.signal.reason ?? new Error("Task cancelled.");

  const { bot, task, signal } = request;
  const sessionId = route.fallbackAttempt ? `${request.sessionId}:fallback:${route.fallbackAttempt}` : request.sessionId;
  const began = Date.now();
  const safeTools = buildExecutionTools(bot);
  const capabilities = [
    ...safeTools.capabilities,
    "Task sessions may only use the explicitly enabled read-only tools; external actions, browser control, app connections, and memory writes are disabled.",
  ];
  const memory = new Memory({ storage: state.storage, options: { lastMessages: 20 } });
  const agent = new Agent({
    id: `execution-agent-${task.id}-${task.attempts}-${route.fallbackAttempt}`,
    name: bot.name,
    instructions: () => systemPrompt(bot, capabilities, safeTools.instructions, { allowAskUser: false, memoryReadOnly: true }),
    model: languageModelFor(route),
    defaultOptions: bot.modelConfig?.maxOutputTokens ? { modelSettings: { maxOutputTokens: bot.modelConfig.maxOutputTokens } } : undefined,
    tools: safeTools.tools,
    memory,
  });
  const controller = new AgentController({
    id: `execution-controller-${task.id}-${task.attempts}-${route.fallbackAttempt}`,
    agent,
    storage: state.storage,
    modes: [{ id: "execution", name: "Execution", metadata: { default: true } }],
    toolCategoryResolver: executionToolCategory,
    disableBuiltinTools: ["submit_plan", "task_write", "task_update", "task_complete", "task_check", "subagent", "ask_user"],
  });

  let session: Session | undefined;
  let unsubscribe: (() => void) | undefined;
  let endReason: "complete" | "aborted" | "error" | "suspended" | undefined;
  let runtimeError: string | undefined;
  let text = "";
  let toolActivity = false;
  let reasoningActivity = false;
  let latestUsage: unknown = null;
  let abortListener: (() => void) | undefined;

  try {
    await controller.init();
    session = await controller.createSession({
      resourceId: sessionId,
      ownerId: OWNER_ID,
      id: sessionId,
      scope: sessionId,
      threadId: sessionId,
      createInitialThread: true,
    });
    await restrictExecutionPermissions(session.permissions);
    unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.event.type === "text-delta") text += event.event.delta;
      if (event.type === "message_update" && event.event.type === "reasoning-delta") reasoningActivity = true;
      if (event.type === "tool_start" || event.type === "tool_end" || event.type === "tool_approval_required" || event.type === "tool_suspended") toolActivity = true;
      if (event.type === "usage_update") latestUsage = event.usage;
      if (event.type === "agent_end") endReason = event.reason;
      if (event.type === "error") runtimeError = event.error?.message || "Mastra agent execution failed.";
    });

    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => {
        try { session?.abort(); } catch { /* the session may already be idle */ }
        reject(signal.reason ?? new Error("Task cancelled."));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    });
    if (signal.aborted) abortListener?.();
    await Promise.race([session.sendMessage({ content: request.content }), aborted]);

    if (signal.aborted) throw signal.reason ?? new Error("Task cancelled.");
    if (endReason !== "complete") {
      throw new Error(runtimeError ?? (endReason === "suspended"
        ? "The task requested an approval or user answer that is not available in execution sessions."
        : endReason === "aborted" ? "Mastra execution was aborted." : "Mastra ended without a successful completion event."));
    }
    if (!text.trim()) throw new Error(runtimeError ?? "Mastra completed without producing text output.");
    const usage = extractProviderUsage(latestUsage); const pricing = await estimatedCost(route, usage);
    await recordModelUsage({ agentId:bot.id, conversationId:null, executionRunId:task.runId, taskId:task.id, providerId:route.providerId, model:route.model, inputTokens:usage.inputTokens, outputTokens:usage.outputTokens, totalTokens:usage.totalTokens, cachedInputTokens:usage.cachedInputTokens, reasoningTokens:usage.reasoningTokens, usageKind:usage.totalTokens === null ? "unknown" : "reported", durationMs:Date.now()-began, success:true, fallbackAttempt:route.fallbackAttempt, estimatedCostUsd:pricing.cost, currency:"USD", pricingVersion:pricing.pricingVersion, routingReason:route.reason, error:null }).catch((err: unknown) => console.error("Model usage persistence failed", err instanceof Error ? err.name : "error"));
    return { text: text.trim(), model: route.model };
  } catch (error) {
    const usage = extractProviderUsage(latestUsage);
    const pricing = await estimatedCost(route, usage).catch(() => ({ cost:null, pricingVersion:null }));
    await recordModelUsage({ agentId:bot.id, conversationId:null, executionRunId:task.runId, taskId:task.id, providerId:route.providerId, model:route.model, ...usage, usageKind:usage.totalTokens !== null || usage.inputTokens !== null || usage.outputTokens !== null ? "reported" : "unknown", durationMs:Date.now()-began, success:false, fallbackAttempt:route.fallbackAttempt, estimatedCostUsd:pricing.cost, currency:"USD", pricingVersion:pricing.pricingVersion, routingReason:route.reason, error:"Model call failed" }).catch((err: unknown) => console.error("Model usage persistence failed", err instanceof Error ? err.name : "error"));
    if (toolActivity) throw new Error("Tool activity occurred; fallback is suppressed to avoid replaying an uncertain run.");
    if (text.length || reasoningActivity) throw new Error("Partial model output was received; fallback is suppressed to avoid replaying an uncertain run.");
    throw error;
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
    unsubscribe?.();
    try { session?.abort(); } catch { /* already completed */ }
    await controller.destroy().catch(() => {});
  }
}

// ── running state ──────────────────────────────────────────────────────

function setRunning(conversationId: ConversationId, botId: string, on: boolean) {
  const bots = state.running.get(conversationId) ?? new Set<string>();
  if (on) bots.add(botId);
  else bots.delete(botId);
  if (bots.size) state.running.set(conversationId, bots);
  else state.running.delete(conversationId);
  publish({ type: "running", conversationId, botIds: [...bots] });
}

/** Changes whenever Stop is pressed in this conversation. */
export function stopEpochOf(conversationId: ConversationId): number {
  return state.stopEpoch.get(conversationId) ?? 0;
}

export function runningBots(conversationId: ConversationId): string[] {
  return [...(state.running.get(conversationId) ?? [])];
}

// ── folding controller events into one chat message per turn ────────────

class TurnFolder {
  readonly message: ChatMessage;
  private textPart = new Map<string, number>();
  private reasoningPart = new Map<string, number>();
  private toolPart = new Map<string, number>();
  private usage = extractProviderUsage(null);
  private modelRoute?: ModelRoute;
  private readonly bot: Bot;
  private resolveDone!: (m: ChatMessage) => void;
  readonly done = new Promise<ChatMessage>((r) => (this.resolveDone = r));
  finished = false;

  constructor(conversationId: ConversationId, bot: Bot, route?: RouteNote) {
    this.bot = bot;
    this.message = {
      id: randomUUID(),
      conversationId,
      role: "bot",
      botId: bot.id,
      createdAt: new Date().toISOString(),
      status: "streaming",
      parts: [],
      model: isMock() ? "mock" : (bot.modelConfig?.primaryModel ?? bot.model),
      route,
    };
  }

  setModelRoute(route: ModelRoute) {
    this.modelRoute = route;
    this.message.model = route.model;
    this.emit(true);
  }

  private emit(persist = false) {
    publish({ type: "message", message: this.message });
    if (persist) void saveMessage(this.message);
  }

  private streamInto(kind: "text" | "reasoning", sourceId: string, delta: string) {
    const index = kind === "text" ? this.textPart : this.reasoningPart;
    let i = index.get(sourceId);
    const last = this.message.parts.length - 1;
    // Start a new part when another part (a tool call) came in between.
    if (i === undefined || i !== last) {
      this.message.parts.push({ kind, text: "" });
      i = this.message.parts.length - 1;
      index.set(sourceId, i);
      this.emit();
    }
    const part = this.message.parts[i] as { text: string };
    part.text += delta;
    publish({ type: "delta", conversationId: this.message.conversationId, messageId: this.message.id, partIndex: i, kind, delta });
  }

  private tool(toolCallId: string): Extract<Part, { kind: "tool" }> | undefined {
    const i = this.toolPart.get(toolCallId);
    return i === undefined ? undefined : (this.message.parts[i] as Extract<Part, { kind: "tool" }>);
  }

  waitingOnPerson(): boolean {
    return this.message.parts.some(
      (p) => (p.kind === "tool" && p.status === "awaiting-approval") || (p.kind === "question" && p.answer === undefined),
    );
  }

  handle(event: AgentControllerEvent) {
    if (this.finished) return;
    switch (event.type) {
      case "message_update": {
        if (event.event.type === "text-delta") this.streamInto("text", event.id, event.event.delta);
        else if (event.event.type === "reasoning-delta") this.streamInto("reasoning", event.id, event.event.delta);
        break;
      }
      case "tool_start": {
        if (event.toolName === "ask_user" || this.toolPart.has(event.toolCallId)) break;
        const { label, detail } = toolLabel(event.toolName, event.args);
        this.message.parts.push({ kind: "tool", toolCallId: event.toolCallId, name: event.toolName, label, detail, status: "running" });
        this.toolPart.set(event.toolCallId, this.message.parts.length - 1);
        this.emit(true);
        break;
      }
      case "tool_approval_required": {
        let part = this.tool(event.toolCallId);
        if (!part) {
          const { label, detail } = toolLabel(event.toolName, event.args);
          this.message.parts.push({ kind: "tool", toolCallId: event.toolCallId, name: event.toolName, label, detail, status: "awaiting-approval" });
          this.toolPart.set(event.toolCallId, this.message.parts.length - 1);
          part = this.tool(event.toolCallId);
        }
        part!.status = "awaiting-approval";
        this.emit(true);
        break;
      }
      case "tool_suspended": {
        if (event.toolName !== "ask_user") break;
        const payload = (event.suspendPayload ?? {}) as { question?: string; options?: { label: string; description?: string }[] };
        this.message.parts.push({
          kind: "question",
          toolCallId: event.toolCallId,
          question: payload.question ?? String((event.args as { question?: string })?.question ?? "The bot has a question."),
          options: payload.options ?? [],
        });
        this.emit(true);
        break;
      }
      case "tool_end": {
        const part = this.tool(event.toolCallId);
        if (!part) break;
        part.status = event.denied ? "denied" : event.isError ? "error" : "done";
        part.preview = toolPreview(event.result);
        part.sources = toolSources(event.result);
        this.emit(true);
        break;
      }
      case "usage_update": {
        // Cumulative snapshots: never sum successive events or turn unknown into zero.
        this.usage = extractProviderUsage(event.usage);
        break;
      }
      case "error": {
        this.message.error = event.error?.message || "The model returned an error.";
        break;
      }
      case "agent_end": {
        if (event.reason === "suspended") {
          this.emit(true);
          break;
        }
        void this.finish(event.reason === "aborted" ? "stopped" : event.reason === "error" ? "error" : "done");
        break;
      }
    }
  }

  answer(toolCallId: string, answer: string) {
    const part = this.message.parts.find((p) => p.kind === "question" && p.toolCallId === toolCallId);
    if (part && part.kind === "question") part.answer = answer;
    this.emit(true);
  }

  async finish(status: ChatMessage["status"], error?: string) {
    if (this.finished) return;
    this.finished = true;
    if (error) this.message.error = error;
    if (this.message.error && status === "done" && !this.message.parts.some((p) => p.kind === "text" && p.text.trim())) {
      status = "error";
    }
    this.message.status = status;
    for (const p of this.message.parts) {
      if (p.kind === "tool" && (p.status === "running" || p.status === "awaiting-approval")) {
        p.status = status === "stopped" ? "denied" : "error";
      }
    }
    const route = this.modelRoute;
    if (route) {
      const usage = this.usage;
      const pricing = await estimatedCost(route, usage).catch(() => ({ cost:null, pricingVersion:null }));
      await recordModelUsage({ agentId:this.bot.id, conversationId:this.message.conversationId, executionRunId:null, taskId:null, providerId:route.providerId, model:route.model, ...usage, usageKind:route.providerId === "mock" ? "simulated" : usage.totalTokens !== null || usage.inputTokens !== null || usage.outputTokens !== null ? "reported" : "unknown", durationMs:Date.now() - new Date(this.message.createdAt).getTime(), success:status === "done", fallbackAttempt:route.fallbackAttempt, estimatedCostUsd:pricing.cost, currency:"USD", pricingVersion:pricing.pricingVersion, routingReason:route.reason, error:status === "error" ? "Model execution failed; see conversation." : null }).catch((err: unknown) => console.error("Model usage persistence failed", err instanceof Error ? err.name : "error"));
      if (usage.inputTokens !== null && usage.outputTokens !== null) this.message.usage = { input:usage.inputTokens, output:usage.outputTokens, costUsd:pricing.cost };
    }
    await saveMessage(this.message);
    publish({ type: "message", message: this.message });
    this.resolveDone(this.message);
  }
}

// ── public API ──────────────────────────────────────────────────────────

export interface TurnRequest {
  bot: Bot;
  conversationId: ConversationId;
  /** What the bot receives: the person's words, or a room's catch-up text. */
  content: string;
  route?: RouteNote;
}

/** Queue one turn for one bot in one conversation and resolve with its reply,
 * or null when Stop cancelled it before it started. */
export function runTurn(request: TurnRequest): Promise<ChatMessage | null> {
  const k = key(request.conversationId, request.bot.id);
  const epoch = state.stopEpoch.get(request.conversationId) ?? 0;
  const previous = state.chains.get(k) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => ((state.stopEpoch.get(request.conversationId) ?? 0) === epoch ? executeTurn(request) : null));
  state.chains.set(k, next);
  void next.finally(() => {
    if (state.chains.get(k) === next) state.chains.delete(k);
  });
  return next;
}

async function executeTurn({ bot, conversationId, content, route }: TurnRequest): Promise<ChatMessage> {
  const latest = (await getBot(bot.id)) ?? bot;
  const k = key(conversationId, latest.id);
  const folder = new TurnFolder(conversationId, latest, route);
  setRunning(conversationId, latest.id, true);
  state.folders.set(k, folder);
  await saveMessage(folder.message);
  publish({ type: "message", message: folder.message });

  let unsubscribe: (() => void) | undefined;
  try {
    const modelRoute: ModelRoute = isMock() ? { providerId:"mock", model:"mock", category:"general", reason:"Deterministic mock mode.", fallbackAttempt:0 } : await resolveModelRoute(latest, content);
    const session = await sessionFor(latest, conversationId, modelRoute);
    if (folder.finished) return await folder.done;
    folder.setModelRoute(modelRoute);
    unsubscribe = session.subscribe((event) => folder.handle(event));
    const shared = latest.tools.memory ? await conversationSharedMemory(latest.id, conversationId) : "";
    await session.sendMessage({ content: shared ? `${shared}\n\n## Current conversation message\n${content}` : content });
    // The run settled. If no terminal event reached us and nothing waits on the
    // person, close the turn here so it never hangs as "streaming".
    if (!folder.finished && !folder.waitingOnPerson()) await folder.finish("done");
    return await folder.done;
  } catch (error) {
    await folder.finish("error", error instanceof Error ? error.message : String(error));
    return folder.message;
  } finally {
    unsubscribe?.();
    if (state.folders.get(k) === folder) state.folders.delete(k);
    setRunning(conversationId, latest.id, false);
  }
}

export async function respondToApproval(conversationId: ConversationId, botId: string, toolCallId: string, approve: boolean) {
  const session = state.sessions.get(key(conversationId, botId));
  if (!session) throw new Error("That request is no longer waiting. The bot may have restarted.");
  await session.respondToToolApproval({ toolCallId, decision: approve ? "approve" : "decline" });
}

export async function answerQuestion(conversationId: ConversationId, botId: string, toolCallId: string, answer: string) {
  const k = key(conversationId, botId);
  const session = state.sessions.get(k);
  if (!session) throw new Error("That question is no longer waiting. The bot may have restarted.");
  state.folders.get(k)?.answer(toolCallId, answer);
  await session.respondToToolSuspension({ toolCallId, resumeData: answer });
}

export async function stopConversation(conversationId: ConversationId) {
  state.stopEpoch.set(conversationId, (state.stopEpoch.get(conversationId) ?? 0) + 1);
  for (const [k, session] of state.sessions) {
    if (!k.startsWith(`${conversationId}|`)) continue;
    const folder = state.folders.get(k);
    try {
      session.abort();
    } catch {
      // nothing running
    }
    // A run parked on an approval or question has no live stream to abort.
    if (folder && !folder.finished) await folder.finish("stopped");
  }
}

/** Forget a bot's controller, e.g. after it's deleted or its settings change. */
export async function resetBot(botId: string) {
  if (!isBotBusy(botId)) await dropRuntime(botId);
}

/** Drop cached sessions so the next turn starts a fresh model-side thread. */
export function forgetConversation(conversationId: ConversationId) {
  for (const k of [...state.sessions.keys()]) if (k.startsWith(`${conversationId}|`)) state.sessions.delete(k);
}
