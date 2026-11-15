import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";
import { migrateExecutionSchema } from "../src/lib/server/execution-schema.ts";
import { migrateApprovalSchema } from "../src/lib/server/approval-schema.ts";
import { createExecutionRun, getExecutionRun, startExecutionRun } from "../src/lib/server/execution-engine.ts";
import { authorizeAction, decideAction, executeApprovedAction, getExecutionTaskAction } from "../src/lib/server/approval-service.ts";
import { executeTaskExternalAction, prepareExecutionActions, synchronizeExecutionAction } from "../src/lib/server/execution-actions.ts";

const githubArgs = { operation: "metadata", repository: "openai/openai-node" };
const baseBot = (approval = "ask", policy) => ({
  id: "agent-1", name: "Agent", handle: "agent", title: "Research", description: "", instructions: "", emoji: "", color: "", model: "local/test",
  tools: { webSearch: true, memory: false, codeMode: false, browser: false, askUser: true }, connections: ["mcp:demo"], approval, permissionPolicy: policy,
  agentConfig: { skillIds: ["skill.data-analysis"] }, pinned: false, createdAt: "2026-01-01T00:00:00Z",
});

async function fixture(t) {
  const client = createClient({ url: "file::memory:" });
  await migrateExecutionSchema(client); await migrateApprovalSchema(client);
  t.after(() => client.close());
  return client;
}

async function settle(client, id) {
  for (let i = 0; i < 300; i++) {
    const run = await getExecutionRun(client, id);
    if (["completed", "blocked", "failed", "cancelled"].includes(run.status) && !globalThis.__opencrewbotExecutionJobs?.has(id)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Execution did not settle");
}

test("registered integration reads obey Ask First, Controlled, Full and connection boundaries", () => {
  assert.equal(authorizeAction(baseBot("ask"), "github.public.read", githubArgs).decision, "approval-required");
  assert.equal(authorizeAction(baseBot("controlled", { preapprovedOperations: ["github.public.read"], allowedDestinations: [], maxActionsPerDay: 5 }), "github.public.read", githubArgs).decision, "allowed");
  assert.equal(authorizeAction(baseBot("controlled", { preapprovedOperations: [], allowedDestinations: [], maxActionsPerDay: 5 }), "github.public.read", githubArgs).decision, "approval-required");
  assert.equal(authorizeAction(baseBot("full"), "github.public.read", githubArgs).decision, "allowed");
  assert.equal(authorizeAction({ ...baseBot("full"), tools: { ...baseBot().tools, webSearch: false } }, "github.public.read", githubArgs).decision, "denied");
  assert.equal(authorizeAction(baseBot("full"), "mcp.read.invoke", { serverId: "other", tool: "read", input: {} }).decision, "denied");
  assert.equal(authorizeAction(baseBot("full"), "mcp.read.invoke", { serverId: "demo", tool: "read", input: {} }).decision, "allowed");
  assert.equal(authorizeAction(baseBot("full"), "github.public.write", githubArgs).decision, "denied");
});

test("rejected execution action makes zero provider calls and fails its persistent task", async (t) => {
  const client = await fixture(t); const bot = baseBot("ask"); let calls = 0;
  let run = await createExecutionRun(client, { name: "Rejected read", executionMode: "live", tasks: [{ key: "read", title: "Read repository", agentId: bot.id, input: { externalAction: { operation: "github.public.read", arguments: githubArgs } } }] });
  await prepareExecutionActions(client, run, [bot]); run = await getExecutionRun(client, run.id);
  assert.equal(run.tasks[0].status, "blocked");
  let action = await getExecutionTaskAction(client, run.tasks[0].id);
  action = await decideAction(client, action.id, "reject");
  const unchanged = await executeApprovedAction(client, action.id, bot, { githubRead: async () => { calls++; return {}; } });
  await synchronizeExecutionAction(client, unchanged);
  run = await getExecutionRun(client, run.id);
  assert.equal(calls, 0); assert.equal(unchanged.invocationCount, 0); assert.equal(run.tasks[0].status, "failed");
});

test("approved integration result becomes task output, reaches dependencies, and invokes once", async (t) => {
  const client = await fixture(t); const bot = baseBot("ask"); let calls = 0;
  let run = await createExecutionRun(client, { name: "Approved read", executionMode: "live", tasks: [
    { key: "read", title: "Read repository", agentId: bot.id, input: { externalAction: { operation: "github.public.read", arguments: githubArgs } } },
    { key: "analyze", title: "Analyze repository", agentId: bot.id, dependsOn: ["read"], input: { instructions: "Analyze the bounded result." } },
  ] });
  await prepareExecutionActions(client, run, [bot]); run = await getExecutionRun(client, run.id);
  const readTask = run.tasks.find((task) => task.title === "Read repository"); let action = await getExecutionTaskAction(client, readTask.id);
  await startExecutionRun(client, run.id, { retrySafety: "never", execute: async () => assert.fail("blocked action must not execute") });
  await settle(client, run.id);
  await decideAction(client, action.id, "approve");
  const handlers = { githubRead: async (args) => { calls++; assert.deepEqual(args, githubArgs); return { integration: "github", repository: args.repository, stars: 42 }; } };
  await Promise.all([executeApprovedAction(client, action.id, bot, handlers), executeApprovedAction(client, action.id, bot, handlers)]);
  action = await getExecutionTaskAction(client, readTask.id);
  assert.equal(calls, 1); assert.equal(action.invocationCount, 1); assert.equal(action.status, "succeeded");
  const link = await synchronizeExecutionAction(client, action); assert.equal(link.shouldResume, true);
  const executor = { retrySafety: "never", execute: async (task, context) => {
    if (task.id === readTask.id) return executeTaskExternalAction(client, task, bot, handlers);
    return { analyzed: true, received: context.dependencies.map((dependency) => dependency.output) };
  } };
  await startExecutionRun(client, run.id, executor); run = await settle(client, run.id);
  assert.equal(run.status, "completed");
  assert.equal(run.tasks.find((task) => task.title === "Read repository").output.result.stars, 42);
  assert.equal(run.tasks.find((task) => task.title === "Analyze repository").output.received[0].result.repository, githubArgs.repository);
  assert.equal(calls, 1, "task replay uses the persisted action result instead of calling GitHub twice");
});

test("Controlled Access executes an assigned MCP read task without exposing arbitrary tools", async (t) => {
  const client = await fixture(t); let calls = 0;
  const bot = baseBot("controlled", { preapprovedOperations: ["mcp.read.invoke"], allowedDestinations: [], maxActionsPerDay: 5 });
  const mcpArgs = { serverId: "demo", tool: "get_synthetic_product", input: { sku: "DEMO-100" } };
  let run = await createExecutionRun(client, { name: "Synthetic MCP read", executionMode: "live", tasks: [{ key: "mcp", title: "Read synthetic product", agentId: bot.id, input: { externalAction: { operation: "mcp.read.invoke", arguments: mcpArgs } } }] });
  await prepareExecutionActions(client, run, [bot]); run = await getExecutionRun(client, run.id);
  assert.equal(run.tasks[0].status, "pending");
  const handlers = { mcpRead: async (args) => { calls++; assert.deepEqual(args, mcpArgs); return { synthetic: true, sku: args.input.sku, price: 120 }; } };
  await startExecutionRun(client, run.id, { retrySafety: "never", execute: (task) => executeTaskExternalAction(client, task, bot, handlers) });
  run = await settle(client, run.id);
  assert.equal(run.status, "completed"); assert.equal(calls, 1);
  assert.deepEqual(run.tasks[0].output.result, { synthetic: true, sku: "DEMO-100", price: 120 });
});
