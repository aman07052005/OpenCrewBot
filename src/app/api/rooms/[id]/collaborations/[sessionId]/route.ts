import { body, handle } from "@/lib/server/http";
import { collaborationAction, inspectCollaboration } from "@/lib/server/collaboration-service";
export async function GET(_request: Request, ctx: RouteContext<"/api/rooms/[id]/collaborations/[sessionId]">) {
  return handle(async () => { const { id, sessionId } = await ctx.params; return { session: await inspectCollaboration(id, sessionId) }; });
}
export async function POST(request: Request, ctx: RouteContext<"/api/rooms/[id]/collaborations/[sessionId]">) {
  return handle(async () => { const { id, sessionId } = await ctx.params; return { session: await collaborationAction(id, sessionId, await body<unknown>(request)) }; });
}
