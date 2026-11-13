"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import type { MemoryCatalog, MemoryDocument, MemoryScope, MemoryTarget } from "@/lib/shared/scoped-memory";
import { useApp } from "./OpenCrewBotApp";
import { Button, Drawer, Field, inputClass } from "./ui";

const scopes: { id: MemoryScope; label: string }[] = [
  { id: "preferences", label: "User preferences" }, { id: "decisions", label: "Important decisions" }, { id: "history", label: "Historical context" },
  { id: "agent", label: "Individual agent" }, { id: "room", label: "Shared room" }, { id: "project", label: "Project" },
];
const errorText = (error: unknown) => error instanceof Error ? error.message : "Memory operation failed.";
export function MemoryManager({ onClose }: { onClose: () => void }) {
  const { state } = useApp();
  const [catalog, setCatalog] = useState<MemoryCatalog>({ projects: [], roomProjects: {} });
  const [scope, setScope] = useState<MemoryScope>("preferences");
  const [id, setId] = useState("owner");
  const [doc, setDoc] = useState<MemoryDocument | null>(null);
  const [content, setContent] = useState("");
  const [reason, setReason] = useState("");
  const [name, setName] = useState("");
  const [roomId, setRoomId] = useState(state.rooms[0]?.id ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const dirty = doc !== null && content !== doc.content;
  const choices = scope === "agent" ? state.bots : scope === "room" ? state.rooms : scope === "project" ? catalog.projects : [];
  const target: MemoryTarget = { scope, id };
  useEffect(() => { let active = true; api.memoryCatalog().then(({ catalog }) => { if (active) setCatalog(catalog); }).catch((e) => { if (active) setError(errorText(e)); }); return () => { active = false; }; }, []);
  useEffect(() => {
    if (!id) return;
    let active = true;
    api.scopedMemory({ scope, id }).then(({ document }) => { if (active) { setDoc(document); setContent(document.content); setReason(""); } }).catch((e) => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [scope, id, reload]);
  const discardOK = () => !dirty || window.confirm("Discard unsaved memory edits?");
  const select = (next: MemoryScope, nextId: string) => {
    if (!discardOK()) return;
    setDoc(null); setError(""); setContent(""); setReason(""); setScope(next); setId(nextId);
  };
  const changeScope = (next: MemoryScope) => select(next, next === "agent" ? state.bots[0]?.id ?? "" : next === "room" ? state.rooms[0]?.id ?? "" : next === "project" ? catalog.projects[0]?.id ?? "" : "owner");
  const save = async () => {
    if (!doc || !dirty || !reason.trim()) return;
    setBusy(true); setError("");
    try { const { document } = await api.saveScopedMemory(target, content, doc.revision, reason); setDoc(document); setContent(document.content); setReason(""); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true); setError("");
    try { const result = await api.changeMemoryCatalog({ action: "create", name }); setCatalog(result.catalog); setName(""); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const link = async (projectId: string) => {
    setBusy(true); setError("");
    try { const result = await api.changeMemoryCatalog({ action: "link", roomId, projectId: projectId || null }); setCatalog(result.catalog); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <Drawer title="Memory manager" onClose={() => { if (!busy && discardOK()) onClose(); }}>
    <div className="space-y-4 text-[13px]">
      <p className="text-mute">Persistent Markdown context. Current notes are loaded for memory-enabled agents on future turns and tasks. Keep secrets out of memory.</p>
      <Field label="Memory scope"><select className={inputClass} value={scope} disabled={busy} onChange={(e) => changeScope(e.target.value as MemoryScope)}>{scopes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
      {(["agent", "room", "project"] as MemoryScope[]).includes(scope) && <Field label="Select document"><select className={inputClass} value={id} disabled={busy} onChange={(e) => select(scope, e.target.value)}><option value="">Select…</option>{choices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>}
      {scope === "project" && <section className="space-y-2 rounded-xl border border-line p-3"><Field label="New project"><input className={inputClass} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></Field><Button disabled={busy || !name.trim()} onClick={create}>Create project</Button></section>}
      {scope === "project" && <section className="space-y-2 rounded-xl border border-line p-3"><p className="font-medium">Link a room to a project</p><p className="text-mute">Members receive that project’s memory only while working in the linked room. A project can have multiple rooms.</p><Field label="Room"><select className={inputClass} value={roomId} disabled={busy} onChange={(e) => setRoomId(e.target.value)}><option value="">Select room…</option>{state.rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select></Field><Field label="Linked project"><select className={inputClass} value={catalog.roomProjects[roomId] ?? ""} disabled={busy || !roomId} onChange={(e) => void link(e.target.value)}><option value="">No project</option>{catalog.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field></section>}
      {error && <p role="alert" className="rounded-xl bg-danger-soft p-3 text-danger">{error}</p>}
      {id && <section className="space-y-3"><Field label="MEMORY.md" hint="Markdown source; the first portion is loaded into the model context."><textarea aria-label="Memory Markdown" className={`${inputClass} min-h-48 resize-y font-mono`} value={content} disabled={!doc || busy} onChange={(e) => setContent(e.target.value)} /></Field><Field label="Reason for change" hint="Recorded with the date, actor and document revision."><input className={inputClass} value={reason} maxLength={500} disabled={!doc || busy} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Correct preferred report format" /></Field><div className="flex gap-2"><Button variant="primary" disabled={busy || !dirty || !reason.trim()} onClick={save}>{busy ? "Working…" : "Save memory"}</Button><Button disabled={busy} onClick={() => { if (discardOK()) { setDoc(null); setError(""); setReload((x) => x + 1); } }}>Reload</Button></div>{doc && <p className="break-all text-[11px] text-faint">Revision: {doc.revision.slice(0, 12)} · {dirty ? "Unsaved changes" : "Current file loaded"}</p>}{doc?.untracked && <p className="text-warn">This file predates the audit log or was edited outside OpenCrewBot. Its current content is still used.</p>}</section>}
      {doc && <section className="space-y-2"><h3 className="font-semibold">Memory provenance</h3>{doc.audit.length === 0 ? <p className="text-mute">No recorded changes yet.</p> : doc.audit.map((entry, index) => <div className="rounded-xl border border-line p-3" key={`${entry.at}-${index}`}><p>{entry.reason}</p><p className="text-[11px] text-mute">{entry.actor} · {new Date(entry.at).toLocaleString()} · {entry.operation ?? "edit"} · {entry.bytes ?? "—"} bytes · {entry.previousRevision.slice(0, 8)} → {entry.revision.slice(0, 8)}</p></div>)}</section>}
    </div>
  </Drawer>;
}
