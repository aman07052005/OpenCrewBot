import { body, handle } from "@/lib/server/http";
import { generateFactoryAgent } from "@/lib/server/agent-factory-runtime";

export async function POST(request: Request) {
  return handle(async () => ({ draft: await generateFactoryAgent(await body<unknown>(request)) }));
}

