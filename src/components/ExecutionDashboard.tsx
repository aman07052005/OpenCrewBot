"use client";

import clsx from "clsx";
import { Activity, ArrowLeft, Check, Clock3, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/client/api";
import { executionOutputKind, executionProgress } from "@/lib/client/execution-dashboard";
import type { Bot, ChiefOfStaffPlan, ChiefOfStaffTask, CreateChiefOfStaffRunInput, CreateExecutionRunInput, ExecutionMode, ExecutionRun, ExecutionRunStatus, ExecutionTask, ExecutionTaskInput } from "@/lib/shared/types";
import { useApp } from "./OpenCrewBotApp";
import { Button, Drawer, Field, inputClass, Segmented, Toggle } from "./ui";

const PAGE_SIZE = 100;
const POLL_MS = 2_000;

function time(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function statusClass(status: ExecutionRunStatus | ExecutionTask["status"]) {
  if (status === "completed" || status === "succeeded") return "bg-ok/15 text-ok";
  if (status === "failed" || status === "cancelled" || status === "skipped") return "bg-danger-soft text-danger";
  if (status === "blocked") return "bg-warn/15 text-warn";
  if (status === "running") return "bg-accent-soft text-[#8db4ff]";
  return "bg-raised-2 text-mute";
}

function StatusPill({ status }: { status: ExecutionRunStatus | ExecutionTask["status"] }) {
  return <span className={clsx("inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide", statusClass(status))}>{status}</span>;
}

function ModePill({ mode }: { mode: ExecutionMode }) {
  return mode === "mock" ? (
    <span className="inline-flex rounded-full bg-warn/15 px-2.5 py-1 text-[11px] font-bold tracking-wide text-warn">MOCK · SIMULATED</span>
  ) : (
    <span className="inline-flex rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-bold tracking-wide text-[#8db4ff]">LIVE MODEL</span>
  );
}

function OutputView({ mode, output }: { mode: ExecutionMode; output: unknown }) {
  const kind = executionOutputKind(mode, output);
  const label = kind === "simulated" ? "SIMULATED OUTPUT" : kind === "live" ? "REAL MODEL OUTPUT" : "OUTPUT TYPE UNKNOWN";
  return (
    <div className="mt-3 overflow-hidden rounded-xl bg-[#151515] ring-1 ring-line">
      <div className={clsx("px-3 py-2 text-[10px] font-bold tracking-[0.12em]", kind === "simulated" ? "text-warn" : kind === "live" ? "text-[#8db4ff]" : "text-mute")}>{label}</div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-line px-3 py-3 text-[12px] leading-relaxed text-mute">{JSON.stringify(output, null, 2) ?? String(output)}</pre>
    </div>
  );
}

function RunRow({ run, selected, onSelect }: { run: ExecutionRun; selected: boolean; onSelect: () => void }) {
  const progress = executionProgress(run);
  return (
    <button onClick={onSelect} aria-current={selected ? "true" : undefined} className={clsx("w-full rounded-2xl p-3.5 text-left ring-1 transition-colors", selected ? "bg-active ring-line-strong" : "bg-raised ring-line hover:bg-hover")}>
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-[14px] font-medium text-ink">{run.name}</span>
        <StatusPill status={run.status} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <ModePill mode={run.executionMode} />
        <span className="text-[11px] text-faint">{time(run.createdAt)}</span>
      </div>
      <div className="mt-3 flex items-center justify-between text-[11px] text-mute">
        <span>{progress.finished} / {progress.total} tasks finished</span>
        <span>{progress.succeeded} succeeded</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[#333]" aria-label={`${progress.percent}% complete`}>
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${progress.percent}%` }} />
      </div>
    </button>
  );
}

export function ExecutionDashboard({ initialRunId = null }: { initialRunId?: string | null } = {}) {
  const { state, open, toast } = useApp();
  const [runs, setRuns] = useState<ExecutionRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialRunId);
  const [detail, setDetail] = useState<ExecutionRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showChiefOfStaff, setShowChiefOfStaff] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const listInFlight = useRef(false);
  const detailRequest = useRef(0);
  const firstPageLoaded = useRef(false);

  const loadList = useCallback(async () => {
    if (listInFlight.current) return;
    listInFlight.current = true;
    try {
      const result = await api.executionRuns(PAGE_SIZE, 0);
      setRuns((current) => {
        const currentIds = new Set(current.map((run) => run.id));
        const incoming = new Map(result.runs.map((run) => [run.id, run]));
        const newRuns = result.runs.filter((run) => !currentIds.has(run.id));
        return [...newRuns, ...current.map((run) => incoming.get(run.id) ?? run)];
      });
      if (!firstPageLoaded.current) {
        setHasMore(result.runs.length === PAGE_SIZE);
        firstPageLoaded.current = true;
      }
      setListError(null);
      setSelectedId((current) => current ?? result.runs[0]?.id ?? null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Couldn't load executions.");
    } finally {
      listInFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load data after mounting; updates happen after the API promise resolves.
    void loadList();
    const timer = window.setInterval(() => void loadList(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadList, refreshVersion]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    let inFlight = false;
    const requestId = ++detailRequest.current;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await api.executionRun(selectedId);
        if (active && detailRequest.current === requestId) {
          setDetail(result.run);
          setDetailError(null);
        }
      } catch (error) {
        if (active && detailRequest.current === requestId) setDetailError(error instanceof Error ? error.message : "Couldn't load this execution.");
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [selectedId, refreshVersion]);

  const selectedRun = detail?.id === selectedId ? detail : null;
  const selectedSummary = runs.find((run) => run.id === selectedId);

  const perform = async (label: string, action: () => Promise<unknown>) => {
    setWorking(true);
    setActionError(null);
    try {
      await action();
      setRefreshVersion((version) => version + 1);
      toast(label);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The execution request failed.");
    } finally {
      setWorking(false);
    }
  };

  const createRun = async (input: CreateExecutionRunInput) => {
    const result = await api.createExecutionRun(input);
    setRuns((current) => [result.run, ...current.filter((run) => run.id !== result.run.id)]);
    setSelectedId(result.run.id);
    setDetailError(null);
    setShowCreate(false);
    setRefreshVersion((version) => version + 1);
    toast("Execution run created.");
  };

  const createChiefOfStaffRun = async (input: CreateChiefOfStaffRunInput) => {
    const result = await api.createChiefOfStaffRun(input);
    setRuns((current) => [result.run, ...current.filter((run) => run.id !== result.run.id)]);
    setSelectedId(result.run.id);
    setDetailError(null);
    setShowChiefOfStaff(false);
    setRefreshVersion((version) => version + 1);
    toast("Chief of Staff execution run created.");
  };

  const loadOlder = async () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    try {
      const cursor = runs.at(-1);
      const result = await api.executionRuns(PAGE_SIZE, 0, cursor ? { createdAt: cursor.createdAt, id: cursor.id } : undefined);
      setRuns((current) => [...current, ...result.runs.filter((run) => !current.some((known) => known.id === run.id))]);
      setHasMore(result.runs.length === PAGE_SIZE);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Couldn't load older executions.");
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <header className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-line px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <button onClick={() => open(state.active)} className="inline-flex h-9 items-center gap-1 rounded-full px-2 text-[13px] text-mute hover:bg-hover hover:text-ink md:hidden">
            <ArrowLeft size={16} /> Conversations
          </button>
          <div className="hidden h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-[#8db4ff] md:flex"><Activity size={18} /></div>
          <div className="min-w-0">
            <h1 className="truncate text-[16px] font-semibold">Executions</h1>
            <p className="hidden text-[11px] text-mute sm:block">Persistent task runs and results</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setRefreshVersion((version) => version + 1)} title="Refresh executions"><RefreshCw size={14} /> Refresh</Button>
          <Button variant="ghost" size="sm" onClick={() => setShowChiefOfStaff(true)}><Sparkles size={14} /> Plan with Chief of Staff</Button>
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}><Plus size={15} /> New run</Button>
        </div>
      </header>

      {(listError || actionError) && <p role="alert" className="mx-4 mt-3 rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger md:mx-6">{actionError ?? listError}</p>}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside aria-label="Execution history" className="flex max-h-[42%] w-full shrink-0 flex-col border-b border-line md:max-h-none md:w-[340px] md:border-r md:border-b-0">
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="text-[12px] font-semibold tracking-wide text-mute uppercase">Run history</h2>
            <span className="text-[11px] text-faint">{runs.length}{hasMore ? "+" : ""} runs</span>
          </div>
          {loading && runs.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-mute">Loading saved runs…</p>
          ) : runs.length === 0 ? (
            <div className="px-5 py-9 text-center">
              <Clock3 size={24} className="mx-auto text-faint" />
              <p className="mt-3 text-[14px] font-medium">No execution history yet</p>
              <p className="mt-1 text-[12px] text-mute">Create a run to see its progress and saved results here.</p>
            </div>
          ) : (
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
              {runs.map((run) => <RunRow key={run.id} run={run} selected={run.id === selectedId} onSelect={() => { setDetailError(null); setSelectedId(run.id); }} />)}
              {hasMore && <Button className="w-full" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? "Loading…" : "Load older history"}</Button>}
            </div>
          )}
        </aside>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {!selectedId ? (
            <div className="flex h-full min-h-56 items-center justify-center px-6 text-center text-[13px] text-mute">Choose a run or create one to inspect task details.</div>
          ) : detailError && !selectedRun ? (
            <div role="alert" className="m-6 rounded-2xl bg-danger-soft p-5 text-[13px] text-danger">{detailError}</div>
          ) : !selectedRun ? (
            <div className="flex h-full min-h-56 items-center justify-center text-[13px] text-mute">Loading run details…</div>
          ) : (
            <RunDetail
              run={selectedRun}
              summary={selectedSummary}
              bots={state.bots}
              working={working}
              onStart={() => void perform("Execution started.", () => api.startExecutionRun(selectedRun.id))}
              onCancel={() => void perform("Execution cancelled.", () => api.cancelExecutionRun(selectedRun.id))}
              onApprove={(task) => void perform("Task approved.", () => api.approveExecutionTask(selectedRun.id, task.id))}
              onReject={(task) => void perform("Task approval rejected.", () => api.rejectExecutionTask(selectedRun.id, task.id))}
            />
          )}
        </div>
      </div>

      {showCreate && <CreateRunDrawer bots={state.bots} onClose={() => setShowCreate(false)} onCreate={createRun} />}
      {showChiefOfStaff && <ChiefOfStaffDrawer bots={state.bots} onClose={() => setShowChiefOfStaff(false)} onCreate={createChiefOfStaffRun} />}
    </section>
  );
}

function RunDetail({
  run,
  summary,
  bots,
  working,
  onStart,
  onCancel,
  onApprove,
  onReject,
}: {
  run: ExecutionRun;
  summary?: ExecutionRun;
  bots: Bot[];
  working: boolean;
  onStart: () => void;
  onCancel: () => void;
  onApprove: (task: ExecutionTask) => void;
  onReject: (task: ExecutionTask) => void;
}) {
  const tasks = useMemo(() => run.tasks ?? [], [run.tasks]);
  const progress = executionProgress(summary?.taskCounts ? { ...run, taskCount: summary.taskCount, taskCounts: summary.taskCounts } : run);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const canStart = run.status === "pending" || run.status === "blocked";
  const canCancel = canStart || run.status === "running";

  return (
    <div className="mx-auto w-full max-w-5xl p-4 pb-10 md:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h2 className="break-words text-[20px] font-semibold">{run.name}</h2><StatusPill status={run.status} /></div>
          <p className="mt-1 break-all font-mono text-[10px] text-faint">Run ID · {run.id}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2"><ModePill mode={run.executionMode} /><span className="text-[11px] text-mute">Created {time(run.createdAt)}</span></div>
        </div>
        <div className="flex shrink-0 gap-2">
          {canStart && <Button variant="primary" onClick={onStart} disabled={working}><Activity size={15} /> Start</Button>}
          {canCancel && <Button variant="danger" onClick={onCancel} disabled={working}><X size={15} /> Cancel</Button>}
        </div>
      </div>

      <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Progress" value={`${progress.finished} / ${progress.total} finished`} />
        <Metric label="Concurrency" value={`${run.concurrencyLimit} at a time`} />
        <Metric label="Started" value={time(run.startedAt)} />
        <Metric label="Finished" value={time(run.finishedAt)} />
      </div>
      {run.originalInstruction && <JsonSection title="Original business instruction" value={run.originalInstruction} />}
      {run.planningRationale && <JsonSection title={`Chief of Staff planning rationale · ${run.planningMode ?? "unknown"} mode`} value={run.planningRationale} />}
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#333]"><div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${progress.percent}%` }} /></div>

      {run.status === "running" && <p className="mt-4 rounded-xl bg-accent-soft px-3.5 py-3 text-[12px] leading-relaxed text-[#a9caff]">This run is marked running. If the server has restarted, recovery will resolve interrupted tasks and this view will update automatically.</p>}
      {run.error && <p className="mt-4 rounded-xl bg-danger-soft px-3.5 py-3 text-[12px] leading-relaxed text-danger">Run error: {run.error}</p>}
      {tasks.some((task) => task.requiresApproval) && (
        <p className="mt-4 rounded-xl bg-warn/10 px-3.5 py-3 text-[12px] leading-relaxed text-warn">
          Task approval only allows that task to enter the execution queue. It does not authorize any external tool action; execution tasks do not receive side-effectful tools.
        </p>
      )}

      <div className="mt-7 flex items-center justify-between gap-3">
        <h3 className="text-[14px] font-semibold">Tasks <span className="ml-1 text-mute">{tasks.length}</span></h3>
        <span className="text-[11px] text-faint">{progress.succeeded} succeeded · {progress.counts.failed} failed · {progress.counts.blocked} awaiting approval</span>
      </div>
      <div className="mt-3 space-y-3">
        {tasks.map((task) => (
          <article key={task.id} className="rounded-2xl bg-raised p-4 ring-1 ring-line md:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h4 className="break-words text-[15px] font-medium">{task.title}</h4>
                <p className="mt-1 break-all font-mono text-[10px] text-faint">Task ID · {task.id}</p>
              </div>
              <StatusPill status={task.status} />
            </div>
            <div className="mt-3 grid gap-x-4 gap-y-2 text-[12px] sm:grid-cols-2">
              <Info label="Assigned agent" value={bots.find((bot) => bot.id === task.agentId)?.name ?? task.agentId} />
              <Info label="Dependencies" value={task.dependencies.length ? task.dependencies.map((id) => taskById.get(id)?.title ?? id).join(", ") : "None"} />
              <Info label="Started" value={time(task.startedAt)} />
              <Info label="Completed" value={time(task.finishedAt)} />
              <Info label="Attempts" value={`${task.attempts} / ${task.maxAttempts}`} />
              <Info label="Timeout" value={`${Math.ceil(task.timeoutMs / 1000)} seconds`} />
            </div>
            <div className="mt-3 rounded-xl bg-[#1a1a1a] px-3 py-2.5">
              <p className="text-[10px] font-semibold tracking-wide text-faint uppercase">Approval</p>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[12px] text-mute">{task.requiresApproval ? task.approvedAt ? `Task approval recorded ${time(task.approvedAt)}` : "Task approval required" : "No task approval required"}</p>
                {task.status === "blocked" && task.requiresApproval && !task.approvedAt && (
                  <span className="flex gap-1.5">
                    <Button size="sm" variant="primary" disabled={working} onClick={() => onApprove(task)}><Check size={13} /> Approve task</Button>
                    <Button size="sm" variant="danger" disabled={working} onClick={() => onReject(task)}><X size={13} /> Reject task</Button>
                  </span>
                )}
              </div>
              {task.requiresApproval && <p className="mt-1 text-[10px] leading-relaxed text-faint">This decision applies only to this task. External tool approvals are separate.</p>}
            </div>
            {task.input !== null && task.input !== undefined && task.input !== "" && <JsonSection title="Task instructions / input" value={task.input} />}
            {task.output !== null && task.output !== undefined && <OutputView mode={run.executionMode} output={task.output} />}
            {task.error && <p className="mt-3 rounded-xl bg-danger-soft px-3 py-2.5 text-[12px] leading-relaxed text-danger">{task.error}</p>}
            {task.status === "running" && <p className="mt-3 text-[11px] leading-relaxed text-mute">If the server restarted during this task, its persisted status may show the recovery window until the next poll.</p>}
          </article>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-raised px-3.5 py-3 ring-1 ring-line"><p className="text-[10px] font-semibold tracking-wide text-faint uppercase">{label}</p><p className="mt-1 truncate text-[12px] text-ink">{value}</p></div>;
}

function Info({ label, value }: { label: string; value: string }) {
  return <p className="min-w-0"><span className="text-mute">{label}: </span><span className="break-words text-ink">{value}</span></p>;
}

function JsonSection({ title, value }: { title: string; value: unknown }) {
  return <details className="mt-3 rounded-xl bg-[#151515] ring-1 ring-line"><summary className="cursor-pointer px-3 py-2.5 text-[11px] font-semibold text-mute">{title}</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words border-t border-line px-3 py-3 text-[11px] leading-relaxed text-faint">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre></details>;
}

interface DraftTask extends ExecutionTaskInput {
  input: string;
  dependsOn: string[];
}

function newTaskKey() {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function CreateRunDrawer({ bots, onClose, onCreate }: { bots: Bot[]; onClose: () => void; onCreate: (input: CreateExecutionRunInput) => Promise<void> }) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<ExecutionMode>("mock");
  const [concurrency, setConcurrency] = useState("3");
  const [tasks, setTasks] = useState<DraftTask[]>(() => [{ key: newTaskKey(), title: "", agentId: "", input: "", dependsOn: [], requiresApproval: false }]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const updateTask = (index: number, patch: Partial<DraftTask>) => setTasks((current) => current.map((task, i) => i === index ? { ...task, ...patch } : task));
  const addTask = () => setTasks((current) => [...current, { key: newTaskKey(), title: "", agentId: bots[0]?.id ?? "", input: "", dependsOn: [], requiresApproval: false }]);
  const removeTask = (index: number) => setTasks((current) => {
    const removedKey = current[index]?.key;
    return current.filter((_, i) => i !== index).map((task) => ({ ...task, dependsOn: task.dependsOn.filter((key) => key !== removedKey) }));
  });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const concurrencyLimit = Number(concurrency);
    if (!name.trim()) return setError("Give this run a name.");
    if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 32) return setError("Concurrency must be between 1 and 32.");
    if (!bots.length) return setError("Create an agent before assigning execution tasks.");
    const invalid = tasks.findIndex((task) => !task.title.trim() || !task.input.trim() || !task.agentId);
    if (invalid >= 0) return setError(`Complete the title, assigned agent, and task instructions for task ${invalid + 1}.`);
    const input: CreateExecutionRunInput = {
      name: name.trim(), executionMode: mode, concurrencyLimit,
      tasks: tasks.map(({ key, title, agentId, input: instructions, dependsOn, requiresApproval }) => ({ key, title: title.trim(), agentId, input: instructions.trim(), dependsOn, requiresApproval })),
    };
    setSaving(true);
    try {
      await onCreate(input);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Couldn't create the execution run.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      title="Create execution run"
      onClose={onClose}
      footer={<><Button onClick={onClose} disabled={saving}>Close</Button><Button form="execution-create-form" type="submit" variant="primary" disabled={saving || !bots.length}>{saving ? "Creating…" : "Create run"}</Button></>}
    >
      <form id="execution-create-form" onSubmit={(event) => void submit(event)} className="space-y-5">
        <Field label="Run name"><input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} maxLength={300} placeholder="A short name for this work" required /></Field>
        <Segmented value={mode} onChange={setMode} options={[
          { value: "mock", label: "MOCK · SIMULATED", hint: "Deterministic local output; no model call." },
          { value: "live", label: "LIVE MODEL", hint: "Uses the assigned bot's configured model." },
        ]} />
        {mode === "live" && <p className="rounded-xl bg-warn/10 px-3 py-2.5 text-[11px] leading-relaxed text-warn">Starting a live run may call a paid model. No external tools are enabled for execution tasks.</p>}
        <Field label="Maximum concurrent tasks" hint="Between 1 and 32 tasks can run at once."><input className={inputClass} type="number" min={1} max={32} value={concurrency} onChange={(event) => setConcurrency(event.target.value)} /></Field>
        <div className="space-y-3">
          <div className="flex items-center justify-between"><h3 className="text-[13px] font-semibold">Tasks</h3><Button size="sm" onClick={addTask}><Plus size={13} /> Add task</Button></div>
          {tasks.map((task, index) => (
            <fieldset key={task.key} className="space-y-3 rounded-2xl bg-raised p-3.5 ring-1 ring-line">
              <div className="flex items-center justify-between"><legend className="text-[12px] font-semibold">Task {index + 1}</legend>{tasks.length > 1 && <button type="button" onClick={() => removeTask(index)} className="text-[11px] text-danger hover:underline">Remove</button>}</div>
              <Field label="Task title"><input className={inputClass} value={task.title} onChange={(event) => updateTask(index, { title: event.target.value })} maxLength={300} placeholder="What should this agent do?" /></Field>
              <Field label="Assigned agent"><select className={inputClass} value={task.agentId} onChange={(event) => updateTask(index, { agentId: event.target.value })}><option value="">Choose an existing agent</option>{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name} · {bot.title || bot.model}</option>)}</select></Field>
              <Field label="Task instructions"><textarea className={clsx(inputClass, "min-h-24 resize-y")} value={task.input} onChange={(event) => updateTask(index, { input: event.target.value })} placeholder="Give the assigned agent its instructions." /></Field>
              {index > 0 && <div><p className="mb-1.5 text-[12px] font-medium text-mute">Depends on earlier tasks</p><div className="space-y-1">{tasks.slice(0, index).map((candidate) => <label key={candidate.key} className="flex items-center gap-2 text-[12px] text-mute"><input type="checkbox" checked={task.dependsOn.includes(candidate.key)} onChange={(event) => updateTask(index, { dependsOn: event.target.checked ? [...task.dependsOn, candidate.key] : task.dependsOn.filter((key) => key !== candidate.key) })} />{candidate.title.trim() || `Task ${tasks.indexOf(candidate) + 1}`}</label>)}</div></div>}
              <Toggle checked={Boolean(task.requiresApproval)} onChange={(value) => updateTask(index, { requiresApproval: value })} label="Require task approval" hint="The task stays blocked until a person approves it in the run details." />
            </fieldset>
          ))}
        </div>
        {error && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2.5 text-[12px] text-danger">{error}</p>}
      </form>
    </Drawer>
  );
}

function ChiefOfStaffDrawer({ bots, onClose, onCreate }: { bots: Bot[]; onClose: () => void; onCreate: (input: CreateChiefOfStaffRunInput) => Promise<void> }) {
  const [instruction, setInstruction] = useState("");
  const [name, setName] = useState("");
  const [planningMode, setPlanningMode] = useState<ExecutionMode>("mock");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("mock");
  const [concurrency, setConcurrency] = useState("3");
  const [plan, setPlan] = useState<ChiefOfStaffPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateTask = (key: string, patch: Partial<ChiefOfStaffTask>) => {
    setPlan((current) => current ? {
      ...current,
      tasks: current.tasks.map((task) => task.key === key ? { ...task, ...patch } : task),
    } : current);
  };

  const toggleDependency = (task: ChiefOfStaffTask, dependencyKey: string, checked: boolean) => {
    if (task.isFinalConsolidation) return;
    updateTask(task.key, {
      dependsOn: checked
        ? [...task.dependsOn, dependencyKey]
        : task.dependsOn.filter((key) => key !== dependencyKey),
    });
  };

  const addTask = () => {
    setPlan((current) => {
      if (!current || current.tasks.length >= 20) return current;
      const finalTask = current.tasks.at(-1)!;
      const task: ChiefOfStaffTask = {
        key: newTaskKey(),
        title: "",
        instructions: "",
        agentId: bots[0]?.id ?? "",
        dependsOn: [],
        rationale: "Added during plan review.",
        isFinalConsolidation: false,
      };
      return { ...current, tasks: [...current.tasks.slice(0, -1), task, { ...finalTask, dependsOn: [...current.tasks.slice(0, -1).map((item) => item.key), task.key] }] };
    });
  };

  const removeTask = (task: ChiefOfStaffTask) => {
    if (task.isFinalConsolidation) return;
    setPlan((current) => {
      if (!current || current.tasks.filter((item) => !item.isFinalConsolidation).length <= 1) return current;
      const remaining = current.tasks.filter((item) => item.key !== task.key && !item.isFinalConsolidation);
      const finalTask = current.tasks.at(-1)!;
      const safeTasks = remaining.map((item) => ({ ...item, dependsOn: item.dependsOn.filter((key) => key !== task.key) }));
      return { ...current, tasks: [...safeTasks, { ...finalTask, dependsOn: safeTasks.map((item) => item.key) }] };
    });
  };

  const generatePlan = async () => {
    setError(null);
    if (!instruction.trim()) return setError("Enter the business instruction you want the agents to complete.");
    if (!bots.length) return setError("Create an agent before asking the Chief of Staff to plan work.");
    setPlanning(true);
    setPlan(null);
    try {
      const result = await api.planChiefOfStaff({ instruction: instruction.trim(), planningMode });
      setPlan(result.plan);
      if (!name.trim()) setName(instruction.trim().replace(/\s+/g, " ").slice(0, 80));
    } catch (planError) {
      setError(planError instanceof Error ? planError.message : "Chief of Staff planning failed.");
    } finally {
      setPlanning(false);
    }
  };

  const createRun = async () => {
    setError(null);
    if (!plan) return setError("Generate a plan before creating an execution run.");
    if (plan.planningMode !== planningMode) return setError("Generate a new plan after changing the planning mode.");
    if (!instruction.trim()) return setError("The original business instruction is required.");
    if (!plan.tasks.every((task) => task.title.trim() && task.instructions.trim() && task.agentId)) return setError("Complete each task title, instruction, and agent assignment.");
    const concurrencyLimit = Number(concurrency);
    if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 32) return setError("Concurrency must be between 1 and 32.");
    setSaving(true);
    try {
      await onCreate({
        name: name.trim() || instruction.trim().replace(/\s+/g, " ").slice(0, 80),
        concurrencyLimit,
        executionMode,
        originalInstruction: instruction.trim(),
        planningMode,
        plan,
      });
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Couldn't create the Chief of Staff run.");
    } finally {
      setSaving(false);
    }
  };

  const workTasks = plan?.tasks.filter((task) => !task.isFinalConsolidation) ?? [];

  return (
    <Drawer
      title="Plan with Chief of Staff"
      onClose={onClose}
      footer={<>
        <Button onClick={onClose} disabled={planning || saving}>Close</Button>
        {plan && <Button variant="primary" onClick={() => void createRun()} disabled={planning || saving}>{saving ? "Creating…" : "Create execution run"}</Button>}
      </>}
    >
      <div className="space-y-5">
        <Field label="Business instruction" hint="Describe the outcome, audience, constraints, and desired format. The original text is saved with the run.">
          <textarea className={clsx(inputClass, "min-h-32 resize-y")} value={instruction} onChange={(event) => { setInstruction(event.target.value); setPlan(null); }} maxLength={12_000} placeholder="What should your team of agents accomplish?" />
        </Field>
        <div className="space-y-2">
          <p className="text-[12px] font-medium text-mute">Planning mode</p>
          <Segmented value={planningMode} onChange={(mode) => { setPlanningMode(mode); setPlan(null); }} options={[
            { value: "mock", label: "MOCK · DETERMINISTIC", hint: "Development planner; no model call." },
            { value: "live", label: "LIVE MODEL", hint: "Uses the configured planner model." },
          ]} />
          {planningMode === "live" && <p className="rounded-xl bg-warn/10 px-3 py-2.5 text-[11px] leading-relaxed text-warn">Live planning calls the configured model and may incur a charge. It requires NEBIUS_API_KEY. If the call fails, no mock plan is substituted.</p>}
        </div>
        <Button variant="primary" onClick={() => void generatePlan()} disabled={planning || saving || !bots.length}><Sparkles size={14} /> {planning ? "Planning…" : plan ? "Generate plan again" : "Generate plan"}</Button>

        {plan && <>
          <div className="rounded-xl bg-warn/10 px-3 py-2.5 text-[11px] font-semibold leading-relaxed text-warn">{plan.planningLabel}</div>
          <div className="rounded-xl bg-raised p-3.5 ring-1 ring-line">
            <p className="text-[11px] font-semibold tracking-wide text-mute uppercase">Planning rationale</p>
            <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-ink">{plan.rationale}</p>
          </div>
          <Field label="Execution run name"><input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} maxLength={300} placeholder="Name this execution run" /></Field>
          <div className="space-y-2">
            <p className="text-[12px] font-medium text-mute">Task execution mode</p>
            <Segmented value={executionMode} onChange={setExecutionMode} options={[
              { value: "mock", label: "MOCK · SIMULATED", hint: "Deterministic outputs; no task model call." },
              { value: "live", label: "LIVE MODEL", hint: "Uses each assigned agent's configured model." },
            ]} />
            {executionMode === "live" && <p className="rounded-xl bg-warn/10 px-3 py-2.5 text-[11px] leading-relaxed text-warn">Starting this run uses the configured model for each assigned agent. Execution tasks only receive the existing read-only tool allowlist; this plan does not grant tools or approvals.</p>}
          </div>
          <Field label="Maximum concurrent tasks"><input className={inputClass} type="number" min={1} max={32} value={concurrency} onChange={(event) => setConcurrency(event.target.value)} /></Field>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[13px] font-semibold">Plan preview <span className="ml-1 text-mute">{plan.tasks.length} tasks</span></h3>
              <Button size="sm" onClick={addTask} disabled={plan.tasks.length >= 20}><Plus size={13} /> Add task</Button>
            </div>
            {plan.tasks.map((task, index) => (
              <fieldset key={task.key} className="space-y-3 rounded-2xl bg-raised p-3.5 ring-1 ring-line">
                <div className="flex items-center justify-between gap-2">
                  <legend className="text-[12px] font-semibold">{task.isFinalConsolidation ? "Final consolidation" : `Task ${index + 1}`}</legend>
                  {!task.isFinalConsolidation && workTasks.length > 1 && <button type="button" onClick={() => removeTask(task)} className="text-[11px] text-danger hover:underline">Remove</button>}
                </div>
                <Field label="Task title"><input className={inputClass} value={task.title} onChange={(event) => updateTask(task.key, { title: event.target.value })} maxLength={300} /></Field>
                <Field label="Assigned agent"><select className={inputClass} value={task.agentId} onChange={(event) => updateTask(task.key, { agentId: event.target.value })}><option value="">Choose an existing agent</option>{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name} · {bot.title || bot.model}</option>)}</select></Field>
                <Field label="Task instructions"><textarea className={clsx(inputClass, "min-h-24 resize-y")} value={task.instructions} onChange={(event) => updateTask(task.key, { instructions: event.target.value })} maxLength={8_000} /></Field>
                <div>
                  <p className="mb-1.5 text-[12px] font-medium text-mute">Dependencies</p>
                  {task.isFinalConsolidation ? (
                    <div className="space-y-1 text-[11px] text-mute">{workTasks.map((candidate) => <p key={candidate.key}>• {candidate.title.trim() || "Untitled task"}</p>)}<p className="mt-2 text-faint">Final consolidation receives every work task output.</p></div>
                  ) : (
                    <div className="space-y-1">
                      {workTasks.filter((candidate) => candidate.key !== task.key).map((candidate) => <label key={candidate.key} className="flex items-center gap-2 text-[11px] text-mute"><input type="checkbox" checked={task.dependsOn.includes(candidate.key)} onChange={(event) => toggleDependency(task, candidate.key, event.target.checked)} />{candidate.title.trim() || "Untitled task"}</label>)}
                      {!workTasks.some((candidate) => candidate.key !== task.key) && <p className="text-[11px] text-faint">No other work tasks.</p>}
                    </div>
                  )}
                </div>
                <div className="rounded-xl bg-[#1a1a1a] px-3 py-2.5"><p className="text-[10px] font-semibold tracking-wide text-faint uppercase">Assignment rationale</p><p className="mt-1 text-[11px] leading-relaxed text-mute">{task.rationale}</p></div>
              </fieldset>
            ))}
          </div>
        </>}
        {error && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2.5 text-[12px] text-danger">{error}</p>}
      </div>
    </Drawer>
  );
}
