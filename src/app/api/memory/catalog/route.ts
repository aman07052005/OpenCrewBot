import { body, handle } from "@/lib/server/http";
import { changeMemoryCatalog, getMemoryCatalog } from "@/lib/server/scoped-memory-service";
export async function GET() { return handle(async () => ({ catalog: getMemoryCatalog() })); }
export async function POST(request: Request) { return handle(async () => ({ catalog: await changeMemoryCatalog(await body<unknown>(request)) })); }
