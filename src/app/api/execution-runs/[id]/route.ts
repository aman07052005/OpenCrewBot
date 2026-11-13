import { handle } from "@/lib/server/http";
import { inspectRun } from "@/lib/server/execution-service";

export async function GET(_request: Request, ctx: RouteContext<"/api/execution-runs/[id]">) {
  return handle(async () => ({ run: await inspectRun((await ctx.params).id) }));
}
