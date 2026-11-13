import { handle } from "@/lib/server/http";
import { installWorkforceTemplates } from "@/lib/server/agent-factory-runtime";

export async function POST() {
  return handle(async () => installWorkforceTemplates());
}

