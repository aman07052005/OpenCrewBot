"use client";

import { Download, Play, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import { AGENT_SKILLS, type ExecutableSkillId } from "@/lib/shared/agent-skills";
import { Button, Field, inputClass } from "./ui";
import { useApp } from "./OpenCrewBotApp";

const executable = AGENT_SKILLS.filter((skill) => skill.implemented);
const examples: Record<ExecutableSkillId, unknown> = {
  "skill.market-research": { question: "What should we verify before entering this market?", industry: "software", geography: "India", evidence: [] },
  "skill.competitor-analysis": { competitors: [{ name: "Example competitor", strengths: ["Supplied evidence required"], weaknesses: [], evidence: [] }] },
  "skill.financial-modelling": { revenue: 1000, operatingCosts: 300, costOfGoodsSold: 200, taxRate: 0.2, fixedCosts: 500, pricePerUnit: 25, variableCostPerUnit: 10, projectionPeriods: 3, growthRate: 0.1 },
  "skill.presentation-creation": { title: "Proposal", audience: "Leadership", objective: "Decide the next step", slideCount: 6, recommendations: ["Validate evidence", "Assign owners"] },
  "skill.email-drafting": { recipientRole: "Prospective customer", objective: "Request a short discovery call", tone: "professional", callToAction: "Would you be available for a 20-minute call next week?" },
  "skill.code-review": { files: [{ path: "src/example.ts", content: "console.log('review me');" }] },
  "skill.data-analysis": { csv: "region,revenue\nNorth,120\nSouth,80\nWest,", groupBy: "region", valueColumn: "revenue" },
  "skill.lead-generation": { industry: "Software", geography: "India", criteria: "B2B organizations", organizations: [] },
};

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}

