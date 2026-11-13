import type { CreateExecutionRunInput } from "@/lib/server/execution-engine";
import { body, handle } from "@/lib/server/http";
import { createRun, runs } from "@/lib/server/execution-service";

export async function GET(request: Request) {
  return handle(async () => {
    const raw = new URL(request.url).searchParams.get("limit");
    const limit = raw === null ? 100 : Number(raw);
    const rawOffset = new URL(request.url).searchParams.get("offset");
    const offset = rawOffset === null ? 0 : Number(rawOffset);
    const beforeCreatedAt = new URL(request.url).searchParams.get("beforeCreatedAt");
    const beforeId = new URL(request.url).searchParams.get("beforeId");
    const before = beforeCreatedAt && beforeId ? { createdAt: beforeCreatedAt, id: beforeId } : undefined;
    return { runs: await runs(limit, offset, before) };
  });
}

export async function POST(request: Request) {
  return handle(async () => ({ run: await createRun(await body<CreateExecutionRunInput>(request)) }));
}
