import type { MemoryCatalog, MemoryDocument, MemoryTarget } from "@/lib/shared/scoped-memory";
import type { CollaborationDraft, CollaborationSession, RoomInstallResult } from "@/lib/shared/collaboration";
import type {
  AppStatus,
  Bot,
  BotInput,
  ChatMessage,
  ComposioApp,
  ConnectionsState,
  ConversationId,
  ConversationSummary,
  CreateExecutionRunInput,
  CreateChiefOfStaffRunInput,
  ChiefOfStaffPlan,
  AgentFactoryDraft,
  AgentFactoryGenerationMode,
  ExecutionRun,
  ExecutionTask,
  McpServer,
  ModelOption,
  Room,
  RoomInput,
} from "@/lib/shared/types";

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const conv = (id: ConversationId) => `/api/conversations/${encodeURIComponent(id)}`;

export interface Bootstrap {
  status: AppStatus;
  bots: Bot[];
  rooms: Room[];
  conversations: ConversationSummary[];
  models: ModelOption[];
  /** botId → Browserbase live view URL for bots with an open browser. */
  liveViews: Record<string, string>;
}

export const api = {
  memoryCatalog: () => call<{ catalog: MemoryCatalog }>("/api/memory/catalog"),
  changeMemoryCatalog: (input: { action: "create"; name: string } | { action: "link"; roomId: string; projectId: string | null }) => call<{ catalog: MemoryCatalog }>("/api/memory/catalog", { method: "POST", json: input }),
  scopedMemory: (target: MemoryTarget) => call<{ document: MemoryDocument }>(`/api/memory?scope=${encodeURIComponent(target.scope)}&id=${encodeURIComponent(target.id)}`),
  saveScopedMemory: (target: MemoryTarget, content: string, revision: string, reason: string) => call<{ document: MemoryDocument }>("/api/memory", { method: "PUT", json: { ...target, content, revision, reason } }),
  bootstrap: () => call<Bootstrap>("/api/bootstrap"),
  models: (refresh = false) => call<{ models: ModelOption[] }>(`/api/models${refresh ? "?refresh=1" : ""}`),
  createBot: (input: BotInput) => call<{ bot: Bot }>("/api/bots", { method: "POST", json: input }),
  updateBot: (id: string, patch: Partial<BotInput>) => call<{ bot: Bot }>(`/api/bots/${id}`, { method: "PATCH", json: patch }),
  deleteBot: (id: string) => call(`/api/bots/${id}`, { method: "DELETE" }),
  generateFactoryAgent: (input: { description: string; generationMode: Exclude<AgentFactoryGenerationMode, "template"> }) =>
    call<{ draft: AgentFactoryDraft }>("/api/agent-factory/generate", { method: "POST", json: input }),
  createFactoryAgent: (draft: AgentFactoryDraft) =>
    call<{ bot: Bot }>("/api/agent-factory/create", { method: "POST", json: { draft } }),
  installWorkforceTemplates: () =>
    call<{ installed: string[]; alreadyInstalled: string[]; conflicts: Array<{ templateId: string; agentName: string }> }>("/api/agent-factory/templates/install", { method: "POST" }),
  getMemory: (id: string) => call<{ content: string; revision: string; path: string; limit: { lines: number; bytes: number } }>(`/api/bots/${id}/memory`),
  saveMemory: (id: string, content: string) => call<{ content: string }>(`/api/bots/${id}/memory`, { method: "PUT", json: { content } }),
  createRoom: (input: RoomInput) => call<{ room: Room }>("/api/rooms", { method: "POST", json: input }),
  updateRoom: (id: string, patch: Partial<RoomInput>) => call<{ room: Room }>(`/api/rooms/${id}`, { method: "PATCH", json: patch }),
  collaborationRooms: () => call<RoomInstallResult>("/api/rooms/templates/install", { method: "POST" }),
  collaborationHistory: (roomId: string) => call<{ sessions: CollaborationSession[] }>(`/api/rooms/${encodeURIComponent(roomId)}/collaborations`),
  collaborationPlan: (roomId: string, input: Omit<CollaborationDraft, "plan">) => call<{ draft: CollaborationDraft }>(`/api/rooms/${encodeURIComponent(roomId)}/collaborations/plan`, { method: "POST", json: input }),
  createCollaboration: (roomId: string, draft: CollaborationDraft) => call<{ session: CollaborationSession }>(`/api/rooms/${encodeURIComponent(roomId)}/collaborations`, { method: "POST", json: draft }),
  collaborationSession: (roomId: string, id: string) => call<{ session: CollaborationSession }>(`/api/rooms/${encodeURIComponent(roomId)}/collaborations/${encodeURIComponent(id)}`),
  collaborationAction: (roomId: string, id: string, input: { action: "start" | "advance" | "interrupt" | "resume" | "cancel" } | { action: "continue"; draft: CollaborationDraft }) => call<{ session: CollaborationSession }>(`/api/rooms/${encodeURIComponent(roomId)}/collaborations/${encodeURIComponent(id)}`, { method: "POST", json: input }),
  deleteRoom: (id: string) => call(`/api/rooms/${id}`, { method: "DELETE" }),
  messages: (id: ConversationId) => call<{ messages: ChatMessage[]; running: string[] }>(`${conv(id)}/messages`),
  send: (id: ConversationId, text: string) => call<{ message: ChatMessage }>(`${conv(id)}/messages`, { method: "POST", json: { text } }),
  approve: (id: ConversationId, botId: string, toolCallId: string, approve: boolean) =>
    call(`${conv(id)}/approval`, { method: "POST", json: { botId, toolCallId, approve } }),
  answer: (id: ConversationId, botId: string, toolCallId: string, answer: string) =>
    call(`${conv(id)}/answer`, { method: "POST", json: { botId, toolCallId, answer } }),
  stop: (id: ConversationId) => call(`${conv(id)}/stop`, { method: "POST" }),
  clear: (id: ConversationId) => call(`${conv(id)}/clear`, { method: "POST" }),
  read: (id: ConversationId) => call(`${conv(id)}/read`, { method: "POST" }),
  connections: () => call<ConnectionsState>("/api/connections"),
  searchApps: (q: string) => call<{ apps: ComposioApp[] }>(`/api/connections/composio/search?q=${encodeURIComponent(q)}`),
  connectApp: (slug: string) => call<{ redirectUrl: string }>("/api/connections/composio/connect", { method: "POST", json: { slug } }),
  disconnectApp: (slug: string) => call("/api/connections/composio/disconnect", { method: "POST", json: { slug } }),
  connectionsChanged: () => call("/api/connections/changed", { method: "POST" }),
  addMcpServer: (input: { name: string; url: string; token?: string; headers?: Record<string, string> }) =>
    call<{ server: McpServer }>("/api/connections/mcp", { method: "POST", json: input }),
  removeMcpServer: (id: string) => call(`/api/connections/mcp/${id}`, { method: "DELETE" }),
  testMcpServer: (id: string) => call<{ tools: number }>(`/api/connections/mcp/${id}/test`, { method: "POST" }),
  executionRuns: (limit = 100, offset = 0, before?: { createdAt: string; id: string }) =>
    call<{ runs: ExecutionRun[] }>(`/api/execution-runs?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}${before ? `&beforeCreatedAt=${encodeURIComponent(before.createdAt)}&beforeId=${encodeURIComponent(before.id)}` : ""}`),
  executionRun: (id: string) => call<{ run: ExecutionRun }>(`/api/execution-runs/${encodeURIComponent(id)}`),
  createExecutionRun: (input: CreateExecutionRunInput) => call<{ run: ExecutionRun }>("/api/execution-runs", { method: "POST", json: input }),
  planChiefOfStaff: (input: { instruction: string; planningMode: "mock" | "live" }) =>
    call<{ plan: ChiefOfStaffPlan }>("/api/chief-of-staff/plan", { method: "POST", json: input }),
  createChiefOfStaffRun: (input: CreateChiefOfStaffRunInput) =>
    call<{ run: ExecutionRun }>("/api/chief-of-staff/runs", { method: "POST", json: input }),
  startExecutionRun: (id: string) => call<{ run: ExecutionRun }>(`/api/execution-runs/${encodeURIComponent(id)}/start`, { method: "POST" }),
  cancelExecutionRun: (id: string) => call<{ run: ExecutionRun }>(`/api/execution-runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  approveExecutionTask: (runId: string, taskId: string) =>
    call<{ task: ExecutionTask }>(`/api/execution-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/approve`, { method: "POST" }),
  rejectExecutionTask: (runId: string, taskId: string) =>
    call<{ task: ExecutionTask }>(`/api/execution-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/reject`, { method: "POST" }),
  skills: () => call<{ skills: Array<{ id: string; label: string; description: string; implemented: boolean }> }>("/api/skills"),
};
