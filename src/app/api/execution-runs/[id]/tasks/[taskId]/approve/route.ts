import { handle } from "@/lib/server/http";
import { approveTask } from "@/lib/server/execution-service";

export async function POST(_request: Request, ctx: RouteContext<"/api/execution-runs/[id]/tasks/[taskId]/approve">) {
  return handle(async () => {
    const { id, taskId } = await ctx.params;
    return { task: await approveTask(id, taskId) };
  });
}
