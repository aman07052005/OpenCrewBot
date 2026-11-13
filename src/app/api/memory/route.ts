import { body, handle } from "@/lib/server/http";
import { getScopedMemory, updateScopedMemory } from "@/lib/server/scoped-memory-service";
import type { MemoryScope } from "@/lib/shared/scoped-memory";

export async function GET(request: Request) {
  return handle(async () => {
    const params = new URL(request.url).searchParams;
    return { document: await getScopedMemory({ scope: params.get("scope") as MemoryScope, id: params.get("id") ?? "" }) };
  });
}
export async function PUT(request: Request) {
  return handle(async () => ({ document: await updateScopedMemory(await body<unknown>(request)) }));
}
