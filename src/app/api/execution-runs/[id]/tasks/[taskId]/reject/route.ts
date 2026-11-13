import { handle } from "@/lib/server/http";
import { rejectTask } from "@/lib/server/execution-service";

export async function POST(_request: Request, ctx: RouteContext<"/api/execution-runs/[id]/tasks/[taskId]/reject">) {
  return handle(async () => {
    const { id, taskId } = await ctx.params;
    return { task: await rejectTask(id, taskId) };
  });
}
