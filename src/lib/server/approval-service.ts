import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Client } from "@libsql/client";
import { GMAIL_ACCOUNT_ID, GMAIL_SUBJECT } from "./gmail-integration.ts";
import type { GmailReadArgs } from "./gmail-integration.ts";
import { GitHubRequestSchema, type GitHubRequest } from "./github-integration.ts";
import type { ActionRequest, ApprovalMode, Bot, PermissionPolicy } from "@/lib/shared/types";

const SimulatedEmailSchema = z.object({ destination: z.string().email().max(320), subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20_000) }).strict();
const GmailReadSchema = z.object({ accountId: z.string().regex(GMAIL_ACCOUNT_ID), subject: z.string().regex(GMAIL_SUBJECT) }).strict();
export const McpReadArgsSchema = z.object({ serverId: z.string().regex(/^[A-Za-z0-9-]{1,160}$/), tool: z.string().regex(/^[A-Za-z0-9_.-]{1,160}$/), input: z.unknown() }).strict().refine((value) => JSON.stringify(value.input ?? null).length <= 10_000, "MCP input exceeds 10 KB.");
export type McpReadArgs = z.infer<typeof McpReadArgsSchema>;
export const ACTION_OPERATIONS = {
  "simulated.email.send": { tool: "simulated-email", classification: "external-write", schema: SimulatedEmailSchema, simulated: true },
  "gmail.demo.read": { tool: "gmail", classification: "external-read", schema: GmailReadSchema, simulated: false },
  "github.public.read": { tool: "github", classification: "external-read", schema: GitHubRequestSchema, simulated: false },
  "mcp.read.invoke": { tool: "mcp", classification: "external-read", schema: McpReadArgsSchema, simulated: false },
} as const;
export type ActionOperation = keyof typeof ACTION_OPERATIONS;
export const defaultPermissionPolicy = (): PermissionPolicy => ({ preapprovedOperations: [], allowedDestinations: [], maxActionsPerDay: 20 });
type Decision = { decision: "allowed" | "approval-required" | "denied"; reason: string };

