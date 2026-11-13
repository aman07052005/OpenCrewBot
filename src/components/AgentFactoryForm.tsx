"use client";

import clsx from "clsx";
import { Check, Sparkles, Users } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/client/api";
import { AGENT_SKILLS } from "@/lib/shared/agent-skills";
import { WORKFORCE_TEMPLATES, workforceTemplateDraft, type WorkforceTemplate } from "@/lib/shared/agent-factory-templates";
import type { AgentFactoryDraft, AgentFactoryGenerationMode, Bot } from "@/lib/shared/types";
import { useApp } from "./OpenCrewBotApp";
import { ModelPicker } from "./ModelPicker";
import { Button, Field, inputClass, Segmented, Toggle } from "./ui";

type GenerationMode = Exclude<AgentFactoryGenerationMode, "template">;

export function AgentFactoryForm({ onDone }: { onDone: (bot: Bot) => void }) {
  const { state, open, toast } = useApp();
  const defaultModel = state.models.find((model) => model.id === "MiniMaxAI/MiniMax-M3")?.id ?? state.models[0]?.id ?? "MiniMaxAI/MiniMax-M3";
  const [description, setDescription] = useState("");
  const [generationMode, setGenerationMode] = useState<GenerationMode>("mock");
  const [draft, setDraft] = useState<AgentFactoryDraft | null>(null);
  const [working, setWorking] = useState<"generate" | "save" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [templateMessage, setTemplateMessage] = useState<string | null>(null);

  const update = (patch: Partial<AgentFactoryDraft>) => setDraft((current) => current ? { ...current, ...patch } : current);

  const setTool = (tool: keyof AgentFactoryDraft["tools"], enabled: boolean) => {
    setDraft((current) => current ? {
      ...current,
      tools: { ...current.tools, [tool]: enabled },
      ...(tool === "memory" ? { agentConfig: { ...current.agentConfig, memory: { ...current.agentConfig.memory, enabled } } } : {}),
    } : current);
  };

  const generate = async () => {
    setError(null);
    setTemplateMessage(null);
    if (!description.trim()) return setError("Describe what you want this agent to do.");
    setWorking("generate");
    try {
      const result = await api.generateFactoryAgent({ description: description.trim(), generationMode });
      setDraft(result.draft);
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : "Agent generation failed.");
    } finally {
      setWorking(null);
    }
  };

  const chooseTemplate = (template: WorkforceTemplate) => {
    setError(null);
    setTemplateMessage(null);
    const templateDraft = workforceTemplateDraft(template, defaultModel);
    setDescription(templateDraft.agentConfig.creationRequest);
    setDraft(templateDraft);
  };

  const save = async () => {
    if (!draft) return;
    setError(null);
    setWorking("save");
    try {
      const result = await api.createFactoryAgent(draft);
      toast(`${result.bot.name} is ready.`);
      open(`dm:${result.bot.id}`);
      onDone(result.bot);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Couldn't save this agent.");
    } finally {
      setWorking(null);
    }
  };

  const installTemplates = async () => {
    setError(null);
    setTemplateMessage(null);
    setWorking("install");
    try {
      const result = await api.installWorkforceTemplates();
      const parts = [
        result.installed.length ? `Installed: ${result.installed.join(", ")}` : "No new templates installed",
        result.alreadyInstalled.length ? `Already present: ${result.alreadyInstalled.join(", ")}` : "",
        result.conflicts.length ? `Name or handle conflicts: ${result.conflicts.map((item) => `${item.agentName} (${item.templateId})`).join(", ")}` : "",
      ].filter(Boolean);
      setTemplateMessage(parts.join(" · "));
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : "Couldn't install the workforce templates.");
    } finally {
      setWorking(null);
    }
  };

  const toggleSkill = (skillId: string, checked: boolean) => {
    setDraft((current) => current ? {
      ...current,
      agentConfig: {
        ...current.agentConfig,
        skillIds: checked
          ? [...current.agentConfig.skillIds, skillId]
          : current.agentConfig.skillIds.filter((id) => id !== skillId),
      },
    } : current);
  };

  return (
    <div className="space-y-5">
      <Field label="Describe the agent" hint="Include its role, audience, responsibilities, boundaries, and the kind of answer it should produce.">
        <textarea className={clsx(inputClass, "min-h-28 resize-y leading-relaxed")} value={description} maxLength={4_000} onChange={(event) => setDescription(event.target.value)} placeholder="Create a financial analyst specialising in revenue forecasting and business performance." />
      </Field>
      <div className="space-y-2">
        <p className="text-[12.5px] font-medium text-mute">Generation mode</p>
        <Segmented value={generationMode} onChange={setGenerationMode} options={[
          { value: "mock", label: "MOCK · DETERMINISTIC", hint: "Local configuration rules; no model call." },
          { value: "live", label: "LIVE MODEL", hint: "Uses the configured Mastra model." },
        ]} />
        {generationMode === "live" && <p className="rounded-xl bg-warn/10 px-3 py-2.5 text-[11px] leading-relaxed text-warn">Live generation calls a model and may incur a charge. It requires NEBIUS_API_KEY. If it fails, no mock configuration is substituted.</p>}
      </div>
      <Button variant="primary" onClick={() => void generate()} disabled={working !== null}><Sparkles size={14} />{working === "generate" ? "Generating…" : "Generate agent configuration"}</Button>

      <section className="space-y-3 rounded-2xl bg-raised p-3.5 ring-1 ring-line">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-[13px] font-semibold">Workforce templates</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-faint">Choose one to customize it before saving, or install all five.</p>
          </div>
          <Button size="sm" aria-label="Install workforce templates" onClick={() => void installTemplates()} disabled={working !== null}><Users size={13} />{working === "install" ? "Installing…" : "Install workforce templates"}</Button>
        </div>
        <div className="space-y-2">
          {WORKFORCE_TEMPLATES.map((template) => (
            <div key={template.id} className="flex items-start gap-3 rounded-xl bg-side p-3 ring-1 ring-line">
              <span className="mt-0.5 text-lg" aria-hidden>{template.emoji}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-semibold">{template.name} · {template.title}</span>
                <span className="mt-1 block text-[11px] leading-relaxed text-mute">{template.description}</span>
              </span>
              <Button size="sm" onClick={() => chooseTemplate(template)} disabled={working !== null}>Customize</Button>
            </div>
          ))}
        </div>
        {templateMessage && <p role="status" className="rounded-xl bg-ok/10 px-3 py-2.5 text-[11px] leading-relaxed text-ok">{templateMessage}</p>}
      </section>

      {draft && <>
        <div className="rounded-xl bg-warn/10 px-3 py-2.5 text-[11px] font-semibold leading-relaxed text-warn">{draft.generationLabel}</div>
        <section className="space-y-4 rounded-2xl bg-raised p-4 ring-1 ring-line">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xl" style={{ backgroundColor: `${draft.color}22`, color: draft.color }} aria-hidden>{draft.emoji}</span>
            <div className="min-w-0">
              <h3 className="text-[13px] font-semibold">Configuration preview</h3>
              <p className="mt-1 text-[11px] text-faint">The internal bot ID is assigned when you save. The handle below is the unique room mention.</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name"><input className={inputClass} value={draft.name} maxLength={40} onChange={(event) => update({ name: event.target.value })} /></Field>
            <Field label="Role"><input className={inputClass} value={draft.title} maxLength={40} onChange={(event) => update({ title: event.target.value })} /></Field>
          </div>
          <Field label="Handle"><div className="relative"><span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[14px] text-faint">@</span><input className={clsx(inputClass, "pl-7")} value={draft.handle} maxLength={24} onChange={(event) => update({ handle: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} /></div></Field>
          <Field label="Description"><textarea className={clsx(inputClass, "min-h-16 resize-y")} value={draft.description} maxLength={200} onChange={(event) => update({ description: event.target.value })} /></Field>
          <Field label="Persona and system instructions"><textarea className={clsx(inputClass, "min-h-32 resize-y leading-relaxed")} value={draft.instructions} maxLength={8_000} onChange={(event) => update({ instructions: event.target.value })} /></Field>
          <div>
            <span className="mb-1.5 block text-[12.5px] font-medium text-mute">Model</span>
            <ModelPicker value={draft.model} onChange={(model) => update({ model })} />
          </div>
          <div>
            <span className="mb-1.5 block text-[12.5px] font-medium text-mute">Tools and capabilities</span>
            <div className="divide-y divide-line rounded-2xl bg-side px-4">
              <Toggle label="Web search" hint={state.status?.keys.tavily ? "Read-only search, page reading, and crawling." : "Needs TAVILY_API_KEY when used."} checked={draft.tools.webSearch} onChange={(value) => setTool("webSearch", value)} />
              <Toggle label="Memory" hint="Stores this agent's notes in its own Markdown MEMORY.md file." checked={draft.tools.memory} onChange={(value) => setTool("memory", value)} />
              <Toggle label="Code mode" hint="Runs bounded TypeScript in the existing sandbox with enabled read-only tools." checked={draft.tools.codeMode} onChange={(value) => setTool("codeMode", value)} />
              <Toggle label="Browser" hint={state.status?.keys.browserbase ? "Uses the existing Browserbase integration; browser actions ask first by default." : "Needs BROWSERBASE_API_KEY when used."} checked={draft.tools.browser} onChange={(value) => setTool("browser", value)} />
              <Toggle label="Ask user" hint="Can pause and ask a question in a chat." checked={draft.tools.askUser} onChange={(value) => setTool("askUser", value)} />
            </div>
          </div>
          <Field label="Permission level" hint="New configurations start at Ask First. Full access requires your explicit selection here.">
            <Segmented value={draft.approval} onChange={(approval) => update({ approval })} options={[
              { value: "ask", label: "ASK FIRST", hint: "Existing approval prompts remain enabled." },
              { value: "full", label: "FULL ACCESS", hint: "Uses the existing full-access setting." },
            ]} />
          </Field>
          <Field label="Expected output format"><textarea className={clsx(inputClass, "min-h-20 resize-y")} value={draft.agentConfig.expectedOutputFormat} maxLength={1_000} onChange={(event) => update({ agentConfig: { ...draft.agentConfig, expectedOutputFormat: event.target.value } })} /></Field>
          <div>
            <p className="mb-1.5 text-[12.5px] font-medium text-mute">Reusable skill identifiers</p>
            <p className="mb-2 text-[11px] leading-relaxed text-faint">Metadata only. Skill identifiers are saved for future modules and do not add executable behavior today.</p>
            <div className="space-y-1.5">
              {AGENT_SKILLS.map((skill) => <label key={skill.id} className="flex items-start gap-2.5 text-[11px] text-mute"><input type="checkbox" checked={draft.agentConfig.skillIds.includes(skill.id)} onChange={(event) => toggleSkill(skill.id, event.target.checked)} /><span><span className="font-medium">{skill.label}</span><span className="ml-1 font-mono text-[10px] text-faint">{skill.id}</span></span></label>)}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Emoji"><input className={inputClass} value={draft.emoji} maxLength={12} onChange={(event) => update({ emoji: event.target.value })} /></Field>
            <Field label="Color"><input className={clsx(inputClass, "h-10 p-1.5")} type="color" value={draft.color} onChange={(event) => update({ color: event.target.value })} /></Field>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-side px-3 py-2.5 text-[10px] leading-relaxed text-faint"><Check size={13} className="shrink-0 text-ok" />No credentials, connected services, or custom tool definitions are included in this configuration.</div>
        </section>
        <div className="sticky bottom-0 -mx-5 flex items-center justify-end gap-2 border-t border-line bg-side px-5 py-3">
          <Button variant="primary" onClick={() => void save()} disabled={working !== null || !draft.name.trim() || !draft.title.trim()}>{working === "save" ? "Saving…" : "Save agent"}</Button>
        </div>
      </>}

      {error && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2.5 text-[12px] leading-relaxed text-danger">{error}</p>}
    </div>
  );
}

