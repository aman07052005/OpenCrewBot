import { body, handle } from "@/lib/server/http";
import { verifyProviderConnection } from "@/lib/server/provider-runtime";
import { InputError } from "@/lib/server/errors";

export async function POST(_request: Request, ctx: RouteContext<"/api/models/providers/[id]/verify">) {
  return handle(async () => {
    await body<Record<string, never>>(_request);
    const { id } = await ctx.params;
    if (id !== "openai-compatible" && id !== "ollama") throw new InputError("Only configured compatible providers can be verified here.");
    return { verification: await verifyProviderConnection(id) };
  });
}