function scrub(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/(authorization|api[_-]?key|token|password)\s*[:=]\s*[^\s,]+/gi, "$1=[REDACTED]");
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, /authorization|token|secret|password/i.test(key) ? "[REDACTED]" : scrub(item)]));
  return value;
}
function destination(args: Record<string, unknown>): string | undefined { return typeof args.destination === "string" ? args.destination.toLowerCase().split("@").at(-1) : undefined; }
export function authorizeAction(bot: Bot, operation: string, args: unknown): Decision {
  const known = Object.hasOwn(ACTION_OPERATIONS, operation) ? ACTION_OPERATIONS[operation as ActionOperation] : undefined;
  if (!known) return { decision: "denied", reason: "Unknown or unsupported action operation." };
  if (!bot.tools.askUser) return { decision: "denied", reason: "The agent's approval interaction tool is disabled." };
  const parsed = known.schema.safeParse(args);
  if (!parsed.success) return { decision: "denied", reason: "Action arguments failed server-side validation." };
  if (operation === "gmail.demo.read") {
    if (!bot.connections.includes("composio:gmail")) return { decision: "denied", reason: "Gmail is not assigned to this agent." };
    return { decision: "approval-required", reason: "Reading the designated test message always requires explicit owner approval." };
  }
  if (operation === "github.public.read" && !bot.tools.webSearch && !bot.connections.includes("composio:github")) return { decision: "denied", reason: "GitHub read access is not assigned to this agent." };
  if (operation === "mcp.read.invoke" && !bot.connections.includes(`mcp:${(parsed.data as McpReadArgs).serverId}`)) return { decision: "denied", reason: "The requested MCP server is not assigned to this agent." };
  const policy = bot.permissionPolicy ?? defaultPermissionPolicy();
  if (bot.approval === "ask") return { decision: "approval-required", reason: "Ask First requires approval for this registered external operation." };
  if (bot.approval === "full") return { decision: "allowed", reason: "Full Access allows this registered operation within its server-enforced scope." };
  const allowedOperation = policy.preapprovedOperations.includes(operation);
  const host = destination(parsed.data as Record<string, unknown>);
  const allowedDestination = !policy.allowedDestinations.length || (host !== undefined && policy.allowedDestinations.includes(host));
  return allowedOperation && allowedDestination ? { decision: "allowed", reason: "Controlled Access preapproval matches this operation and destination." } : { decision: "approval-required", reason: "Controlled Access requires approval outside its configured scope." };
}
function row(value: Record<string, unknown>): ActionRequest {
  return { id: String(value.id), agentId: String(value.agent_id), conversationId: value.conversation_id == null ? null : String(value.conversation_id), executionRunId: value.execution_run_id == null ? null : String(value.execution_run_id), executionTaskId: value.execution_task_id == null ? null : String(value.execution_task_id), tool: String(value.tool), operation: String(value.operation), arguments: JSON.parse(String(value.arguments_json)), preview: String(value.preview), permissionLevel: String(value.permission_level) as ApprovalMode, decision: String(value.decision) as ActionRequest["decision"], reason: String(value.reason), status: String(value.status) as ActionRequest["status"], createdAt: String(value.created_at), expiresAt: value.expires_at == null ? null : String(value.expires_at), decidedAt: value.decided_at == null ? null : String(value.decided_at), result: value.result_json == null ? null : JSON.parse(String(value.result_json)), error: value.error == null ? null : String(value.error), simulated: Number(value.simulated) === 1, invocationCount: Number(value.invocation_count ?? 0) };
}
async function audit(client: Client, actionId: string, event: string, reason: string) { await client.execute({ sql: "INSERT INTO action_audit_log (id,action_id,event,reason,created_at) VALUES (?,?,?,?,?)", args: [randomUUID(), actionId, event, reason, new Date().toISOString()] }); }
function preview(operation: ActionOperation, args: z.infer<typeof SimulatedEmailSchema> | GmailReadArgs | GitHubRequest | McpReadArgs) {
  if (operation === "gmail.demo.read" && "accountId" in args) return `LIVE GMAIL READ — connection: ${args.accountId}; exact subject: ${args.subject}. Retrieve one synthetic inbox message only. No email is sent or modified.`;
  if ("destination" in args) return `SIMULATED EMAIL — destination: ${args.destination}; subject: ${args.subject}; body: ${args.body.slice(0, 500)}. No email has been sent.`;
  if (operation === "github.public.read" && "repository" in args) return `LIVE GITHUB PUBLIC READ — ${args.operation} from ${args.repository}${"path" in args ? `; path: ${args.path}` : "number" in args ? `; number: ${args.number}` : ""}. Public REST only; no repository write or private credential.`;
  if (operation === "mcp.read.invoke" && "serverId" in args) return `LIVE MCP READ — server: ${args.serverId}; owner-enabled tool: ${args.tool}; input: ${JSON.stringify(scrub(args.input)).slice(0, 500)}. Live read-only annotation and bot connection are rechecked before invocation.`;
  throw new Error("Invalid action preview.");
}
export async function proposeAction(client: Client, bot: Bot, input: { operation: string; arguments: unknown; conversationId?: string; executionRunId?: string; executionTaskId?: string }): Promise<ActionRequest> {
  const known = Object.hasOwn(ACTION_OPERATIONS, input.operation) ? ACTION_OPERATIONS[input.operation as ActionOperation] : undefined;
  let decision = authorizeAction(bot, input.operation, input.arguments);
  if (bot.approval === "controlled" && decision.decision === "allowed") {
    const policy = bot.permissionPolicy ?? defaultPermissionPolicy();
    const day = new Date(); day.setUTCHours(0, 0, 0, 0);
    const usage = await client.execute({ sql: "SELECT COUNT(*) AS n FROM action_requests WHERE agent_id=? AND created_at>=? AND decision='allowed'", args: [bot.id, day.toISOString()] });
    if (Number(usage.rows[0]?.n ?? 0) >= policy.maxActionsPerDay) decision = { decision: "approval-required", reason: "Controlled Access daily preapproval limit is exhausted." };
  }
  const args = scrub(input.arguments);
  const now = new Date(); const id = randomUUID();
  const parsed = known?.schema.safeParse(args);
  const status = decision.decision === "denied" ? "rejected" : decision.decision === "allowed" ? "approved" : "pending";
  const expiresAt = decision.decision === "approval-required" ? new Date(now.getTime() + 15 * 60_000).toISOString() : null;
  await client.execute({ sql: `INSERT INTO action_requests (id,agent_id,conversation_id,execution_run_id,execution_task_id,tool,operation,arguments_json,preview,permission_level,decision,reason,status,created_at,expires_at,decided_at,simulated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [id, bot.id, input.conversationId ?? null, input.executionRunId ?? null, input.executionTaskId ?? null, known?.tool ?? "unknown", input.operation, JSON.stringify(args), parsed?.success && known ? preview(input.operation as ActionOperation, parsed.data) : "Action rejected before preview.", bot.approval, decision.decision, decision.reason, status, now.toISOString(), expiresAt, status === "approved" || status === "rejected" ? now.toISOString() : null, known?.simulated ? 1 : 0] });
  await audit(client, id, "proposed", decision.reason);
  return getAction(client, id) as Promise<ActionRequest>;
}
export async function getAction(client: Client, id: string): Promise<ActionRequest | null> { const result = await client.execute({ sql: "SELECT * FROM action_requests WHERE id=?", args: [id] }); return result.rows[0] ? row(result.rows[0] as Record<string, unknown>) : null; }
export async function getExecutionTaskAction(client: Client, taskId: string): Promise<ActionRequest | null> { const result = await client.execute({ sql: "SELECT * FROM action_requests WHERE execution_task_id=?", args: [taskId] }); return result.rows[0] ? row(result.rows[0] as Record<string, unknown>) : null; }
export async function listActions(client: Client, status?: string, expire = true): Promise<ActionRequest[]> { if (expire) await expireActions(client); const result = await client.execute(status ? { sql: "SELECT * FROM action_requests WHERE status=? ORDER BY created_at DESC LIMIT 200", args: [status] } : "SELECT * FROM action_requests ORDER BY created_at DESC LIMIT 200"); return Promise.all(result.rows.map(async (item) => { const action = row(item as Record<string, unknown>); return { ...action, audit: await actionAudit(client, action.id) }; })); }
export async function expireActions(client: Client): Promise<ActionRequest[]> {
  const now = new Date().toISOString();
  const expired = await client.execute({ sql: "UPDATE action_requests SET status='expired',decided_at=?,error=? WHERE status='pending' AND expires_at IS NOT NULL AND expires_at<? RETURNING id", args: [now, "Approval expired before a decision; the external provider was not invoked.", now] });
  const actions = new Map<string, ActionRequest>();
  for (const item of expired.rows) {
    await audit(client, String(item.id), "expired", "Approval expired before a decision; provider invocation was prevented.");
    const action = await getAction(client, String(item.id));
    if (action) actions.set(action.id, action);
  }
  // Crash recovery: an action may have expired just before a process stopped,
  // leaving its linked execution task blocked. Return it until synchronization
  // performs the idempotent blocked -> failed transition.
  const stranded = await client.execute("SELECT a.* FROM action_requests a JOIN execution_tasks t ON t.id=a.execution_task_id WHERE a.status='expired' AND t.status='blocked' LIMIT 200");
  for (const item of stranded.rows) { const action = row(item as Record<string, unknown>); actions.set(action.id, action); }
  return [...actions.values()];
}
export async function decideAction(client: Client, id: string, decision: "approve" | "reject" | "cancel"): Promise<ActionRequest | null> { await expireActions(client); const next = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "cancelled"; const reason = decision === "approve" ? "Approved by owner." : decision === "reject" ? "Rejected by owner." : "Cancelled by owner."; const updated = await client.execute({ sql: "UPDATE action_requests SET status=?,decided_at=? WHERE id=? AND status='pending'", args: [next, new Date().toISOString(), id] }); if (!updated.rowsAffected) return null; await audit(client, id, next, reason); return getAction(client, id); }
const g = globalThis as unknown as { __simulatedActionInvocations?: number };
export function simulatedInvocationCount() { return g.__simulatedActionInvocations ?? 0; }
export interface ActionHandlers { gmailRead?: (args: GmailReadArgs) => Promise<unknown>; githubRead?: (args: GitHubRequest) => Promise<unknown>; mcpRead?: (args: McpReadArgs) => Promise<unknown>; }
export async function executeApprovedAction(client: Client, id: string, bot: Bot, handlers?: ActionHandlers): Promise<ActionRequest | null> {
  await expireActions(client); const action = await getAction(client, id); if (!action) return null;
  if (action.status !== "approved") return action;
  const current = authorizeAction(bot, action.operation, action.arguments);
  const gmail = action.operation === "gmail.demo.read";
  const parsedGmail = gmail ? GmailReadSchema.safeParse(action.arguments) : null;
  const github = action.operation === "github.public.read";
  const parsedGithub = github ? GitHubRequestSchema.safeParse(action.arguments) : null;
  const mcp = action.operation === "mcp.read.invoke";
  const parsedMcp = mcp ? McpReadArgsSchema.safeParse(action.arguments) : null;
  const invalidGmail = gmail && (!parsedGmail?.success || action.decision !== "approval-required" || !action.decidedAt || !action.expiresAt || action.expiresAt <= new Date().toISOString() || action.preview !== preview("gmail.demo.read", parsedGmail.data));
  const parsedExternal = parsedGithub?.success ? parsedGithub.data : parsedMcp?.success ? parsedMcp.data : null;
  const invalidExternal = (github || mcp) && (!parsedExternal || action.preview !== preview(action.operation as ActionOperation, parsedExternal));
  const revoked = bot.id !== action.agentId || invalidGmail || invalidExternal || current.decision === "denied" || (action.decision === "allowed" && current.decision !== "allowed");
  if (revoked) { await client.execute({ sql: "UPDATE action_requests SET status='failed',error=?,decided_at=? WHERE id=? AND status='approved'", args: ["Permission was revoked or scope no longer matches before execution.", new Date().toISOString(), id] }); await audit(client, id, "failed", "Permission was revoked or scope no longer matches before execution."); return getAction(client, id); }
  const claimed = await client.execute({ sql: "UPDATE action_requests SET status='executing' WHERE id=? AND status='approved'", args: [id] }); if (!claimed.rowsAffected) return getAction(client, id);
  await audit(client, id, "executing", gmail ? "Claimed once for approved Gmail read." : github ? "Claimed once for bounded public GitHub read." : mcp ? "Claimed once for owner-enabled read-only MCP invocation." : "Claimed exactly once for simulated execution.");
  if (gmail) {
    try {
      if (!handlers?.gmailRead || !parsedGmail?.success) throw new Error("Gmail adapter is not configured.");
      await client.execute({ sql: "UPDATE action_requests SET invocation_count=invocation_count+1 WHERE id=? AND status='executing'", args: [id] });
      const result = await handlers.gmailRead(parsedGmail.data);
      await client.execute({ sql: "UPDATE action_requests SET status='succeeded',result_json=? WHERE id=? AND status='executing'", args: [JSON.stringify(result), id] });
      await audit(client, id, "succeeded", "Approved synthetic Gmail message retrieved; no mail sent or modified.");
    } catch {
      const message = "Gmail read failed or authorization changed. Check the test mailbox, scope and exact synthetic message. No automatic retry.";
      await client.execute({ sql: "UPDATE action_requests SET status='failed',error=? WHERE id=? AND status='executing'", args: [message, id] });
      await audit(client, id, "failed", message);
    }
    return getAction(client, id);
  }
  if (github || mcp) {
    try {
      const invoke = github && parsedGithub?.success && handlers?.githubRead ? () => handlers.githubRead!(parsedGithub.data) : mcp && parsedMcp?.success && handlers?.mcpRead ? () => handlers.mcpRead!(parsedMcp.data) : null;
      if (!invoke) throw new Error("Integration adapter is not configured.");
      await client.execute({ sql: "UPDATE action_requests SET invocation_count=invocation_count+1 WHERE id=? AND status='executing'", args: [id] });
      const result = await invoke();
      await client.execute({ sql: "UPDATE action_requests SET status='succeeded',result_json=? WHERE id=? AND status='executing'", args: [JSON.stringify(result), id] });
      await audit(client, id, "succeeded", github ? "Bounded public GitHub read completed." : "Owner-enabled read-only MCP invocation completed.");
    } catch {
      const message = github ? "GitHub read failed. No mock result was substituted and no automatic retry will occur." : "MCP read failed or its connection/read-only scope changed. No mock result was substituted and no automatic retry will occur.";
      await client.execute({ sql: "UPDATE action_requests SET status='failed',error=? WHERE id=? AND status='executing'", args: [message, id] });
      await audit(client, id, "failed", message);
    }
    return getAction(client, id);
  }
  g.__simulatedActionInvocations = (g.__simulatedActionInvocations ?? 0) + 1;
  const result = { simulated: true, message: "Simulated external action succeeded. No email was sent.", adapterInvocationSequence: g.__simulatedActionInvocations };
  await client.execute({ sql: "UPDATE action_requests SET status='succeeded',result_json=?,invocation_count=invocation_count+1 WHERE id=? AND status='executing'", args: [JSON.stringify(result), id] }); await audit(client, id, "succeeded", "Simulated adapter completed; no external service was contacted."); return getAction(client, id);
}
export async function actionAudit(client: Client, id: string) { const result = await client.execute({ sql: "SELECT event,reason,created_at FROM action_audit_log WHERE action_id=? ORDER BY created_at", args: [id] }); return result.rows.map((item) => ({ event: String(item.event), reason: String(item.reason), createdAt: String(item.created_at) })); }
