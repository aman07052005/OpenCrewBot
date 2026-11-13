import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createClient } from "@libsql/client";
import { discoverAgentCapabilities } from "../src/lib/server/chief-of-staff.ts";
import { createBotRecord } from "../src/lib/server/bot-creation.ts";
import { createAgentFactoryService } from "../src/lib/server/agent-factory-service.ts";
import { generateAgentFactoryDraft } from "../src/lib/server/agent-factory.ts";
import { WORKFORCE_TEMPLATES } from "../src/lib/shared/agent-factory-templates.ts";

const DEFAULT_MODEL = "MiniMaxAI/MiniMax-M3";
const models = [{ id: DEFAULT_MODEL, label: "MiniMax M3" }];

function modelOutput(overrides = {}) {
  return {
    name: "Insight Analyst",
    title: "Data Analyst",
    description: "Interprets business data and explains findings.",
    instructions: "Analyze supplied data, show assumptions, and explain uncertainty.",
    model: DEFAULT_MODEL,
    tools: { webSearch: false, memory: true, codeMode: true, browser: false, askUser: true },
    skillIds: ["skill.analysis", "skill.data-analysis"],
    memoryEnabled: true,
    expectedOutputFormat: "Summary, calculations, caveats, and next steps.",
    ...overrides,
  };
}

