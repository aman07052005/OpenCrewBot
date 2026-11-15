import { body, handle } from "@/lib/server/http";
import { db, getBot } from "@/lib/server/db";
import { actionAudit, decideAction, executeApprovedAction, getAction } from "@/lib/server/approval-service";
import { executeGmailRead } from "@/lib/server/gmail-service";
import { InputError } from "@/lib/server/errors";
import { synchronizeActionExecution } from "@/lib/server/execution-service";
import { executionActionHandlers } from "@/lib/server/execution-actions";

export async function GET(_request: Request, ctx: RouteContext<"/api/actions/[id]">) { return handle(async () => { const { id } = await ctx.params; const action = await getAction(await db(), id); if (!action) throw new InputError("Action request not found."); return { action, audit: await actionAudit(await db(), id) }; }); }
export async function POST(request: Request, ctx: RouteContext<"/api/actions/[id]">) { return handle(async () => { const { id } = await ctx.params; const input = await body<{ decision?: "approve" | "reject" | "cancel"; execute?: boolean }>(request); const client = await db(); if (input.decision) { const action = await decideAction(client, id, input.decision); if (!action) { const current = await getAction(client, id); if (current?.status === "expired") { await synchronizeActionExecution(current); throw new InputError("This approval expired before the decision. Its execution task was failed and no provider was invoked."); } throw new InputError("Action is no longer pending approval."); } await synchronizeActionExecution(action); return { action }; } const action = await getAction(client, id); const bot = action ? await getBot(action.agentId) : null; if (!action || !bot || !input.execute) throw new InputError("A valid approved action is required."); const executed = await executeApprovedAction(client, id, bot, { ...executionActionHandlers, gmailRead: executeGmailRead }); if (executed) await synchronizeActionExecution(executed); return { action: executed }; }); }
