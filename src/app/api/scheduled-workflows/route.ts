import { connection } from "next/server";
import { body, handle } from "@/lib/server/http";
import type { CreateScheduledWorkflowInput } from "@/lib/shared/types";
import { createScheduledWorkflow, listScheduledWorkflows } from "@/lib/server/scheduled-workflows";

export async function GET() {
  // Never initialize the application database while Next is collecting build output.
  await connection();
  return handle(async () => ({ workflows: await listScheduledWorkflows() }));
}
export async function POST(request: Request) { return handle(async () => ({ workflow: await createScheduledWorkflow(await body<CreateScheduledWorkflowInput>(request)) })); }
