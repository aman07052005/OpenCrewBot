import { handle } from "@/lib/server/http";
import { integrationRegistry } from "@/lib/server/integrations";
export async function GET() { return handle(async () => ({ integrations: await integrationRegistry() })); }
