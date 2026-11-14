import { body, handle } from "@/lib/server/http";
import { db, getBot } from "@/lib/server/db";
import { listActions, proposeAction } from "@/lib/server/approval-service";
import { InputError } from "@/lib/server/errors";

export async function GET(request: Request) { return handle(async () => ({ actions: await listActions(await db(), new URL(request.url).searchParams.get("status") ?? undefined) })); }
export async function POST(request: Request) { return handle(async () => { const input = await body<{ agentId?: string; operation?: string; arguments?: unknown; conversationId?: string; executionRunId?: string; executionTaskId?: string }>(request); const bot = input.agentId ? await getBot(input.agentId) : null; if (!bot || !input.operation) throw new InputError("A known agent and action operation are required."); return { action: await proposeAction(await db(), bot, { operation: input.operation, arguments: input.arguments, conversationId: input.conversationId, executionRunId: input.executionRunId, executionTaskId: input.executionTaskId }) }; }); }
