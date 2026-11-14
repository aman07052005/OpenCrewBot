import { connection } from "next/server";
import { body, handle } from "@/lib/server/http";
import type { CreateScheduledWorkflowInput } from "@/lib/shared/types";
import { getScheduledWorkflow, scheduledWorkflowOccurrences, updateScheduledWorkflow } from "@/lib/server/scheduled-workflows";
import { InputError } from "@/lib/server/errors";

export async function GET(_request: Request, ctx: RouteContext<"/api/scheduled-workflows/[id]">) {
  await connection();
  return handle(async () => { const { id } = await ctx.params; const workflow = await getScheduledWorkflow(id); if (!workflow) throw new InputError("Scheduled workflow not found."); return { workflow, occurrences: await scheduledWorkflowOccurrences(id) }; });
}
export async function PATCH(request: Request, ctx: RouteContext<"/api/scheduled-workflows/[id]">) {
  return handle(async () => { const { id } = await ctx.params; return { workflow: await updateScheduledWorkflow(id, await body<Partial<CreateScheduledWorkflowInput & { active: boolean }>>(request)) }; });
}
