import { handle } from "@/lib/server/http";
import { runScheduledWorkflowNow } from "@/lib/server/scheduled-workflows";

export async function POST(_request: Request, ctx: RouteContext<"/api/scheduled-workflows/[id]/run">) {
  return handle(async () => { const { id } = await ctx.params; return { occurrence: await runScheduledWorkflowNow(id) }; });
}
