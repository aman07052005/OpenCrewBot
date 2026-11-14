import { body, handle } from "@/lib/server/http";
import { getBot } from "@/lib/server/db";
import { InputError } from "@/lib/server/errors";
import { inspectServerTools, invokeEnabledReadTool, setEnabledReadTools } from "@/lib/server/mcp-servers";
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) { return handle(async () => { const { id } = await ctx.params; return inspectServerTools(id); }); }
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) { return handle(async () => { const { id } = await ctx.params; const input = await body<{ tools?: unknown }>(request); return setEnabledReadTools(id, input.tools); }); }
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) { return handle(async () => { const { id } = await ctx.params; const input = await body<{ agentId?: string; tool?: string; input?: unknown }>(request); const bot = input.agentId ? await getBot(input.agentId) : null; if (!bot || !bot.connections.includes(`mcp:${id}`)) throw new InputError("Select an agent explicitly authorized for this MCP server."); if (typeof input.tool !== "string") throw new InputError("Choose an owner-enabled MCP tool."); return { integration: "mcp", serverId: id, tool: input.tool, result: await invokeEnabledReadTool(id, input.tool, input.input) }; }); }
