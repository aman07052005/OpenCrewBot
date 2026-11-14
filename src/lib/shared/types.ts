// Types shared by the server and the browser. Everything here is plain JSON.

export type ApprovalMode = "ask" | "controlled" | "full";

export type ActionStatus = "pending" | "approved" | "rejected" | "executing" | "succeeded" | "failed" | "cancelled" | "expired";
export interface PermissionPolicy { preapprovedOperations: string[]; allowedDestinations: string[]; maxActionsPerDay: number; }
export interface ActionRequest {
  id: string; agentId: string; conversationId: string | null; executionRunId: string | null; executionTaskId: string | null;
  tool: string; operation: string; arguments: unknown; preview: string; permissionLevel: ApprovalMode;
  decision: "allowed" | "approval-required" | "denied"; reason: string; status: ActionStatus; createdAt: string; expiresAt: string | null; decidedAt: string | null; result: unknown; error: string | null; simulated: boolean; invocationCount: number; audit?: Array<{ event: string; reason: string; createdAt: string }>;
}

export interface BotTools {
  /** Tavily search, extract and crawl. */
  webSearch: boolean;
  /** Read and update the bot's MEMORY.md. */
  memory: boolean;
  /** Let the model write one TypeScript function that calls several tools at once. */
  codeMode: boolean;
  /** A real browser (Playwright) the bot can drive. */
  browser: boolean;
  /** The bot may stop and ask you a question with a card in chat. */
  askUser: boolean;
}

export interface Bot {
  id: string;
  name: string;
  /** Lowercase handle used for @mentions in rooms. */
  handle: string;
  title: string;
  description: string;
  instructions: string;
  emoji: string;
  color: string;
  model: string;
  tools: BotTools;
  /** Connection ids this bot may use: `composio:<toolkit>` or `mcp:<serverId>`. */
  connections: string[];
  approval: ApprovalMode;
  permissionPolicy?: PermissionPolicy;
  /** Optional Agent Factory metadata. Older/manual bot records remain valid without it. */
  agentConfig?: AgentFactoryMetadata;
  pinned: boolean;
  createdAt: string;
}

export type AgentFactoryGenerationMode = "mock" | "live" | "template";

/** Extensible metadata for future skill and memory runtimes; skills are descriptive tags today. */
export interface AgentFactoryMetadata {
  source: "factory" | "template";
  generationMode: AgentFactoryGenerationMode;
  templateId?: string;
  creationRequest: string;
  skillIds: string[];
  memory: { enabled: boolean; storage: "markdown" };
  expectedOutputFormat: string;
}

export type BotInput = Omit<Bot, "id" | "createdAt" | "handle" | "connections"> & { handle?: string; connections?: string[] };

/** Editable JSON configuration returned by the Agent Factory preview. */
export interface AgentFactoryDraft extends BotInput {
  handle: string;
  agentConfig: AgentFactoryMetadata;
  generationLabel: string;
}

export type RoomResponder = "auto" | "lead" | "everyone";

export interface Room {
  id: string;
  name: string;
  topic: string;
  emoji: string;
  memberIds: string[];
  leadId: string | null;
  responder: RoomResponder;
  pinned: boolean;
  createdAt: string;
}

export type RoomInput = Omit<Room, "id" | "createdAt">;

/** `dm:<botId>` or `room:<roomId>`. */
export type ConversationId = string;

export interface Source {
  title: string;
  url: string;
}

export type ToolStatus = "running" | "awaiting-approval" | "done" | "error" | "denied";

export type Part =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      name: string;
      label: string;
      detail?: string;
      status: ToolStatus;
      preview?: string;
      sources?: Source[];
    }
  | {
      kind: "question";
      toolCallId: string;
      question: string;
      options: { label: string; description?: string }[];
      answer?: string;
    };

export type MessageStatus = "streaming" | "done" | "error" | "stopped";

export interface RouteNote {
  by: "mention" | "jev" | "lead" | "everyone" | "handoff";
  confidence?: number;
}

export interface ChatMessage {
  id: string;
  conversationId: ConversationId;
  role: "user" | "bot" | "notice";
  botId?: string;
  createdAt: string;
  status: MessageStatus;
  parts: Part[];
  model?: string;
  usage?: { input: number; output: number; costUsd: number | null };
  route?: RouteNote;
  error?: string;
}

