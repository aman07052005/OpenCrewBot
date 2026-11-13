import { body, handle } from "@/lib/server/http";
import { createFactoryAgent } from "@/lib/server/agent-factory-runtime";

export async function POST(request: Request) {
  return handle(async () => ({ bot: await createFactoryAgent(await body<unknown>(request)) }));
}

