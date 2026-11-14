import { connection } from "next/server";
import { handle } from "@/lib/server/http";
import { listModelUsage } from "@/lib/server/model-usage";
export async function GET(request: Request) { await connection(); const limit = Number(new URL(request.url).searchParams.get("limit") ?? 100); return handle(async () => ({ usage: await listModelUsage(limit) })); }
