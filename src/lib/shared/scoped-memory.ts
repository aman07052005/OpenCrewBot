export type MemoryScope = "agent" | "room" | "project" | "preferences" | "decisions" | "history";
export interface MemoryTarget { scope: MemoryScope; id: string }
export interface MemoryAudit { at: string; actor: string; reason: string; revision: string; previousRevision: string; operation?: "create" | "edit" | "clear"; bytes?: number }
export interface MemoryDocument extends MemoryTarget { content: string; revision: string; audit: MemoryAudit[]; untracked: boolean }
export interface MemoryProject { id: string; name: string; createdAt: string }
export interface MemoryCatalog { projects: MemoryProject[]; roomProjects: Record<string, string> }
export interface MemoryReference extends MemoryTarget { revision: string; text: string; truncated: boolean }
