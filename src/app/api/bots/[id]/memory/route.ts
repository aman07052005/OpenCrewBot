import { body, handle } from "@/lib/server/http";
import { getBot } from "@/lib/server/db";
import { publish } from "@/lib/server/bus";
import { DATA_DIR } from "@/lib/server/config";
import { readMemoryDocument } from "@/lib/server/memory-store";
import { MEMORY_PROMPT_LIMIT, memoryPath, writeMemory } from "@/lib/server/memory-files";
import { InputError } from "@/lib/server/service";

async function requireBot(id: string) {
  if (!(await getBot(id))) throw new InputError("That bot doesn't exist.");
}

export async function GET(_request: Request, ctx: RouteContext<"/api/bots/[id]/memory">) {
  const { id } = await ctx.params;
  return handle(async () => {
    await requireBot(id);
    const doc = readMemoryDocument(DATA_DIR, { scope: "agent", id });
    return { content: doc.content, revision: doc.revision, path: memoryPath(id), limit: MEMORY_PROMPT_LIMIT };
  });
}

export async function PUT(request: Request, ctx: RouteContext<"/api/bots/[id]/memory">) {
  const { id } = await ctx.params;
  return handle(async () => {
    await requireBot(id);
    const { content } = await body<{ content: string }>(request);
    if (typeof content !== "string") throw new InputError("Expected { content }.");
    let saved: string;
    try { saved = writeMemory(id, content); } catch (error) { throw new InputError(error instanceof Error ? error.message : "Unable to save memory."); }
    publish({ type: "memory-changed", botId: id });
    return { content: saved };
  });
}
