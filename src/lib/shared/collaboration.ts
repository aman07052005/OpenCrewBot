import type { ChiefOfStaffPlan, ExecutionMode, ExecutionRun } from "./types";

export type CollaborationPhase = "work" | "requests" | "review" | "final" | "continuation";
export type CollaborationRequestKind = "question" | "delegation" | "verification_request" | "challenge";
export interface CollaborationRequest {
  type: CollaborationRequestKind;
  recipientId: string;
  content: string;
}
export interface CollaborationMessage {
  id: string;
  type: CollaborationRequestKind | "assignment" | "intermediate_output" | "research_finding" | "answer" | "verification_result" | "final_contribution" | "notice";
  senderId: string | null;
  recipientId: string | null;
  taskId: string;
  createdAt: string;
  content: string;
  simulated: boolean;
}
export interface CollaborationSession {
  id: string;
  roomId: string;
  objective: string;
  memberIds: string[];
  mode: ExecutionMode;
  createdAt: string;
  closedAt: string | null;
  plan: ChiefOfStaffPlan;
  rounds: { phase: CollaborationPhase; instruction: string; run: ExecutionRun }[];
  messages: CollaborationMessage[];
  status: "pending" | "running" | "blocked" | "awaiting_next" | "interrupted" | "failed" | "completed" | "cancelled";
  finalDeliverable: unknown;
  autoAdvance: boolean;
  autoError: string | null;
  /** Opaque server-issued lease required to save an instruction revision. */
  revisionToken: string | null;
}
export interface CollaborationDraft {
  instruction: string;
  memberIds: string[];
  mode: ExecutionMode;
  plan: ChiefOfStaffPlan;
}
export interface RoomInstallResult {
  installed: string[];
  existing: string[];
  missing: { room: string; handles: string[] }[];
}