export interface ConversationSummary {
  id: ConversationId;
  lastMessage?: { text: string; createdAt: string; author: string };
  running: string[];
  unread: number;
}

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  context: number;
  tools: boolean;
  reasoning: boolean;
  vision: boolean;
  inputPerM: number | null;
  outputPerM: number | null;
  live: boolean;
}

export interface AppStatus {
  mock: boolean;
  keys: { nebius: boolean; tavily: boolean; jev: boolean; browserbase: boolean; composio: boolean };
  dataDir: string;
}

/** Persistent Module D execution data returned by the execution API. */
export type ExecutionMode = "mock" | "live";
export type ExecutionRunStatus = "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";
export type ExecutionTaskStatus = "pending" | "blocked" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";

export interface ExecutionTaskInput {
  key: string;
  title: string;
  agentId: string;
  input?: unknown;
  dependsOn?: string[];
  requiresApproval?: boolean;
  maxAttempts?: number;
  timeoutMs?: number;
  skillId?: string;
  skillInput?: unknown;
}

export interface CreateExecutionRunInput {
  name: string;
  concurrencyLimit?: number;
  executionMode?: ExecutionMode;
  /** Set only for a persisted Chief of Staff run. */
  originalInstruction?: string;
  planningRationale?: string;
  planningMode?: ExecutionMode;
  tasks: ExecutionTaskInput[];
}

export interface ExecutionTask {
  id: string;
  runId: string;
  title: string;
  agentId: string;
  status: ExecutionTaskStatus;
  requiresApproval: boolean;
  approvedAt: string | null;
  dependencies: string[];
  input: unknown;
  output: unknown;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ExecutionDependencyOutput {
  taskId: string;
  title: string;
  agentId: string;
  output: unknown;
}

export type ExecutionTaskCounts = Record<ExecutionTaskStatus, number>;

export interface ExecutionRun {
  id: string;
  name: string;
  status: ExecutionRunStatus;
  concurrencyLimit: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  executionMode: ExecutionMode;
  originalInstruction?: string | null;
  planningRationale?: string | null;
  planningMode?: ExecutionMode | null;
  tasks?: ExecutionTask[];
  /** Included on run-list responses for a compact progress summary. */
  taskCount?: number;
  taskCounts?: ExecutionTaskCounts;
}

export interface ChiefOfStaffTask {
  key: string;
  title: string;
  instructions: string;
  agentId: string;
  dependsOn: string[];
  rationale: string;
  isFinalConsolidation: boolean;
  skillId?: string;
}

export interface ChiefOfStaffPlan {
  rationale: string;
  tasks: ChiefOfStaffTask[];
  planningMode: ExecutionMode;
  planningLabel: string;
}

export interface CreateChiefOfStaffRunInput {
  name: string;
  concurrencyLimit: number;
  executionMode: ExecutionMode;
  originalInstruction: string;
  planningMode: ExecutionMode;
  plan: ChiefOfStaffPlan;
}

/** Events the server pushes to the browser over one SSE stream. */
export type ServerEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "delta"; conversationId: ConversationId; messageId: string; partIndex: number; kind: "text" | "reasoning"; delta: string }
  | { type: "running"; conversationId: ConversationId; botIds: string[] }
  | { type: "bots-changed" }
  | { type: "rooms-changed" }
  | { type: "memory-changed"; botId: string }
  /** A bot's Browserbase live view opened (url) or closed (null). */
  | { type: "browser-session"; botId: string; liveUrl: string | null }
  | { type: "connections-changed" };

/** An app from Composio's catalog, with this install's connection state. */
export interface ComposioApp {
  slug: string;
  name: string;
  logo?: string;
  connected: boolean;
}

/** A remote MCP server you added. The token never leaves the server. */
export interface McpServer {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
  headerNames: string[];
}

export interface ConnectionsState {
  composio: { enabled: boolean; apps: ComposioApp[]; error?: string };
  mcpServers: McpServer[];
}

/** Something a bot can be given access to. */
export interface ConnectionOption {
  id: string;
  name: string;
  kind: "composio" | "mcp";
  logo?: string;
}
