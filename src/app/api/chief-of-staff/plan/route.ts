import { body, handle } from "@/lib/server/http";
import { planChiefOfStaffRequest } from "@/lib/server/execution-service";

export async function POST(request: Request) {
  return handle(async () => planChiefOfStaffRequest(await body<unknown>(request)));
}

