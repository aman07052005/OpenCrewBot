"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import type { Bot, ChiefOfStaffTask, ExecutionMode, Room } from "@/lib/shared/types";
import type { CollaborationDraft, CollaborationSession } from "@/lib/shared/collaboration";
import { useApp } from "./OpenCrewBotApp";
import { Button, inputClass } from "./ui";

function display(value: unknown): string {
  if (value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string") return (value as { text: string }).text;
  return JSON.stringify(value, null, 2) ?? "";
}

export function CollaborationPanel({ room, members }: { room: Room; members: Bot[] }) {
  const { state, openExecutions } = useApp();
  const [sessions, setSessions] = useState<CollaborationSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [memberIds, setMemberIds] = useState(room.memberIds.slice(0, 12));
  const [mode, setMode] = useState<ExecutionMode>("mock");
  const [draft, setDraft] = useState<CollaborationDraft | null>(null);
  const [revising, setRevising] = useState(false);
  const [revisionToken, setRevisionToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const busyRef = useRef(false);
  const session = sessions.find((s) => s.id === selectedId);
  const latest = session?.rounds.at(-1);
  const name = (id: string | null) => id ? state.bots.find((b) => b.id === id)?.name ?? id : "Coordinator / system";

  function update(s: CollaborationSession) {
    setSessions((prev) => [s, ...prev.filter((p) => p.id !== s.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    setSelectedId(s.id);
  }
  useEffect(() => {
    let active = true;
    void api.collaborationHistory(room.id).then(({ sessions }) => {
      if (active) { setSessions(sessions); setLoading(false); }
    }).catch((e: unknown) => { if (active) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { active = false; };
  }, [room.id]);
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    let inFlight = false;
    async function poll() {
      if (inFlight || busyRef.current) return;
      inFlight = true;
      const version = epoch.current;
      try {
        const { session: updated } = await api.collaborationSession(room.id, selectedId!);
        if (active && version === epoch.current) setSessions((prev) => prev.map((s) => s.id === updated.id ? updated : s));
      } catch (e) { if (active && version === epoch.current) setError(e instanceof Error ? e.message : String(e)); }
      finally { inFlight = false; }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 1800);
    return () => { active = false; window.clearInterval(timer); };
  }, [room.id, selectedId]);
  async function perform(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    epoch.current++;
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  function reset() { setSelectedId(null); setDraft(null); setRevising(false); setRevisionToken(null); setInstruction(""); setMemberIds(room.memberIds.slice(0, 12)); setMode("mock"); setError(""); }
  function editTask(key: string, patch: Partial<ChiefOfStaffTask>) {
    setDraft((d) => d ? { ...d, plan: { ...d.plan, tasks: d.plan.tasks.map((t) => t.key === key ? { ...t, ...patch } : t) } } : d);
  }
  const canRevise = session && ["interrupted", "failed", "awaiting_next"].includes(session.status);
  const terminal = session && ["completed", "cancelled"].includes(session.status);
  const showForm = !session || revising;
  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 pb-6" aria-label="Multi-agent collaboration">
      <div className="mx-auto max-w-[900px] space-y-4">
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div><h2 className="text-lg font-semibold">Multi-agent collaboration</h2><p className="text-sm text-mute">Persistent stages, shared outputs and owner-approved agent requests.</p></div>
          <Button size="sm" onClick={reset} disabled={busy}>New session</Button>
        </header>
        {error && <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger">{error}</p>}
        <div className="rounded-xl border border-line p-3">
          <label className="text-sm text-mute">Session history</label>
          <select className={inputClass} value={selectedId ?? ""} disabled={busy || loading} onChange={(e) => { setSelectedId(e.target.value || null); setRevising(false); setRevisionToken(null); setDraft(null); setError(""); }}>
            <option value="">{loading ? "Loading sessions…" : "New collaboration"}</option>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.mode.toUpperCase()} · {s.status} · {s.objective.slice(0, 90)}</option>)}
          </select>
        </div>
        {showForm && <div className="space-y-3 rounded-xl border border-line p-4">
          <h3 className="font-medium">{revising ? "Updated instruction — new work only" : "Plan a collaboration"}</h3>
          {revising && <p className="text-sm text-mute">Completed outputs are carried into the new stage. Describe only the additional or changed work; started tasks will not be replayed automatically.</p>}
          <textarea className={`${inputClass} min-h-24`} value={instruction} maxLength={12000} onChange={(e) => { setInstruction(e.target.value); setDraft(null); }} placeholder="Research alternatives; compare their strengths; prepare recommendations." disabled={busy} />
          <label className="block text-sm text-mute">Execution mode<select className={inputClass} value={mode} disabled={busy || revising} onChange={(e) => { setMode(e.target.value as ExecutionMode); setDraft(null); }}><option value="mock">MOCK — no model calls</option><option value="live">LIVE — configured model, no fallback</option></select></label>
          <div className="flex flex-wrap gap-3">{members.map((b) => <label key={b.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={memberIds.includes(b.id)} disabled={busy || revising} onChange={(e) => { setDraft(null); setMemberIds((ids) => e.target.checked ? [...ids, b.id] : ids.filter((id) => id !== b.id)); }} />{b.name}</label>)}</div>
          <Button variant="primary" disabled={busy || !instruction.trim() || memberIds.length < 2 || memberIds.length > 12} onClick={() => void perform(async () => { const result = await api.collaborationPlan(room.id, { instruction, memberIds, mode }); setDraft(result.draft); })}>{busy ? "Working…" : "Generate plan"}</Button>
          {draft && <div className="space-y-3 border-t border-line pt-3">
            <p className="text-xs text-mute">{draft.plan.planningLabel}</p>
            <p className="text-sm">{draft.plan.rationale}</p>
            {draft.plan.tasks.map((t) => <div key={t.key} className="space-y-2 rounded-lg bg-raised p-3">
              <p className="text-sm font-medium">{t.isFinalConsolidation ? "Final (after bounded review)" : t.key}</p>
              <input aria-label={`Title ${t.key}`} className={inputClass} value={t.title} maxLength={300} onChange={(e) => editTask(t.key, { title: e.target.value })} disabled={busy} />
              <textarea aria-label={`Instructions ${t.key}`} className={`${inputClass} min-h-20`} value={t.instructions} maxLength={8000} onChange={(e) => editTask(t.key, { instructions: e.target.value })} disabled={busy} />
              <select aria-label={`Agent ${t.key}`} className={inputClass} value={t.agentId} onChange={(e) => editTask(t.key, { agentId: e.target.value })} disabled={busy}>{members.filter((b) => draft.memberIds.includes(b.id)).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
              {!t.isFinalConsolidation && <div className="flex flex-wrap gap-2 text-xs text-mute">Dependencies: {draft.plan.tasks.filter((d) => d.key !== t.key && !d.isFinalConsolidation).map((d) => <label key={d.key}><input type="checkbox" checked={t.dependsOn.includes(d.key)} disabled={busy} onChange={(e) => editTask(t.key, { dependsOn: e.target.checked ? [...t.dependsOn, d.key] : t.dependsOn.filter((k) => k !== d.key) })} /> {d.key}</label>)}</div>}
              <p className="text-xs text-mute">{t.rationale}</p>
            </div>)}
            <Button variant="primary" disabled={busy || (revising && !revisionToken)} onClick={() => void perform(async () => { const result = revising && session && revisionToken ? await api.collaborationAction(room.id, session.id, { action: "continue", draft, revisionToken }) : await api.createCollaboration(room.id, draft); update(result.session); setDraft(null); setRevising(false); setRevisionToken(null); })}>Save approved plan (does not start)</Button>
            {revising && <Button variant="ghost" disabled={busy} onClick={() => void perform(async () => { if (session && revisionToken) update((await api.collaborationAction(room.id, session.id, { action: "discard-revision", revisionToken })).session); setRevising(false); setDraft(null); setRevisionToken(null); })}>Discard revision</Button>}
          </div>}
        </div>}
        {session && latest && <>
          <div className="space-y-3 rounded-xl border border-line p-4">
            <div className="flex flex-wrap items-center gap-2"><span className="rounded bg-raised px-2 py-1 text-xs font-medium">{session.mode.toUpperCase()}{session.mode === "mock" ? " · SIMULATED" : " · configured live"}</span><span className="text-sm font-medium">{session.status.replaceAll("_", " ")}</span><span className="text-xs text-mute">Stage {session.rounds.length}/8 · {latest.phase}</span></div>
            <p className="whitespace-pre-wrap text-sm">{latest.instruction}</p>
            <p className="text-xs text-mute">{session.memberIds.map(name).join(" · ")}</p>
            <div className="flex flex-wrap gap-2">
              {!session.autoAdvance && !session.revisionToken && ["pending", "awaiting_next"].includes(session.status) && <Button variant="primary" disabled={busy} onClick={() => void perform(async () => update((await api.collaborationAction(room.id, session.id, { action: "start-auto" })).session))}>Run automatically</Button>}
              {session.autoAdvance && !terminal && <Button disabled={busy} onClick={() => void perform(async () => update((await api.collaborationAction(room.id, session.id, { action: "pause-auto" })).session))}>Pause automatic progression</Button>}
              {session.status === "pending" && !session.autoAdvance && !session.revisionToken && <Button variant="primary" disabled={busy} onClick={() => void perform(async () => update((await api.collaborationAction(room.id, session.id, { action: "start" })).session))}>Start stage</Button>}
              {session.status === "awaiting_next" && !session.autoAdvance && !session.revisionToken && <Button variant="primary" disabled={busy} onClick={() => void perform(async () => update((await api.collaborationAction(room.id, session.id, { action: "advance" })).session))}>Prepare next stage</Button>}
              {["pending", "running", "blocked"].includes(session.status) && <Button disabled={busy} onClick={() => void perform(async () => update((await api.collaborationAction(room.id, session.id, { action: "interrupt" })).session))}>Interrupt</Button>}
              {session.status === "interrupted" && !session.revisionToken && <Button disabled={busy} onClick={() => void perform(async () => update((await api.collaborationAction(room.id, session.id, { action: "resume" })).session))}>Resume unstarted tasks</Button>}
              {canRevise && <Button disabled={busy || revising} onClick={() => { const open = (updated: CollaborationSession) => { update(updated); setRevisionToken(updated.revisionToken); setRevising(true); setDraft(null); setInstruction(""); setMode(updated.mode); setMemberIds(updated.memberIds); }; if (session.revisionToken) open(session); else void perform(async () => open((await api.collaborationAction(room.id, session.id, { action: "begin-revision" })).session)); }}>{session.revisionToken ? "Continue revision" : "Revise instruction"}</Button>}
              {!terminal && <Button variant="danger" disabled={busy} onClick={() => { if (window.confirm("Cancel collaboration? Completed work stays in history.")) void perform(async () => update((await api.collaborationAction(room.id, session.id, { action: "cancel" })).session)); }}>Cancel session</Button>}
            </div>
            {session.autoAdvance && !terminal && <p className="text-xs text-mute">Automatic progression enabled. The server prepares and starts subsequent stages (up to 30 seconds between stages). Requests still require explicit approval. Pause stops future stages; Interrupt stops current work.</p>}
            {session.autoError && <p role="alert" className="text-xs text-danger">{session.autoError}</p>}
            {session.revisionToken && <p className="text-xs text-mute">Instruction revision is reserved on the server. Automatic progression is suspended until this approved plan is saved or discarded.</p>}
            {session.status === "awaiting_next" && !session.autoAdvance && !session.revisionToken && <p className="text-xs text-mute">Paused at a safe stage boundary. Prepare and explicitly start the next stage when ready.</p>}
            {session.status === "interrupted" && <p className="text-xs text-mute">Active execution was cancelled. Only never-started tasks with safe prerequisites can be resumed; otherwise revise the instruction.</p>}
          </div>
          <div className="space-y-3 rounded-xl border border-line p-4">
            <h3 className="font-medium">Execution stages</h3>
            {session.rounds.map(({ phase, run }, i) => <div key={run.id} className="space-y-2 rounded-lg bg-raised p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">{i + 1}. {phase} · {run.status}</span><Button size="sm" variant="ghost" onClick={() => openExecutions(run.id)}>Open run</Button></div>
              {(run.tasks ?? []).map((t) => <div key={t.id} className="space-y-1 border-t border-line pt-2"><p className="text-sm">{t.title} — {name(t.agentId)} <span className="text-xs text-mute">· {t.status} · {t.attempts}/{t.maxAttempts} attempts</span></p>
                {t.error && <p className="text-xs text-danger">{t.error}</p>}
                {t.status === "blocked" && t.requiresApproval && run.id === latest.run.id && session.status !== "pending" && !terminal && <div className="space-y-2"><pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words text-xs">{display((t.input as { collaboration?: { request?: unknown } })?.collaboration?.request ?? t.input)}</pre><div className="flex gap-2"><Button size="sm" variant="primary" disabled={busy} onClick={() => void perform(async () => { await api.approveExecutionTask(run.id, t.id); update((await api.collaborationSession(room.id, session.id)).session); })}>Approve request</Button><Button size="sm" variant="danger" disabled={busy} onClick={() => void perform(async () => { await api.rejectExecutionTask(run.id, t.id); update((await api.collaborationSession(room.id, session.id)).session); })}>Reject</Button></div></div>}
              </div>)}
            </div>)}
          </div>
          <div className="space-y-3 rounded-xl border border-line p-4"><h3 className="font-medium">Collaboration timeline</h3>{session.messages.map((m) => <div key={m.id} className="border-b border-line pb-3"><p className="text-xs text-mute">{m.type.replaceAll("_", " ")} · {name(m.senderId)}{m.recipientId ? ` → ${name(m.recipientId)}` : ""} · {new Date(m.createdAt).toLocaleString()} {m.simulated ? "· MOCK" : ""}</p><p className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-sm">{m.content}</p></div>)}</div>
          {session.finalDeliverable !== null && <div className="rounded-xl border border-line p-4"><h3 className="font-medium">Final deliverable {session.mode === "mock" ? "(simulated)" : ""}</h3><pre className="whitespace-pre-wrap break-words text-sm">{display(session.finalDeliverable)}</pre></div>}
        </>}
      </div>
    </section>
  );
}
