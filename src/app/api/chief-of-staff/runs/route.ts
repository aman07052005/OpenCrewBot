import { body, handle } from "@/lib/server/http";
import { createChiefOfStaffRun } from "@/lib/server/execution-service";

export async function POST(request: Request) {
  return handle(async () => ({ run: await createChiefOfStaffRun(await body<unknown>(request)) }));
}

