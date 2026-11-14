// Your own MCP servers (GitHub's remote server, a company server, anything
// that speaks MCP over HTTP). Tokens are stored server-side in the app's
// database and never sent to the browser.
import { randomUUID } from "node:crypto";
import { MCPClient } from "@mastra/mcp";
import type { ToolsInput } from "@mastra/core/agent";
import type { McpServer } from "@/lib/shared/types";
import { getSetting, setSetting } from "./db";
import { InputError } from "./errors";
import { recordIntegrationFailure, recordIntegrationSuccess } from "./integration-status";
import { redactIntegrationText, redactIntegrationValue } from "./integration-safety";

interface StoredServer {
  id: string;
  name: string;
  url: string;
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Extra headers, e.g. a toolset filter. Values can be secret too. */
  headers?: Record<string, string>;
}

const KEY = "mcp.servers";
const ENABLED_TOOLS_KEY = "mcp.enabled-read-tools";

export const redactMcpResult = redactIntegrationValue;

async function stored(): Promise<StoredServer[]> {
  return (await getSetting<StoredServer[]>(KEY)) ?? [];
}

function toPublic(s: StoredServer): McpServer {
  const url = new URL(s.url);
  url.username = "";
  url.password = "";
  return { id: s.id, name: s.name, url: url.toString(), hasToken: Boolean(s.token), headerNames: Object.keys(s.headers ?? {}) };
}

export async function listServers(): Promise<McpServer[]> {
  return (await stored()).map(toPublic);
}

/** Tool names are prefixed with the server key, so keep it short and safe. */
export function serverKey(id: string): string {
  return `mcp_${id}`;
}

function validate(input: { name?: string; url?: string }) {
  if (!input.name?.trim()) throw new InputError("Give the server a name.");
  try {
    const url = new URL(input.url ?? "");
    if (url.username || url.password) throw new InputError("Put credentials in the token or header fields, not the server URL.");
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
      throw new InputError("Use an https:// URL (http is only allowed for localhost).");
    }
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("That doesn't look like a URL.");
  }
}

export async function addServer(input: { name: string; url: string; token?: string; headers?: Record<string, string> }): Promise<McpServer> {
  validate(input);
  const server: StoredServer = {
    id: randomUUID().slice(0, 6),
    name: input.name.trim().slice(0, 40),
    url: input.url.trim(),
    token: input.token?.trim() || undefined,
    headers: Object.fromEntries(Object.entries(input.headers ?? {}).filter(([k, v]) => k.trim() && v.trim())),
  };
  await setSetting(KEY, [...(await stored()), server]);
  return toPublic(server);
}

export async function removeServer(id: string): Promise<void> {
  await setSetting(
    KEY,
    (await stored()).filter((s) => s.id !== id),
  );
}

function clientFor(servers: StoredServer[], id: string): MCPClient {
  return new MCPClient({
    id,
    timeout: 30_000,
    servers: Object.fromEntries(
      servers.map((s) => [
        serverKey(s.id),
        {
          url: new URL(s.url),
          requestInit: {
            headers: { ...(s.headers ?? {}), ...(s.token ? { Authorization: `Bearer ${s.token}` } : {}) },
          },
        },
      ]),
    ),
  });
}

