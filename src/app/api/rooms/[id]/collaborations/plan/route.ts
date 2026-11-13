import { body, handle } from "@/lib/server/http";
import { collaborationPlan } from "@/lib/server/collaboration-service";
export async function POST(request: Request, ctx: RouteContext<"/api/rooms/[id]/collaborations/plan">) {
  return handle(async () => ({ draft: await collaborationPlan((await ctx.params).id, await body<unknown>(request)) }));
}
