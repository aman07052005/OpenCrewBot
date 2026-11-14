import { body, handle } from "@/lib/server/http";
import { db, getBot } from "@/lib/server/db";
import { InputError } from "@/lib/server/errors";
import { verifyGmailConnection, verifiedGmailAccount } from "@/lib/server/gmail-service";
import { GMAIL_SUBJECT } from "@/lib/server/gmail-integration";
import { proposeAction } from "@/lib/server/approval-service";

export async function POST(request: Request) {
  return handle(async () => {
    const input = await body<{ operation?: string; agentId?: string; subject?: string; testMailbox?: boolean }>(request);
    if (input?.testMailbox !== true) throw new InputError("Confirm that this is an authorized synthetic-only test mailbox.");
    if (input.operation === "verify") return { result: await verifyGmailConnection() };
    if (input.operation !== "propose" || typeof input.subject !== "string" || !GMAIL_SUBJECT.test(input.subject)) throw new InputError("Use a unique subject of the form OpenCrewBot Demo ABC123.");
    const bot = typeof input.agentId === "string" ? await getBot(input.agentId) : null;
    if (!bot || !bot.tools.askUser || !bot.connections.includes("composio:gmail")) throw new InputError("Select a Gmail-enabled agent with approval interaction enabled.");
    const account = await verifiedGmailAccount();
    return { action: await proposeAction(await db(), bot, { operation: "gmail.demo.read", arguments: { accountId: account.id, subject: input.subject } }) };
  });
}