async function fixture(t, seedBots = []) {
  const root = mkdtempSync(join(tmpdir(), "opencrewbot-agent-factory-"));
  const db = createClient({ url: "file::memory:" });
  await db.execute("CREATE TABLE bots (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  for (const bot of seedBots) {
    await db.execute({ sql: "INSERT INTO bots (id, data) VALUES (?, ?)", args: [bot.id, JSON.stringify(bot)] });
  }
  let events = 0;
  let nextId = 1;

  const listBots = async () => {
    const rows = await db.execute("SELECT data FROM bots");
    return rows.rows.map((row) => JSON.parse(String(row.data)));
  };
  const saveBot = async (bot) => {
    await db.execute({
      sql: "INSERT INTO bots (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      args: [bot.id, JSON.stringify(bot)],
    });
  };
  const createBot = (input) => createBotRecord(input, {
    listBots,
    saveBot,
    writeMemory: (botId, content) => {
      const workspace = join(root, "workspaces", botId);
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "MEMORY.md"), content, "utf8");
    },
    publishBotsChanged: () => { events += 1; },
    createId: () => `agent-${nextId++}`,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  const factory = createAgentFactoryService({
    listBots,
    createBot,
    listModels: async () => models,
    defaultModel: DEFAULT_MODEL,
    hasLiveKey: () => true,
    redactSecrets: (value) => value.replace(/api[_-]?key\s*[:=]\s*\S+/gi, "[redacted]"),
  });
  t.after(async () => {
    await db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, factory, listBots, createBot, eventCount: () => events };
}

test("MOCK generation is deterministic and does not call a model", async () => {
  let modelCalls = 0;
  const options = { bots: [], modelIds: [DEFAULT_MODEL], defaultModel: DEFAULT_MODEL, generateLive: async () => { modelCalls += 1; } };
  const input = { description: "Create a financial analyst specialising in revenue forecasting and business performance.", generationMode: "mock" };
  const first = await generateAgentFactoryDraft(input, options);
  const second = await generateAgentFactoryDraft(input, options);
  assert.deepEqual(first, second);
  assert.match(first.name, /Financial Analyst/i);
  assert.equal(first.approval, "ask");
  assert.equal(first.agentConfig.generationMode, "mock");
  assert.equal(modelCalls, 0);
});

test("MOCK extraction separates explicit agent names from natural-language roles", async () => {
  const cases = [
    {
      description: "Create an AI agent named Nova that specialises in revenue forecasting.",
      name: "Nova",
      title: "Revenue Forecasting",
      handle: "nova",
    },
    {
      description: "Build an AI agent called 'Northstar', a customer success manager focused on account onboarding.",
      name: "Northstar",
      title: "Customer Success Manager",
      handle: "northstar",
    },
    {
      description: "Create a cybersecurity analyst to review cloud configurations.",
      name: "Cybersecurity Analyst",
      title: "Cybersecurity Analyst",
      handle: "cybersecurity-analyst",
    },
    {
      description: "I would like you to build an AI assistant called 'Beacon' who is a travel coordinator.",
      name: "Beacon",
      title: "Travel Coordinator",
      handle: "beacon",
    },
  ];

  for (const item of cases) {
    const draft = await generateAgentFactoryDraft({ description: item.description, generationMode: "mock" }, {
      bots: [], modelIds: [DEFAULT_MODEL], defaultModel: DEFAULT_MODEL,
    });
    assert.equal(draft.name, item.name);
    assert.equal(draft.title, item.title);
    assert.equal(draft.handle, item.handle);
    assert.doesNotMatch(draft.name, /AI Agent Named/i);
    assert.doesNotMatch(draft.title, /AI Agent Named/i);
  }
});

test("LIVE generation uses an injected model result and forces Ask First", async () => {
  let received;
  const draft = await generateAgentFactoryDraft({ description: "Review financial performance", generationMode: "live" }, {
    bots: [], modelIds: [DEFAULT_MODEL], defaultModel: DEFAULT_MODEL,
    generateLive: async (context) => { received = context; return modelOutput(); },
  });
  assert.equal(draft.approval, "ask");
  assert.equal(draft.agentConfig.generationMode, "live");
  assert.equal(received.description, "Review financial performance");
  assert.ok(received.skills.length > 0);
});

test("malformed configurations, unauthorized permissions, and unsupported tools are rejected", async () => {
  for (const output of [
    modelOutput({ approval: "full" }),
    modelOutput({ tools: { webSearch: true, shell: true } }),
    modelOutput({ skillIds: ["skill.not-real"] }),
  ]) {
    await assert.rejects(() => generateAgentFactoryDraft({ description: "Make an analyst", generationMode: "live" }, {
      bots: [], modelIds: [DEFAULT_MODEL], defaultModel: DEFAULT_MODEL, generateLive: async () => output,
    }), /malformed configuration/);
  }
});

test("unknown model IDs and extra tool settings fail validation", async () => {
  await assert.rejects(() => generateAgentFactoryDraft({ description: "Make an analyst", generationMode: "live" }, {
    bots: [], modelIds: [DEFAULT_MODEL], defaultModel: DEFAULT_MODEL, generateLive: async () => modelOutput({ model: "provider/unknown" }),
  }), /not in the available model catalog/);
  await assert.rejects(() => generateAgentFactoryDraft({ description: "Make an analyst", generationMode: "live" }, {
    bots: [], modelIds: [DEFAULT_MODEL], defaultModel: DEFAULT_MODEL,
    generateLive: async () => modelOutput({ tools: { webSearch: false, memory: true, codeMode: true, browser: false, askUser: true, custom: true } }),
  }), /malformed configuration/);
});

test("duplicate names are rejected and duplicate handles get a unique suffix", async (t) => {
  const existing = {
    id: "existing", name: "Existing Analyst", handle: "insight-analyst", title: "Analyst", description: "Existing agent.",
    instructions: "Existing instructions.", emoji: "A", color: "#123456", model: DEFAULT_MODEL,
    tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: true }, connections: [], approval: "ask", pinned: false, createdAt: "2025-01-01T00:00:00.000Z",
  };
  const { factory } = await fixture(t, [existing]);
  const draft = await factory.generate({ description: "Create an insight analyst", generationMode: "mock" });
  assert.equal(draft.handle, "insight-analyst2");
  const saved = await factory.save({ draft });
  assert.equal(saved.handle, "insight-analyst2");
  const duplicateName = await factory.generate({ description: "Create an insight analyst", generationMode: "mock" });
  await assert.rejects(() => factory.save({ draft: duplicateName }), /already exists/);
});

