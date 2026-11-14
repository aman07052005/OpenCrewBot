import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Client } from "@libsql/client";
import type { ActionRequest, ApprovalMode, Bot, PermissionPolicy } from "@/lib/shared/types";

const SimulatedEmailSchema = z.object({ destination: z.string().email().max(320), subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20_000) }).strict();
export const ACTION_OPERATIONS = { "simulated.email.send": { tool: "simulated-email", classification: "external-write", schema: SimulatedEmailSchema, simulated: true } } as const;
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
  const known = ACTION_OPERATIONS[operation as ActionOperation];
  if (!known) return { decision: "denied", reason: "Unknown or unsupported action operation." };
  if (!bot.tools.askUser) return { decision: "denied", reason: "The agent's approval interaction tool is disabled." };
  const parsed = known.schema.safeParse(args);
  if (!parsed.success) return { decision: "denied", reason: "Action arguments failed server-side validation." };
  const policy = bot.permissionPolicy ?? defaultPermissionPolicy();
  if (bot.approval === "ask") return { decision: "approval-required", reason: "Ask First requires approval for external writes." };
  if (bot.approval === "full") return { decision: "allowed", reason: "Full Access allows this supported, scoped simulated operation." };
  const allowedOperation = policy.preapprovedOperations.includes(operation);
  const host = destination(parsed.data);
  const allowedDestination = !policy.allowedDestinations.length || (host !== undefined && policy.allowedDestinations.includes(host));
  return allowedOperation && allowedDestination ? { decision: "allowed", reason: "Controlled Access preapproval matches this operation and destination." } : { decision: "approval-required", reason: "Controlled Access requires approval outside its configured scope." };
}
function row(value: Record<string, unknown>): ActionRequest {
  return { id: String(value.id), agentId: String(value.agent_id), conversationId: value.conversation_id == null ? null : String(value.conversation_id), executionRunId: value.execution_run_id == null ? null : String(value.execution_run_id), executionTaskId: value.execution_task_id == null ? null : String(value.execution_task_id), tool: String(value.tool), operation: String(value.operation), arguments: JSON.parse(String(value.arguments_json)), preview: String(value.preview), permissionLevel: String(value.permission_level) as ApprovalMode, decision: String(value.decision) as ActionRequest["decision"], reason: String(value.reason), status: String(value.status) as ActionRequest["status"], createdAt: String(value.created_at), expiresAt: value.expires_at == null ? null : String(value.expires_at), decidedAt: value.decided_at == null ? null : String(value.decided_at), result: value.result_json == null ? null : JSON.parse(String(value.result_json)), error: value.error == null ? null : String(value.error), simulated: Number(value.simulated) === 1, invocationCount: Number(value.invocation_count ?? 0) };
}
async function audit(client: Client, actionId: string, event: string, reason: string) { await client.execute({ sql: "INSERT INTO action_audit_log (id,action_id,event,reason,created_at) VALUES (?,?,?,?,?)", args: [randomUUID(), actionId, event, reason, new Date().toISOString()] }); }
function preview(operation: ActionOperation, args: z.infer<typeof SimulatedEmailSchema>) { return `SIMULATED EMAIL — destination: ${args.destination}; subject: ${args.subject}; body: ${args.body.slice(0, 500)}. No email has been sent.`; }
export async function proposeAction(client: Client, bot: Bot, input: { operation: string; arguments: unknown; conversationId?: string; executionRunId?: string; executionTaskId?: string }): Promise<ActionRequest> {
  const known = ACTION_OPERATIONS[input.operation as ActionOperation];
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
export async function listActions(client: Client, status?: string): Promise<ActionRequest[]> { await expireActions(client); const result = await client.execute(status ? { sql: "SELECT * FROM action_requests WHERE status=? ORDER BY created_at DESC LIMIT 200", args: [status] } : "SELECT * FROM action_requests ORDER BY created_at DESC LIMIT 200"); return Promise.all(result.rows.map(async (item) => { const action = row(item as Record<string, unknown>); return { ...action, audit: await actionAudit(client, action.id) }; })); }
async function expireActions(client: Client) { const now = new Date().toISOString(); const expired = await client.execute({ sql: "UPDATE action_requests SET status='expired',decided_at=? WHERE status='pending' AND expires_at IS NOT NULL AND expires_at<? RETURNING id", args: [now, now] }); for (const item of expired.rows) await audit(client, String(item.id), "expired", "Approval expired before a decision."); }
export async function decideAction(client: Client, id: string, decision: "approve" | "reject" | "cancel"): Promise<ActionRequest | null> { await expireActions(client); const next = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "cancelled"; const reason = decision === "approve" ? "Approved by owner." : decision === "reject" ? "Rejected by owner." : "Cancelled by owner."; const updated = await client.execute({ sql: "UPDATE action_requests SET status=?,decided_at=? WHERE id=? AND status='pending'", args: [next, new Date().toISOString(), id] }); if (!updated.rowsAffected) return null; await audit(client, id, next, reason); return getAction(client, id); }
const g = globalThis as unknown as { __simulatedActionInvocations?: number };
export function simulatedInvocationCount() { return g.__simulatedActionInvocations ?? 0; }
export async function executeApprovedAction(client: Client, id: string, bot: Bot): Promise<ActionRequest | null> {
  await expireActions(client); const action = await getAction(client, id); if (!action) return null;
  if (action.status !== "approved") return action;
  const current = authorizeAction(bot, action.operation, action.arguments);
  const revoked = current.decision === "denied" || (action.decision === "allowed" && current.decision !== "allowed");
  if (revoked) { await client.execute({ sql: "UPDATE action_requests SET status='failed',error=?,decided_at=? WHERE id=? AND status='approved'", args: ["Permission was revoked or scope no longer matches before execution.", new Date().toISOString(), id] }); await audit(client, id, "failed", "Permission was revoked or scope no longer matches before execution."); return getAction(client, id); }
  const claimed = await client.execute({ sql: "UPDATE action_requests SET status='executing' WHERE id=? AND status='approved'", args: [id] }); if (!claimed.rowsAffected) return getAction(client, id);
  await audit(client, id, "executing", "Claimed exactly once for simulated execution.");
  g.__simulatedActionInvocations = (g.__simulatedActionInvocations ?? 0) + 1;
  const result = { simulated: true, message: "Simulated external action succeeded. No email was sent.", invocation: g.__simulatedActionInvocations };
  await client.execute({ sql: "UPDATE action_requests SET status='succeeded',result_json=?,invocation_count=invocation_count+1 WHERE id=? AND status='executing'", args: [JSON.stringify(result), id] }); await audit(client, id, "succeeded", "Simulated adapter completed; no external service was contacted."); return getAction(client, id);
}
export async function actionAudit(client: Client, id: string) { const result = await client.execute({ sql: "SELECT event,reason,created_at FROM action_audit_log WHERE action_id=? ORDER BY created_at", args: [id] }); return result.rows.map((item) => ({ event: String(item.event), reason: String(item.reason), createdAt: String(item.created_at) })); }
