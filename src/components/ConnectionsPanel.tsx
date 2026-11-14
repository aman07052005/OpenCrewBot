"use client";

import clsx from "clsx";
import { ArrowUpRight, Check, Plug, Search, Server, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { useConnections } from "@/lib/client/use-connections";
import type { ComposioApp } from "@/lib/shared/types";
import { useApp } from "./OpenCrewBotApp";
import { Button, Drawer, Field, inputClass } from "./ui";

function AppLogo({ app, size = 28 }: { app: { name: string; logo?: string }; size?: number }) {
  return app.logo ? (
    // Logos come from Composio's CDN.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={app.logo} alt="" width={size} height={size} className="shrink-0 rounded-lg bg-white/90 object-contain p-1" />
  ) : (
    <span className="flex shrink-0 items-center justify-center rounded-lg bg-raised-2 text-[12px] font-semibold" style={{ width: size, height: size }}>
      {app.name.slice(0, 1)}
    </span>
  );
}

function AppRow({ app, onChanged }: { app: ComposioApp; onChanged: () => void }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    try {
      const { redirectUrl } = await api.connectApp(app.slug);
      // Sign-in happens on Composio's page; it sends you back here when done.
      window.location.href = redirectUrl;
    } catch (error) {
      toast(error instanceof Error ? error.message : `Couldn't start connecting ${app.name}.`);
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm(`Disconnect ${app.name}? Bots lose access to it until you connect it again.`)) return;
    setBusy(true);
    try {
      await api.disconnectApp(app.slug);
      toast(`${app.name} disconnected.`);
      onChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : `Couldn't disconnect ${app.name}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <AppLogo app={app} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium">{app.name}</span>
        {app.connected && (
          <span className="flex items-center gap-1 text-[12px] text-ok">
            <Check size={12} /> Connected
          </span>
        )}
      </span>
      {app.connected ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={disconnect}>
          Disconnect
        </Button>
      ) : (
        <Button size="sm" variant="secondary" disabled={busy} onClick={connect}>
          {busy ? "Opening…" : "Connect"}
        </Button>
      )}
    </li>
  );
}

const GITHUB_PRESET = { name: "GitHub", url: "https://api.githubcopilot.com/mcp/" };
type DiscoveredMcpTool = { name: string; description: string; inputSchema: unknown; annotations: { readOnlyHint?: boolean } | null; enabled: boolean };

function AddServerForm({ onAdded }: { onAdded: () => void }) {
  const { toast } = useApp();
  const [form, setForm] = useState({ name: "", url: "", token: "", headerName: "", headerValue: "" });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const headers = form.headerName.trim() ? { [form.headerName.trim()]: form.headerValue } : undefined;
      const { server } = await api.addMcpServer({ name: form.name, url: form.url, token: form.token || undefined, headers });
      // Check it straight away so a typo in the URL or token shows up now, not mid-chat.
      try {
        const { tools } = await api.testMcpServer(server.id);
        toast(`${server.name} added: ${tools} tools. Switch it on for a bot in its Details.`);
      } catch (error) {
        toast(`${server.name} added, but the test failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
      setForm({ name: "", url: "", token: "", headerName: "", headerValue: "" });
      onAdded();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't add the server.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-2xl bg-raised p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-medium">Add an MCP server</span>
        <Button size="sm" variant="ghost" onClick={() => setForm((f) => ({ ...f, ...GITHUB_PRESET }))}>
          Use GitHub preset
        </Button>
      </div>
      <div className="grid grid-cols-[1fr_2fr] gap-2">
        <Field label="Name">
          <input className={inputClass} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="GitHub" />
        </Field>
        <Field label="Server URL">
          <input className={inputClass} value={form.url} onChange={(e) => set("url", e.target.value)} placeholder="https://…/mcp" />
        </Field>
      </div>
      <Field
        label="Token"
        hint={form.url.includes("githubcopilot") ? "A GitHub personal access token with the scopes you want bots to have." : "Sent as Authorization: Bearer <token>. Stored on the server only."}
      >
        <input className={inputClass} type="password" value={form.token} onChange={(e) => set("token", e.target.value)} placeholder="Optional" autoComplete="off" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Extra header (optional)">
          <input className={inputClass} value={form.headerName} onChange={(e) => set("headerName", e.target.value)} placeholder="Header name" />
        </Field>
        <Field label="Value">
          <input className={inputClass} type="password" value={form.headerValue} onChange={(e) => set("headerValue", e.target.value)} autoComplete="off" />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button variant="primary" disabled={saving || !form.name.trim() || !form.url.trim()} onClick={save}>
          {saving ? "Adding…" : "Add and test"}
        </Button>
      </div>
    </div>
  );
}

export function ConnectionsPanel({ onClose }: { onClose: () => void }) {
  const { state, toast, openExecutions, openApprovals } = useApp();
  const { data, error, reload, loading } = useConnections(state.connectionsVersion);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ComposioApp[] | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [integrations, setIntegrations] = useState<Array<{ id: string; name: string; status: string; operations: string[]; authentication?: string; requiredPermissions?: string; resourceScope?: string; verifiedAt?: string; lastError?: string }> | null>(null);
  const [gmailConfirmed, setGmailConfirmed] = useState(false);
  const [gmailAgent, setGmailAgent] = useState("");
  const [gmailSubject, setGmailSubject] = useState("OpenCrewBot Demo TEST2026");
  const [gmailBusy, setGmailBusy] = useState(false);
  const [gmailNotice, setGmailNotice] = useState("");
  const gmailVerified = integrations?.find((item) => item.id === "gmail")?.status === "connected-verified";
  const gmailOperation = async (operation: "verify" | "propose") => {
    setGmailBusy(true); setGmailNotice("");
    try {
      if (operation === "verify") { await api.gmailVerify(); setGmailNotice("Gmail profile verified by the live provider. No mailbox content was retrieved."); }
      else { const { action } = await api.gmailPropose(gmailAgent, gmailSubject); setGmailNotice(`Action ${action.status}. Open Approvals to approve and execute the exact test-message read.`); }
    } catch (e) { setGmailNotice(e instanceof Error ? e.message : "Gmail request failed."); }
    finally {
      try { const value = await api.integrations(); setIntegrations(value.integrations); } catch { /* Keep operation notice. */ }
      setGmailBusy(false);
    }
  };
  const [github, setGithub] = useState({ agentId: "", repository: "", operation: "metadata" as "metadata" | "directory" | "file" | "issue" | "pull-request", path: "", ref: "", number: "" });
  const [githubBusy, setGithubBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [githubResult, setGithubResult] = useState<unknown>(null);
  const [mcpTools, setMcpTools] = useState<Record<string, DiscoveredMcpTool[]>>({});
  const [mcpInputs, setMcpInputs] = useState<Record<string, string>>({});
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const [mcpResult, setMcpResult] = useState<unknown>(null);

  // Search Composio's whole catalog, debounced.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const timer = window.setTimeout(() => {
      api
        .searchApps(q)
        .then(({ apps }) => setResults(apps))
        .catch(() => setResults([]));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let active = true;
    void api.integrations().then((data) => { if (active) setIntegrations(data.integrations); }).catch(() => { if (active) setIntegrations([]); });
    return () => { active = false; };
  }, [state.connectionsVersion]);

  const test = async (id: string, name: string) => {
    setTesting(id);
    try {
      const { tools } = await api.testMcpServer(id);
      toast(`${name} is reachable: ${tools} tools.`);
    } catch (e) {
      toast(`${name}: ${e instanceof Error ? e.message : "couldn't connect"}`);
    } finally {
      setTesting(null);
    }
  };

  const remove = async (id: string, name: string) => {
    if (!window.confirm(`Remove ${name}? Bots that use it lose access.`)) return;
    try {
      await api.removeMcpServer(id);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't remove it.");
    }
  };
  const discover = async (id: string, name: string) => {
    setDiscovering(id);
    try {
      const data = await api.inspectMcpTools(id);
      setMcpTools((current) => ({ ...current, [id]: data.tools as DiscoveredMcpTool[] }));
      const readOnly = data.tools.filter((tool) => (tool.annotations as { readOnlyHint?: boolean } | null)?.readOnlyHint).length;
      toast(`${name}: ${data.tools.length} discovered tools (${readOnly} advertise read-only access).`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not discover MCP tools.");
    } finally { setDiscovering(null); }
  };

  const inspectGithub = async () => {
    setGithubBusy(true);
    setGithubResult(null);
    try {
      const number = github.number.trim() ? Number(github.number) : undefined;
      const { result } = await api.inspectGitHub({
        agentId: github.agentId,
        operation: github.operation,
        repository: github.repository.trim(),
        ...(github.path.trim() ? { path: github.path.trim() } : {}),
        ...(github.ref.trim() ? { ref: github.ref.trim() } : {}),
        ...(number ? { number } : {}),
      });
      setGithubResult(result);
    } catch (error) {
      toast(error instanceof Error ? error.message : "GitHub inspection failed.");
    } finally { setGithubBusy(false); }
  };

  const reviewGithubFile = async () => {
    const value = githubResult as { operation?: unknown; file?: { path?: unknown; text?: unknown } } | null;
    if (value?.operation !== "file" || typeof value.file?.path !== "string" || typeof value.file.text !== "string") return;
    if (value.file.text.length > 100_000) { toast("Selected file is too large for the bounded Code Review skill."); return; }
    setReviewBusy(true);
    try {
      const created = await api.createExecutionRun({ name: `GitHub Code Review: ${value.file.path}`, executionMode: "mock", concurrencyLimit: 1, tasks: [{ key: "github-code-review", title: "Review selected GitHub source", agentId: github.agentId, skillId: "skill.code-review", skillInput: { files: [{ path: value.file.path, content: value.file.text }] } }] });
      await api.startExecutionRun(created.run.id);
      toast("Read-only code review saved to execution history.");
      openExecutions(created.run.id);
    } catch (error) { toast(error instanceof Error ? error.message : "Could not start code review."); }
    finally { setReviewBusy(false); }
  };

  const toggleMcpTool = async (serverId: string, tool: DiscoveredMcpTool) => {
    const current = mcpTools[serverId] ?? [];
    const enabled = current.filter((item) => item.enabled).map((item) => item.name);
    const next = tool.enabled ? enabled.filter((name) => name !== tool.name) : [...enabled, tool.name];
    try {
      const saved = await api.configureMcpReadTools(serverId, next);
      setMcpTools((all) => ({ ...all, [serverId]: current.map((item) => ({ ...item, enabled: saved.enabled.includes(item.name) })) }));
    } catch (error) { toast(error instanceof Error ? error.message : "Could not update MCP tool access."); }
  };

  const invokeMcpTool = async (serverId: string, tool: DiscoveredMcpTool) => {
    const agent = state.bots.find((bot) => bot.connections.includes(`mcp:${serverId}`));
    if (!agent) { toast("Connect this MCP server to a bot before invoking a tool."); return; }
    const key = `${serverId}:${tool.name}`;
    let input: unknown;
    try { input = JSON.parse(mcpInputs[key] || "{}"); } catch { toast("MCP input must be valid JSON."); return; }
    setMcpBusy(key);
    setMcpResult(null);
    try {
      const result = await api.invokeMcpReadTool(serverId, { agentId: agent.id, tool: tool.name, input });
      setMcpResult(result.result);
    } catch (error) { toast(error instanceof Error ? error.message : "MCP invocation failed."); }
    finally { setMcpBusy(null); }
  };

  const apps = query.trim() ? (results ?? []) : (data?.composio.apps ?? []);

  return (
    <Drawer title="Connections" onClose={onClose}>
      <p className="text-[13px] leading-relaxed text-mute">
        Connect apps once, then choose which bots can use each one in the bot&apos;s Details. Connected-app and MCP writes continue to ask first until they have a
        registered persistent authorization adapter.
      </p>

      <section className="mt-6">
        <div className="mb-5 rounded-2xl bg-raised p-4">
          <h3 className="text-[14px] font-medium">Integration status</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-mute">A connected app is not treated as verified until its provider check succeeds. GitHub reads, approved Gmail test-message reads and owner-enabled MCP tools are the bounded live operations.</p>
          <div className="mt-3 space-y-2">{integrations?.map((integration) => <div key={integration.id} className="rounded-xl bg-side p-3 text-[12px]"><span className="font-medium">{integration.name}</span><span className="ml-2 rounded-full bg-raised-2 px-2 py-0.5 text-faint">{integration.status}</span><p className="mt-1 text-mute">{integration.operations.join(" · ")}</p>{integration.lastError && <p className="mt-1 text-danger">{integration.lastError}</p>}</div>)}</div>
        </div>
        <div className="mb-5 rounded-2xl bg-raised p-4">
          <h3 className="text-[14px] font-medium">GitHub read-only inspection</h3>
          <p className="mt-1 text-[12px] text-mute">This sends one bounded request to GitHub&apos;s public API. Private repositories and all repository writes are unavailable.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <select className={inputClass} value={github.agentId} onChange={(event) => setGithub((value) => ({ ...value, agentId: event.target.value }))} aria-label="Agent authorized for GitHub"><option value="">Choose an agent</option>{state.bots.filter((bot) => bot.tools.webSearch || bot.connections.includes("composio:github")).map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select>
            <input className={inputClass} value={github.repository} onChange={(event) => setGithub((value) => ({ ...value, repository: event.target.value }))} placeholder="owner/repository" aria-label="GitHub repository" />
            <select className={inputClass} value={github.operation} onChange={(event) => setGithub((value) => ({ ...value, operation: event.target.value as typeof value.operation }))} aria-label="GitHub operation"><option value="metadata">Repository metadata</option><option value="directory">Directory listing</option><option value="file">Selected file</option><option value="issue">Issue</option><option value="pull-request">Pull request</option></select>
            {github.operation === "file" || github.operation === "directory" ? <input className={inputClass} value={github.path} onChange={(event) => setGithub((value) => ({ ...value, path: event.target.value }))} placeholder={github.operation === "file" ? "Path, e.g. src/index.ts" : "Directory path (optional)"} aria-label="Repository path" /> : <input className={inputClass} value={github.number} onChange={(event) => setGithub((value) => ({ ...value, number: event.target.value }))} placeholder="Issue or pull request number" disabled={github.operation === "metadata"} aria-label="Issue or pull request number" />}
            <input className={inputClass} value={github.ref} onChange={(event) => setGithub((value) => ({ ...value, ref: event.target.value }))} placeholder="Branch or tag (for files)" aria-label="GitHub ref" />
          </div>
          <div className="mt-3 flex justify-end"><Button size="sm" variant="secondary" disabled={githubBusy || !github.agentId || !github.repository.trim() || (github.operation === "file" && !github.path.trim()) || ((github.operation === "issue" || github.operation === "pull-request") && !github.number.trim())} onClick={() => void inspectGithub()}>{githubBusy ? "Inspectingâ€¦" : "Inspect"}</Button></div>
          {githubResult !== null && <><pre className="mt-3 max-h-56 overflow-auto rounded-xl bg-side p-3 text-[11px] text-mute">{JSON.stringify(githubResult, null, 2)}</pre>{(githubResult as { operation?: unknown }).operation === "file" && <div className="mt-2 flex justify-end"><Button size="sm" variant="ghost" disabled={reviewBusy} onClick={() => void reviewGithubFile()}>{reviewBusy ? "Starting reviewâ€¦" : "Run Code Review"}</Button></div>}</>}
        </div>
        <div className="mb-5 rounded-2xl bg-raised p-4">
          <h3 className="text-[14px] font-medium">Gmail — authorized synthetic test read</h3>
          <p className="mt-1 text-[12px] text-mute">Connect one dedicated test mailbox via Composio below. Use only synthetic data. Profile verification is live; reading one designated email requires separate approval. No email is sent or modified.</p>
          <label className="mt-3 flex items-start gap-2 text-[12px]"><input type="checkbox" checked={gmailConfirmed} onChange={(e) => setGmailConfirmed(e.target.checked)} /> I confirm this is an authorized synthetic-only test mailbox.</label>
          <div className="mt-3"><Button size="sm" variant="secondary" disabled={!gmailConfirmed || gmailBusy} onClick={() => void gmailOperation("verify")}>Verify Gmail profile</Button></div>
          <div className="mt-3 space-y-2">
            <select className={inputClass} value={gmailAgent} onChange={(e) => setGmailAgent(e.target.value)} aria-label="Gmail authorized agent"><option value="">Choose Gmail-enabled agent</option>{state.bots.filter((bot) => bot.tools.askUser && bot.connections.includes("composio:gmail")).map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select>
            <input className={inputClass} value={gmailSubject} onChange={(e) => setGmailSubject(e.target.value)} aria-label="Synthetic email subject" />
            <p className="text-[12px] text-mute">Exact test subject: OpenCrewBot Demo plus a unique 4–32 character alphanumeric suffix (hyphens allowed). Exact body: OpenCrewBot synthetic test: revenue 120 units 12.</p>
            <div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" disabled={!gmailConfirmed || !gmailVerified || !gmailAgent || gmailBusy} onClick={() => void gmailOperation("propose")}>Propose test-message read</Button><Button size="sm" variant="ghost" onClick={() => { onClose(); openApprovals(); }}>Open Approvals</Button></div>
          </div>
          {gmailNotice && <p role="status" className="mt-3 text-[12px] text-mute">{gmailNotice}</p>}
        </div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-[12.5px] font-medium text-mute">
            <Plug size={13} /> Apps via Composio
          </h3>
          <a href="https://composio.dev" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[12px] text-faint hover:text-ink">
            composio.dev <ArrowUpRight size={12} />
          </a>
        </div>

        {loading && <p className="rounded-2xl bg-raised px-4 py-6 text-center text-[13px] text-mute">Loading…</p>}
        {error && <p className="rounded-2xl bg-danger-soft px-4 py-3 text-[13px] text-danger">{error}</p>}

        {data && !data.composio.enabled && (
          <div className="rounded-2xl bg-raised px-4 py-4">
            <p className="text-[14px] font-medium">Connect Slack, GitHub, Gmail and 1,000+ apps</p>
            <p className="mt-1 text-[13px] leading-relaxed text-mute">
              Add <code className="rounded-md bg-raised-2 px-1 font-mono text-[12px]">COMPOSIO_API_KEY</code> to <code className="rounded-md bg-raised-2 px-1 font-mono text-[12px]">.env</code> and
              restart. Composio handles each app&apos;s sign-in, so you never paste app passwords here.
            </p>
          </div>
        )}

        {data?.composio.enabled && (
          <>
            {data.composio.error && <p className="mb-2 rounded-2xl bg-danger-soft px-4 py-3 text-[13px] text-danger">{data.composio.error}</p>}
            <label className="mb-2 flex h-10 items-center gap-2 rounded-full bg-raised px-3.5 ring-1 ring-line focus-within:ring-2 focus-within:ring-accent">
              <Search size={15} className="text-faint" aria-hidden />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (!e.target.value.trim()) setResults(null);
                }}
                placeholder="Search all apps"
                aria-label="Search apps"
                className="min-w-0 flex-1 bg-transparent text-[14px] placeholder:text-faint focus:outline-none"
              />
            </label>
            <ul className={clsx("divide-y divide-line rounded-2xl bg-raised", apps.length === 0 && "hidden")}>
              {apps.map((app) => (
                <AppRow key={app.slug} app={app} onChanged={reload} />
              ))}
            </ul>
            {query.trim() && results && results.length === 0 && <p className="px-1 py-3 text-[13px] text-mute">No apps match.</p>}
          </>
        )}
      </section>

      <section className="mt-7">
        <h3 className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium text-mute">
          <Server size={13} /> Your MCP servers
        </h3>
        {data && data.mcpServers.length > 0 && (
          <ul className="mb-3 divide-y divide-line rounded-2xl bg-raised">
            {data.mcpServers.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium">{s.name}</span>
                  <span className="block truncate text-[12px] text-faint">
                    {s.url}
                    {s.hasToken ? " · token set" : ""}
                  </span>
                </span>
                <Button size="sm" variant="ghost" disabled={testing === s.id} onClick={() => test(s.id, s.name)}>
                  {testing === s.id ? "Testing…" : "Test"}
                </Button>
                <Button size="sm" variant="ghost" disabled={discovering === s.id} onClick={() => void discover(s.id, s.name)}>
                  {discovering === s.id ? "Discovering…" : "Discover"}
                </Button>
                <button aria-label={`Remove ${s.name}`} onClick={() => remove(s.id, s.name)} className="rounded-full p-2 text-faint hover:bg-raised-2 hover:text-danger">
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {Object.entries(mcpTools).map(([serverId, tools]) => {
          const server = data?.mcpServers.find((item) => item.id === serverId);
          return <div key={serverId} className="mb-3 rounded-2xl bg-raised p-4">
            <p className="text-[13px] font-medium">Discovered tools{server ? ` · ${server.name}` : ""}</p>
            <p className="mt-1 text-[12px] text-mute">Only tools that currently advertise read-only access can be enabled. Results are protocol-backed and redacted before display.</p>
            <div className="mt-3 space-y-2">{tools.map((tool) => {
              const key = `${serverId}:${tool.name}`;
              const readOnly = tool.annotations?.readOnlyHint === true;
              return <div key={tool.name} className="rounded-xl bg-side p-3 text-[12px]"><div className="flex items-start gap-2"><span className="min-w-0 flex-1"><span className="font-medium">{tool.name}</span><span className="ml-2 text-faint">{readOnly ? "read-only" : "not eligible"}</span><span className="mt-1 block text-mute">{tool.description || "No description provided."}</span></span><Button size="sm" variant="ghost" disabled={!readOnly} onClick={() => void toggleMcpTool(serverId, tool)}>{tool.enabled ? "Disable" : "Enable"}</Button></div>{tool.enabled && <><input className={`${inputClass} mt-2`} value={mcpInputs[key] ?? "{}"} onChange={(event) => setMcpInputs((all) => ({ ...all, [key]: event.target.value }))} aria-label={`JSON input for ${tool.name}`} /><div className="mt-2 flex justify-end"><Button size="sm" variant="secondary" disabled={mcpBusy === key} onClick={() => void invokeMcpTool(serverId, tool)}>{mcpBusy === key ? "Runningâ€¦" : "Run"}</Button></div></>}</div>;
            })}</div>
          </div>;
        })}
        {mcpResult !== null && <pre className="mb-3 max-h-56 overflow-auto rounded-2xl bg-raised p-3 text-[11px] text-mute">{JSON.stringify(mcpResult, null, 2)}</pre>}
        <AddServerForm onAdded={reload} />
      </section>
    </Drawer>
  );
}
