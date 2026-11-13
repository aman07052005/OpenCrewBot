import type { Client } from "@libsql/client";
import type { Bot, Room } from "../shared/types";
import type { RoomInstallResult } from "../shared/collaboration";

const templates = [
  { id: "market-intelligence", name: "Market Intelligence", topic: "Competitor research and strategic opportunities", emoji: "🔎", handles: ["scout", "nova", "sentinel"] },
  { id: "marketing-campaign", name: "Marketing Campaign", topic: "Campaign strategy and content creation", emoji: "📣", handles: ["spark", "quill", "scout"] },
  { id: "business-analytics", name: "Business Analytics", topic: "Data analysis and financial recommendations", emoji: "📊", handles: ["cipher", "ledger", "atlas"] },
  { id: "development-team", name: "Development Team", topic: "Repository analysis and technical planning", emoji: "💻", handles: ["forge", "sentinel", "atlas"] },
];
export async function installRoomTemplates(client: Client, bots: Bot[], rooms: Room[]): Promise<RoomInstallResult> {
  const result: RoomInstallResult = { installed: [], existing: [], missing: [] };
  for (const template of templates) {
    const id = `collab-${template.id}`;
    if (rooms.some((r) => r.id === id || r.name.toLowerCase() === template.name.toLowerCase())) { result.existing.push(template.name); continue; }
    const missing = template.handles.filter((handle) => !bots.some((b) => b.handle === handle));
    if (missing.length) { result.missing.push({ room: template.name, handles: missing }); continue; }
    const memberIds = template.handles.map((handle) => bots.find((b) => b.handle === handle)!.id);
    const room: Room = { id, name: template.name, topic: template.topic, emoji: template.emoji, memberIds, leadId: memberIds[0], responder: "auto", pinned: false, createdAt: new Date().toISOString() };
    const write = await client.execute({ sql: "INSERT OR IGNORE INTO rooms(id,data) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM rooms WHERE lower(json_extract(data,'$.name'))=lower(?))", args: [id, JSON.stringify(room), room.name] });
    (write.rowsAffected ? result.installed : result.existing).push(template.name);
  }
  return result;
}
