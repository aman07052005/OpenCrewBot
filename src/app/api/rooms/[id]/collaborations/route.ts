import { body, handle } from "@/lib/server/http";
import { newCollaboration, roomCollaborations } from "@/lib/server/collaboration-service";
export async function GET(_request: Request, ctx: RouteContext<"/api/rooms/[id]/collaborations">) {
  return handle(async () => ({ sessions: await roomCollaborations((await ctx.params).id) }));
}
export async function POST(request: Request, ctx: RouteContext<"/api/rooms/[id]/collaborations">) {
  return handle(async () => ({ session: await newCollaboration((await ctx.params).id, await body<unknown>(request)) }));
}
