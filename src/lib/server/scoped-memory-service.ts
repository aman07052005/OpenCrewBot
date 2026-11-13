import { DATA_DIR } from "./config";
import { getBot, getRoom } from "./db";
import { InputError } from "./errors";
import { publish } from "./bus";
import { collectSharedMemory, createMemoryProject, linkMemoryProject, readMemoryCatalog, readMemoryDocument, saveMemoryDocument, sharedMemoryPrompt, validateMemoryTarget } from "./memory-store";
import type { MemoryTarget } from "../shared/scoped-memory";

function inputError(error: unknown): never { throw new InputError(error instanceof Error ? error.message : "Invalid memory request."); }
export async function requireMemoryTarget(target: MemoryTarget) {
  try { validateMemoryTarget(target); } catch (error) { inputError(error); }
  if (target.scope === "agent" && !await getBot(target.id)) throw new InputError("Agent does not exist.");
  if (target.scope === "room" && !await getRoom(target.id)) throw new InputError("Room does not exist.");
  if (target.scope === "project" && !readMemoryCatalog(DATA_DIR).projects.some((p) => p.id === target.id)) throw new InputError("Project does not exist.");
  return target;
}
export async function getScopedMemory(target: MemoryTarget) {
  return readMemoryDocument(DATA_DIR, await requireMemoryTarget(target));
}
export async function updateScopedMemory(input: unknown) {
  if (!input || typeof input !== "object") throw new InputError("Expected a memory update.");
  const { scope, id, content, reason, revision } = input as MemoryTarget & { content: string; reason: string; revision: string };
  if (typeof revision !== "string" || !/^[0-9a-f]{64}$/.test(revision)) throw new InputError("A current memory revision is required.");
  const target = await requireMemoryTarget({ scope, id });
  try {
    const doc = saveMemoryDocument(DATA_DIR, target, { content, reason, actor: "owner", expectedRevision: revision });
    if (target.scope === "agent") publish({ type: "memory-changed", botId: id });
    return doc;
  } catch (error) { inputError(error); }
}
export function getMemoryCatalog() { return readMemoryCatalog(DATA_DIR); }
export async function changeMemoryCatalog(input: unknown) {
  if (!input || typeof input !== "object") throw new InputError("Expected a project action.");
  const action = input as Record<string, unknown>;
  try {
    if (action.action === "create" && typeof action.name === "string") return createMemoryProject(DATA_DIR, action.name);
    if (action.action === "link" && typeof action.roomId === "string" && (typeof action.projectId === "string" || action.projectId === null)) {
      if (!await getRoom(action.roomId)) throw new InputError("Room does not exist.");
      return linkMemoryProject(DATA_DIR, action.roomId, action.projectId);
    }
    throw new InputError("Invalid project action.");
  } catch (error) { inputError(error); }
}
/** Never read room/project memory on an unverified room membership. */
export async function conversationSharedMemory(botId: string, conversationId: string) {
  const room = conversationId.startsWith("room:") ? await getRoom(conversationId.slice(5)) : null;
  return sharedMemoryPrompt(collectSharedMemory(DATA_DIR, room?.memberIds.includes(botId) ? room.id : undefined));
}