export function SkillsManager() {
  const { state, openExecutions, toast } = useApp();
  const [skillId, setSkillId] = useState<ExecutableSkillId>("skill.data-analysis");
  const [agentId, setAgentId] = useState("");
  const [raw, setRaw] = useState(() => JSON.stringify(examples["skill.data-analysis"], null, 2));
  const [result, setResult] = useState<unknown>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = useMemo(() => state.bots.filter((bot) => bot.agentConfig?.skillIds.includes(skillId)), [state.bots, skillId]);
  const selectSkill = (next: ExecutableSkillId) => { setSkillId(next); setAgentId(""); setResult(null); setError(null); setRaw(JSON.stringify(examples[next], null, 2)); };
  const loadCsv = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 1_000_000) { setError("CSV files are limited to 1 MB."); return; }
    const csv = await file.text();
    try { const parsed = JSON.parse(raw) as Record<string, unknown>; setRaw(JSON.stringify({ ...parsed, csv }, null, 2)); setError(null); } catch { setError("Fix the JSON input before adding a CSV."); }
  };
  const run = async () => {
    setError(null); setResult(null);
    if (!agentId) { setError("Select an agent that has this skill enabled."); return; }
    let skillInput: unknown;
    try { skillInput = JSON.parse(raw); } catch { setError("Input must be valid JSON."); return; }
    setWorking(true);
    try {
      const created = await api.createExecutionRun({ name: `Skill: ${executable.find((item) => item.id === skillId)?.label ?? skillId}`, executionMode: "mock", concurrencyLimit: 1, tasks: [{ key: "skill-run", title: "Execute selected skill", agentId, skillId, skillInput }] });
      await api.startExecutionRun(created.run.id);
      let run = await api.executionRun(created.run.id);
      for (let attempts = 0; attempts < 20 && !["completed", "failed", "cancelled"].includes(run.run.status); attempts++) { await new Promise((resolve) => window.setTimeout(resolve, 200)); run = await api.executionRun(created.run.id); }
      const task = run.run.tasks?.[0];
      if (!task || task.status !== "succeeded") throw new Error(task?.error ?? "Skill execution did not complete.");
      setResult(task.output); toast("Skill result saved to execution history.");
    } catch (runError) { setError(runError instanceof Error ? runError.message : "Could not execute skill."); }
    finally { setWorking(false); }
  };
  const output = result as { artifacts?: Array<{ name: string; mimeType: string; content: string }>; result?: { chartReady?: { labels?: string[]; values?: number[] } } } | null;
  const chart = output?.result?.chartReady;
  const max = Math.max(1, ...(chart?.values ?? []));
  return <section className="h-full w-full overflow-y-auto bg-app p-5 md:p-8"><div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
    <aside className="rounded-2xl bg-side p-3 ring-1 ring-line"><h1 className="px-2 py-2 text-lg font-semibold">Skills manager</h1><p className="px-2 pb-3 text-xs leading-relaxed text-mute">Skills run through persistent execution history. MOCK is local and makes no external requests.</p>{executable.map((skill) => <button key={skill.id} onClick={() => selectSkill(skill.id)} className={`mb-1 w-full rounded-xl p-3 text-left ${skillId === skill.id ? "bg-active" : "hover:bg-hover"}`}><span className="block text-sm font-medium">{skill.label}</span><span className="mt-1 block text-xs leading-snug text-mute">{skill.description}</span></button>)}</aside>
    <main className="space-y-5"><div className="rounded-2xl bg-side p-5 ring-1 ring-line"><h2 className="text-lg font-semibold">{executable.find((item) => item.id === skillId)?.label}</h2><p className="mt-1 text-sm text-mute">Required structured input is validated on the server. Results are deterministic local computations or supplied-evidence analysis; no provider success is simulated.</p><div className="mt-4 grid gap-4 md:grid-cols-2"><Field label="Authorized agent" hint="Only agents configured with this skill are shown."><select className={inputClass} value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">Select agent</option>{allowed.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.title}</option>)}</select></Field><div className="rounded-xl bg-raised p-3 text-xs text-mute"><b className="text-ink">Permissions</b><br />Read-only/local execution. Email is draft-only; code review never executes source; market and leads use supplied evidence only.</div></div>
      {skillId === "skill.data-analysis" && <div className="mt-4"><Field label="CSV upload" hint="CSV and JSON records are supported; native XLSX is not."><label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-sm text-mute hover:bg-hover"><Upload size={15} /> Select CSV<input className="hidden" type="file" accept=".csv,text/csv" onChange={(event) => void loadCsv(event.target.files?.[0])} /></label></Field></div>}
      <Field label="Structured input (JSON)" hint="Edit the starter payload for this skill."><textarea className={`${inputClass} mt-2 min-h-72 font-mono text-xs`} value={raw} onChange={(event) => setRaw(event.target.value)} /></Field><div className="mt-4 flex gap-2"><Button variant="primary" disabled={working || !allowed.length} onClick={() => void run()}><Play size={15} />{working ? "Running…" : "Run skill"}</Button><Button onClick={() => openExecutions()}>View history</Button></div>{!allowed.length && <p className="mt-3 text-sm text-warn">No installed agent has this skill enabled. Assign it in Agent Factory first.</p>}{error && <p role="alert" className="mt-3 rounded-xl bg-danger-soft p-3 text-sm text-danger">{error}</p>}</div>
      {result !== null && <div className="rounded-2xl bg-side p-5 ring-1 ring-line"><h2 className="font-semibold">Execution result</h2>{chart?.labels && chart.values && <div className="mt-4"><p className="mb-2 text-xs text-mute">Chart-ready grouped aggregation</p><svg viewBox="0 0 500 180" className="h-44 w-full rounded-xl bg-raised" role="img" aria-label="Data analysis bar chart">{chart.values.map((value, index) => { const height = (value / max) * 130; return <g key={chart.labels?.[index]}><rect x={20 + index * (450 / chart.values!.length)} y={150 - height} width={Math.max(12, 360 / chart.values!.length)} height={height} fill="#7c6cff" /><text x={20 + index * (450 / chart.values!.length)} y="170" fill="currentColor" fontSize="11">{chart.labels?.[index]}</text></g>; })}</svg></div>}<pre className="mt-4 max-h-96 overflow-auto rounded-xl bg-raised p-3 text-xs text-mute">{JSON.stringify(result, null, 2)}</pre>{output?.artifacts?.map((artifact) => <Button key={artifact.name} className="mt-3" size="sm" onClick={() => download(artifact.name, artifact.content, artifact.mimeType)}><Download size={14} /> Download {artifact.name}</Button>)}</div>}
    </main></div></section>;
}
