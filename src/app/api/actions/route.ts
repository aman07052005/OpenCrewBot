import { body, handle } from "@/lib/server/http";
import { db, getBot } from "@/lib/server/db";
import { expireActions, listActions, proposeAction } from "@/lib/server/approval-service";
import { InputError } from "@/lib/server/errors";
import { synchronizeActionExecution } from "@/lib/server/execution-service";

export async function GET(request: Request) { return handle(async () => { const client = await db(); for (const action of await expireActions(client)) await synchronizeActionExecution(action); return { actions: await listActions(client, new URL(request.url).searchParams.get("status") ?? undefined, false) }; }); }
export async function POST(request: Request) { return handle(async () => { const input = await body<{ agentId?: string; operation?: string; arguments?: unknown; conversationId?: string; executionRunId?: string; executionTaskId?: string }>(request); if (input.operation === "gmail.demo.read") throw new InputError("Use the Gmail test-message proposal in Connections."); const bot = input.agentId ? await getBot(input.agentId) : null; if (!bot || !input.operation) throw new InputError("A known agent and action operation are required."); return { action: await proposeAction(await db(), bot, { operation: input.operation, arguments: input.arguments, conversationId: input.conversationId, executionRunId: input.executionRunId, executionTaskId: input.executionTaskId }) }; }); }