test("factory save persists the agent, initializes Markdown memory, and enables Chief of Staff discovery", async (t) => {
  const { factory, listBots, root, eventCount } = await fixture(t);
  const draft = await factory.generate({ description: "Create a financial forecasting analyst", generationMode: "mock" });
  draft.name = "Forecast Partner";
  draft.handle = "forecast-partner";
  const saved = await factory.save({ draft });
  const records = await listBots();
  assert.equal(records.length, 1);
  assert.equal(records[0].id, saved.id);
  assert.equal(records[0].agentConfig.source, "factory");
  assert.equal(records[0].approval, "ask");
  assert.equal(readFileSync(join(root, "workspaces", saved.id, "MEMORY.md"), "utf8"), `# ${saved.name}'s memory\n\n`);
  assert.equal(eventCount(), 1);
  const discovered = discoverAgentCapabilities(records, { tavilyAvailable: false });
  assert.ok(discovered.some((agent) => agent.id === saved.id && agent.skillIds.includes("skill.financial-analysis")));
});

test("saved agent configuration and Markdown memory survive an application process restart", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "opencrewbot-agent-factory-restart-"));
  const dbUrl = pathToFileURL(join(root, "agents.db")).href;
  const memoryRoot = join(root, "workspaces");
  const helper = join(process.cwd(), "tests", "helpers", "agent-factory-persistence-child.mjs");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runChild = (operation) => {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", helper, operation, dbUrl, memoryRoot], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message || "Persistence helper failed.");
    return JSON.parse(child.stdout.trim());
  };

  const created = runChild("create");
  const restored = runChild("verify");
  assert.equal(restored.record.id, created.id);
  assert.equal(restored.record.name, "Restart Analyst");
  assert.equal(restored.record.approval, "ask");
  assert.equal(restored.record.agentConfig.generationMode, "mock");
  assert.equal(restored.record.agentConfig.creationRequest, "Create a financial analyst for forecasting.");
  assert.equal(restored.memory, "# Restart Analyst's memory\n\n");
});

test("template installation is repeatable and preserves existing agent data", async (t) => {
  const existing = {
    id: "scout", name: "Scout", handle: "scout", title: "Research", description: "Existing Scout.", instructions: "Keep as is.",
    emoji: "S", color: "#123456", model: DEFAULT_MODEL,
    tools: { webSearch: true, memory: true, codeMode: false, browser: false, askUser: true }, connections: [], approval: "ask", pinned: true, createdAt: "2024-01-01T00:00:00.000Z",
  };
  const { factory, listBots, root } = await fixture(t, [existing]);
  const first = await factory.installTemplates();
  const second = await factory.installTemplates();
  assert.equal(first.installed.length, 5);
  assert.deepEqual(second.installed, []);
  assert.equal(second.alreadyInstalled.length, 5);
  assert.equal((await listBots()).length, 6);
  assert.equal((await listBots()).find((bot) => bot.id === "scout").instructions, "Keep as is.");
  assert.equal(WORKFORCE_TEMPLATES.length, 5);
  for (const bot of (await listBots()).filter((item) => item.id !== "scout")) {
    assert.match(readFileSync(join(root, "workspaces", bot.id, "MEMORY.md"), "utf8"), /^#/);
  }
});

test("LIVE failure does not fall back to mock", async (t) => {
  await fixture(t);
  let calls = 0;
  const service = createAgentFactoryService({
    listBots: async () => [], createBot: async () => { throw new Error("should not create"); },
    listModels: async () => models, defaultModel: DEFAULT_MODEL, hasLiveKey: () => true,
    liveGenerator: async () => { calls += 1; throw new Error("model offline"); },
  });
  await assert.rejects(() => service.generate({ description: "Create an analyst", generationMode: "live" }), /No mock configuration was substituted/);
  assert.equal(calls, 1);
});

test("manual bot creation remains compatible without factory metadata", async (t) => {
  const { createBot, listBots } = await fixture(t);
  const bot = await createBot({
    name: "Manual Specialist", title: "Generalist", description: "Manually configured.", instructions: "Follow the user's instructions.",
    emoji: "M", color: "#123456", model: DEFAULT_MODEL,
    tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: true }, approval: "ask", pinned: false,
  });
  assert.equal(bot.agentConfig, undefined);
  assert.equal(bot.approval, "ask");
  assert.equal((await listBots()).length, 1);
});
