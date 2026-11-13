import { handle } from "@/lib/server/http";
import { startRun } from "@/lib/server/execution-service";

export async function POST(_request: Request, ctx: RouteContext<"/api/execution-runs/[id]/start">) {
  return handle(async () => ({ run: await startRun((await ctx.params).id) }));
}
