import { z } from "zod";
import type { Bot, ChiefOfStaffPlan } from "../shared/types";
import type { CollaborationDraft, CollaborationSession, RoomInstallResult } from "../shared/collaboration";
import { ChiefOfStaffPlanSchema, discoverAgentCapabilities, planChiefOfStaff, validateChiefOfStaffPlan } from "./chief-of-staff";
import { createLiveChiefOfStaffPlanGenerator } from "./chief-of-staff-model";
import { isMock, keys } from "./config";
import * as store from "./db";
import { InputError } from "./errors";
import { cancelRun, startRun } from "./execution-service";
import { advanceSession, assertParticipants, closeSession, continueSession, createSession, getSession, listSessions, resumeSession } from "./collaboration-store";
import { COLLABORATION_LIMITS as L } from "./collaboration-protocol";
import { publish } from "./bus";
import { installRoomTemplates } from "./collaboration-templates";

const RequestSchema = z.object({ instruction: z.string().trim().min(1).max(12_000), memberIds: z.array(z.string().min(1).max(200)).min(2).max(L.maxMembers), mode: z.enum(["mock", "live"]) }).strict();
const DraftSchema = RequestSchema.extend({ plan: ChiefOfStaffPlanSchema }).strict();
const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("advance") }).strict(),
  z.object({ action: z.literal("interrupt") }).strict(),
  z.object({ action: z.literal("resume") }).strict(),
  z.object({ action: z.literal("cancel") }).strict(),
  z.object({ action: z.literal("continue"), draft: DraftSchema }).strict(),
]);
async function validated<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { throw new InputError(e instanceof Error ? e.message : "Invalid collaboration request."); }
}
async function roomMembers(roomId: string, ids: string[]): Promise<Bot[]> {
  const room = await store.getRoom(roomId);
  if (!room) throw new Error("Room not found.");
  return assertParticipants(ids, room.memberIds, await store.listBots());
}
function requireLive(mode: "mock" | "live") {
  if (mode === "live" && isMock()) throw new Error("LIVE requires an owner-configured live provider. No mock fallback is performed.");
}
function checkedPlan(draft: CollaborationDraft, members: Bot[]): ChiefOfStaffPlan {
  if (draft.mode !== draft.plan.planningMode) throw new Error("Planning and execution mode must match.");
  return validateChiefOfStaffPlan(draft.plan, members.map((b) => b.id));
}
export async function collaborationPlan(roomId: string, input: unknown) {
  return validated(async () => {
    const req = RequestSchema.parse(input);
    const members = await roomMembers(roomId, req.memberIds);
    requireLive(req.mode);
    const plan = await planChiefOfStaff({ instruction: req.instruction, planningMode: req.mode }, { agents: discoverAgentCapabilities(members, { tavilyAvailable: keys.tavily() }), generateLivePlan: req.mode === "live" ? createLiveChiefOfStaffPlanGenerator() : undefined });
    return { ...req, plan };
  });
}
export async function newCollaboration(roomId: string, input: unknown) {
  return validated(async () => {
    const draft = DraftSchema.parse(input);
    const members = await roomMembers(roomId, draft.memberIds);
    requireLive(draft.mode);
    return createSession(await store.db(), roomId, { ...draft, plan: checkedPlan(draft, members) }, members);
  });
}
export async function roomCollaborations(roomId: string) {
  return validated(async () => {
    if (!await store.getRoom(roomId)) throw new Error("Room not found.");
    return listSessions(await store.db(), roomId);
  });
}
export async function inspectCollaboration(roomId: string, id: string): Promise<CollaborationSession> {
  const session = await getSession(await store.db(), id);
  if (!session || session.roomId !== roomId) throw new InputError("Collaboration not found in this room.");
  return session;
}
// Serialise mutations in the local server. The database also rejects duplicate round ordinals.
const g = globalThis as unknown as { __crewCollaborationLocks?: Set<string> };
const busy = (g.__crewCollaborationLocks ??= new Set());
export async function collaborationAction(roomId: string, id: string, input: unknown) {
  return validated(async () => {
    if (busy.has(id)) throw new Error("A collaboration change is already in progress.");
    busy.add(id);
    try {
      const action = ActionSchema.parse(input);
      const session = await inspectCollaboration(roomId, id);
      if (session.status === "completed" || session.status === "cancelled") throw new Error("This session is closed or completed.");
      const latest = session.rounds.at(-1)!;
      const client = await store.db();
      if (action.action === "interrupt" || action.action === "cancel") {
        if (["pending", "running", "blocked"].includes(latest.run.status)) await cancelRun(latest.run.id);
        else if (action.action === "interrupt") throw new Error("The stage already stopped. Advance or submit a revised plan when ready.");
        const stopped = await inspectCollaboration(roomId, id);
        if (action.action === "cancel") await closeSession(client, stopped);
        return inspectCollaboration(roomId, id);
      }
      const members = await roomMembers(roomId, session.memberIds);
      requireLive(session.mode);
      switch (action.action) {
        case "start":
          if (session.status !== "pending") throw new Error("Only a pending stage can be started. Use the approval buttons for blocked tasks.");
          await startRun(latest.run.id);
          return inspectCollaboration(roomId, id);
        case "advance": return advanceSession(client, session, members);
        case "resume": return resumeSession(client, session);
        case "continue": {
          const draft = action.draft;
          if (draft.mode !== session.mode || [...draft.memberIds].sort().join("\0") !== [...session.memberIds].sort().join("\0")) throw new Error("A continuation must use the same members and execution mode.");
          return continueSession(client, session, { ...draft, plan: checkedPlan(draft, members) }, members);
        }
      }
    } finally { busy.delete(id); }
  });
}

export async function installCollaborationRooms(): Promise<RoomInstallResult> {
  return validated(async () => {
    const [bots, rooms, client] = await Promise.all([store.listBots(), store.listRooms(), store.db()]);
    const result = await installRoomTemplates(client, bots, rooms);
    if (result.installed.length) publish({ type: "rooms-changed" });
    return result;
  });
}