/** Connect once and report how many tools the server offers. */
export async function testServer(id: string): Promise<{ tools: number }> {
  const server = (await stored()).find((s) => s.id === id);
  if (!server) throw new InputError("That server doesn't exist.");
  const client = clientFor([server], `test-${id}-${Date.now()}`);
  try {
    const result = { tools: Object.keys(await client.listTools()).length };
    await recordIntegrationSuccess(`mcp:${id}`);
    return result;
  } catch (error) {
    await recordIntegrationFailure(`mcp:${id}`, error);
    throw new InputError(`MCP connection test failed: ${redactIntegrationText(error instanceof Error ? error.message : String(error))}`);
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/** Serializable discovery for the integrations UI; no tool is invoked. */
type McpDefinition = { description?: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean } };
async function definitionsFor(server: StoredServer) {
  const client = clientFor([server], `inspect-${server.id}-${Date.now()}`);
  try {
    const definitions = await client.listToolDefinitions() as unknown as Record<string, Record<string, McpDefinition>>;
    return definitions[serverKey(server.id)] ?? {};
  } catch (error) {
    throw new InputError(`MCP discovery failed: ${redactIntegrationText(error instanceof Error ? error.message : String(error))}`);
  } finally { await client.disconnect().catch(() => {}); }
}
export async function inspectServerTools(id: string): Promise<{ tools: Array<{ name: string; description: string; inputSchema: unknown; annotations: unknown; enabled: boolean }> }> {
  const server = (await stored()).find((item) => item.id === id);
  if (!server) throw new InputError("That server doesn't exist.");
  const enabled = (await getSetting<Record<string, string[]>>(ENABLED_TOOLS_KEY) ?? {})[id] ?? [];
  const set = await definitionsFor(server);
  return { tools: Object.entries(set).slice(0, 100).map(([name, tool]) => ({ name, description: tool.description ?? "", inputSchema: tool.inputSchema ?? {}, annotations: tool.annotations ?? null, enabled: enabled.includes(name) })) };
}

/** Owner configuration can enable only MCP-advertised read-only tools. */
export async function setEnabledReadTools(id: string, names: unknown): Promise<{ enabled: string[] }> {
  if (!Array.isArray(names) || names.length > 20 || !names.every((name) => typeof name === "string" && /^[A-Za-z0-9_.-]{1,160}$/.test(name))) throw new InputError("Choose up to 20 valid MCP tool names.");
  const server = (await stored()).find((item) => item.id === id); if (!server) throw new InputError("That server doesn't exist.");
  const definitions = await definitionsFor(server);
  const enabled = [...new Set(names)].filter((name) => definitions[name]?.annotations?.readOnlyHint === true);
  if (enabled.length !== new Set(names).size) throw new InputError("Only MCP tools explicitly advertised as read-only may be enabled.");
  const all = (await getSetting<Record<string, string[]>>(ENABLED_TOOLS_KEY) ?? {}); await setSetting(ENABLED_TOOLS_KEY, { ...all, [id]: enabled }); return { enabled };
}

/** Bounded, protocol-backed invocation for a configured read-only MCP tool. */
export async function invokeEnabledReadTool(id: string, name: string, input: unknown): Promise<unknown> {
  if (!/^[A-Za-z0-9_.-]{1,160}$/.test(name) || JSON.stringify(input ?? null).length > 10_000) throw new InputError("MCP invocation name or input is outside safety limits.");
  const server = (await stored()).find((item) => item.id === id); if (!server) throw new InputError("That server doesn't exist.");
  const enabled = (await getSetting<Record<string, string[]>>(ENABLED_TOOLS_KEY) ?? {})[id] ?? [];
  if (!enabled.includes(name)) throw new InputError("That MCP tool is not owner-enabled for read-only invocation.");
  // Re-check the live schema, rather than trusting an old enablement record.
  // A remote server that changes a tool from read-only to an action must not
  // retain permission merely because it used to advertise a safe annotation.
  const definitions = await definitionsFor(server);
  if (definitions[name]?.annotations?.readOnlyHint !== true) {
    throw new InputError("That MCP tool is no longer advertised as read-only.");
  }
  const client = clientFor([server], `invoke-${id}-${Date.now()}`);
  try {
    const tools = await client.listTools(); const tool = tools[`${serverKey(id)}_${name}`] as { execute?: (value: Record<string, unknown>) => Promise<unknown> } | undefined;
    if (!tool?.execute) throw new InputError("The enabled MCP tool is no longer available.");
    const output = await tool.execute((input ?? {}) as Record<string, unknown>); const serialized = JSON.stringify(output); if (serialized === undefined) throw new InputError("MCP tool returned an unsupported response.");
    if (serialized.length > 100_000) throw new InputError("MCP response exceeds the 100 KB safety limit.");
    return redactMcpResult(JSON.parse(serialized));
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(`MCP invocation failed: ${redactIntegrationText(error instanceof Error ? error.message : String(error))}`);
  } finally { await client.disconnect().catch(() => {}); }
}

/** Tools from the given servers for one bot. The returned close() disconnects them. */
export async function mcpTools(ids: string[], clientId: string): Promise<{ tools: ToolsInput; close: () => Promise<void>; errors: string[] }> {
  const servers = (await stored()).filter((s) => ids.includes(s.id));
  if (servers.length === 0) return { tools: {}, close: async () => {}, errors: [] };
  const tools: ToolsInput = {};
  const errors: string[] = [];
  const clients: MCPClient[] = [];
  const enabledByServer = (await getSetting<Record<string, string[]>>(ENABLED_TOOLS_KEY)) ?? {};
  // One client per server, so one unreachable server doesn't take the others down.
  for (const server of servers) {
    const client = clientFor([server], `${clientId}-${server.id}`);
    clients.push(client);
    try {
      const [remoteTools, definitions] = await Promise.all([client.listTools(), client.listToolDefinitions()]) as [ToolsInput, Record<string, Record<string, McpDefinition>>];
      const enabled = new Set(enabledByServer[server.id] ?? []);
      const prefix = `${serverKey(server.id)}_`;
      for (const [key, tool] of Object.entries(remoteTools)) {
        const name = key.startsWith(prefix) ? key.slice(prefix.length) : "";
        // Conversation execution receives exactly the same narrow allow-list
        // as the direct integration endpoint. Raw MCP write tools never enter
        // the model's toolset.
        if (enabled.has(name) && definitions[serverKey(server.id)]?.[name]?.annotations?.readOnlyHint === true) {
          const executable = tool as { execute?: (input: unknown) => Promise<unknown> };
          // MCP results enter model context and chat history. Redact them at
          // the transport boundary so provider output cannot disclose a stored
          // credential through a tool response.
          tools[key] = { ...tool, execute: async (input: unknown) => redactMcpResult(await executable.execute?.(input)) } as ToolsInput[string];
        }
      }
    } catch (error) {
      errors.push(`${server.name}: ${redactIntegrationText(error instanceof Error ? error.message : String(error))}`);
    }
  }
  return { tools, errors, close: async () => void (await Promise.all(clients.map((c) => c.disconnect().catch(() => {})))) };
}
