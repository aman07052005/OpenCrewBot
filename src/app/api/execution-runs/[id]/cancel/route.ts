import { handle } from "@/lib/server/http";
import { cancelRun } from "@/lib/server/execution-service";

export async function POST(_request: Request, ctx: RouteContext<"/api/execution-runs/[id]/cancel">) {
  return handle(async () => ({ run: await cancelRun((await ctx.params).id) }));
}
