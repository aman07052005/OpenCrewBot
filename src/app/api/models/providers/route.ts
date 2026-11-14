import { connection } from "next/server";
import { handle } from "@/lib/server/http";
import { listProviders } from "@/lib/server/model-routing";
export async function GET() { await connection(); return handle(async () => ({ providers: await listProviders() })); }
