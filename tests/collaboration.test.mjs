import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateExecutionSchema } from "../src/lib/server/execution-schema.ts";
import { migrateCollaborationSchema } from "../src/lib/server/collaboration-schema.ts";
import { approveExecutionTask, cancelExecutionRun, deterministicMockExecutor, getExecutionRun, rejectExecutionTask, startExecutionRun } from "../src/lib/server/execution-engine.ts";
import { advanceSession, advanceAutomatically, assertAutomaticParticipants, automaticSessionIds, beginRevision, discardRevision, setAutomaticAdvance, assertParticipants, closeSession, continueSession, createSession, getSession, listSessions, requestTasks, resumeSession } from "../src/lib/server/collaboration-store.ts";
import { collaborationContext, readRequests, validRequest } from "../src/lib/server/collaboration-protocol.ts";
import { buildExecutionPrompt, createMastraTaskExecutor } from "../src/lib/server/execution-task-executor.ts";

// Real SQLite via Node's built-in driver. The tiny adapter implements the two
// libSQL client operations used by the engine; production still uses libSQL.
function sqlite(path = ":memory:") {
  const db = new DatabaseSync(path);
  const execute = (statement) => {
    const { sql, args = [] } = typeof statement === "string" ? { sql: statement } : statement;
    const stmt = db.prepare(sql);
    if (stmt.columns().length) {
      const rows = stmt.all(...args);
      return { rows, rowsAffected: /\bRETURNING\b/i.test(sql) ? rows.length : 0 };
    }
    return { rows: [], rowsAffected: Number(stmt.run(...args).changes) };
  };
  return {
    execute: async (s) => execute(s),
    batch: async (statements) => {
      db.exec("BEGIN IMMEDIATE");
      try { const result = statements.map(execute); db.exec("COMMIT"); return result; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    close: () => db.close(),
  };
}
const bot = (id, title) => ({ id, name: id, handle: id, title, description: title, instructions: "Be precise.", model: "example/model", emoji: "", color: "", tools: { webSearch: false, memory: false, codeMode: false, browser: false, askUser: false }, connections: [], approval: "ask", pinned: false, createdAt: "2026-01-01T00:00:00Z" });
const members = [bot("scout", "Research"), bot("nova", "Analysis"), bot("sentinel", "Quality verification")];
const planTask = (key, agentId, dependsOn = [], isFinalConsolidation = false) => ({ key, title: key, instructions: `Complete ${key}`, agentId, dependsOn, rationale: "Test plan", isFinalConsolidation });
const draft = { instruction: "Research alternatives and compare them", mode: "mock", memberIds: members.map((b) => b.id), plan: { rationale: "Test plan", planningMode: "mock", planningLabel: "MOCK", tasks: [planTask("research", "scout"), planTask("analysis", "nova"), planTask("final-deliverable", "nova", ["research", "analysis"], true)] } };
async function setup(t, client = sqlite()) {
  await migrateExecutionSchema(client);
  await migrateCollaborationSchema(client);
  t.after(() => client.close());
  return client;
}
async function settle(client, id, executor = deterministicMockExecutor, start = true) {
  if (start) await startExecutionRun(client, id, executor);
  for (let n = 0; n < 300; n++) {
    const run = await getExecutionRun(client, id);
    if (["completed", "blocked", "failed", "cancelled"].includes(run.status) && !globalThis.__opencrewbotExecutionJobs?.has(id)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Run ${id} did not settle`);
}
const latest = (s) => s.rounds.at(-1).run;

test("collaboration schema preserves tables and participants must be distinct existing room members", async (t) => {
  const client = await setup(t);
  await client.execute("CREATE TABLE rooms(id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  await migrateCollaborationSchema(client);
  assert.deepEqual(assertParticipants(["scout", "nova"], draft.memberIds, members).map((b) => b.id), ["scout", "nova"]);
  assert.throws(() => assertParticipants(["scout", "scout"], draft.memberIds, members), /distinct/);
  assert.throws(() => assertParticipants(["scout", "sentinel"], ["scout", "nova"], members), /not a current room member/);
  assert.equal((await client.execute("SELECT COUNT(*) n FROM schema_migrations")).rows[0].n, 3);
});

test("persistent mock collaboration executes work, bounded requests, review, and final using prior outputs", async (t) => {
  const client = await setup(t);
  let session = await createSession(client, "room-1", draft, members);
  assert.equal(session.status, "pending");
  assert.equal(latest(session).tasks.length, 2);
  await settle(client, latest(session).id);
  session = await getSession(client, session.id);
  assert.equal(session.status, "awaiting_next");
  assert.ok(session.messages.some((m) => m.type === "question"));
  assert.ok(session.messages.some((m) => m.type === "verification_request"));
  const workIds = latest(session).tasks.map((t) => t.id);
  session = await advanceSession(client, session, members);
  assert.equal(session.rounds.at(-1).phase, "requests");
  assert.ok(latest(session).tasks.every((t) => t.requiresApproval && t.status === "blocked"));
  const blocked = await settle(client, latest(session).id);
  assert.equal(blocked.status, "blocked");
  for (const task of blocked.tasks) await approveExecutionTask(client, blocked.id, task.id, deterministicMockExecutor);
  await settle(client, blocked.id, deterministicMockExecutor, false);
  session = await getSession(client, session.id);
  assert.equal(session.status, "awaiting_next");
  assert.ok(session.messages.some((m) => m.type === "answer"));
  const requestIds = latest(session).tasks.map((t) => t.id);
  assert.ok(latest(session).tasks.every((t) => workIds.every((id) => t.output.receivedTaskIds.includes(id))));
  session = await advanceSession(client, session, members);
  assert.equal(session.rounds.at(-1).phase, "review");
  assert.equal(latest(session).tasks[0].agentId, "sentinel");
  await settle(client, latest(session).id);
  session = await getSession(client, session.id);
  const reviewId = latest(session).tasks[0].id;
  session = await advanceSession(client, session, members);
  await settle(client, latest(session).id);
  session = await getSession(client, session.id);
  assert.equal(session.status, "completed");
  assert.equal(session.finalDeliverable.simulated, true);
  assert.ok([...workIds, ...requestIds, reviewId].every((id) => session.finalDeliverable.receivedTaskIds.includes(id)));
  assert.equal((await listSessions(client, "room-1")).length, 1);
  await assert.rejects(advanceSession(client, session, members), /Finish the current stage/);
});

test("request protocol rejects extra keys, self and unknown recipients, limits and duplicate proposals", async (t) => {
  const client = await setup(t);
  const fence = (value) => `\`\`\`collaboration-request\n${JSON.stringify(value)}\n\`\`\``;
  const valid = { type: "delegation", recipientId: "sentinel", content: "Check the evidence" };
  assert.equal(readRequests(fence({ ...valid, permissions: "full" })).invalid, 1);
  assert.equal(readRequests(`${fence(valid)}\n${fence(valid)}`).invalid, 1);
  assert.equal(validRequest(valid, "sentinel", draft.memberIds), false);
  assert.equal(validRequest({ ...valid, recipientId: "outsider" }, "scout", draft.memberIds), false);
  let session = await createSession(client, "room-1", draft, members);
  await settle(client, latest(session).id, { retrySafety: "never", execute: async () => ({ text: fence(valid) }) });
  session = await getSession(client, session.id);
  assert.equal(requestTasks(session, members).length, 1);
  const next = await advanceSession(client, session, members);
  assert.equal(latest(next).tasks.length, 1);
  await assert.rejects(advanceSession(client, session, members), /UNIQUE|constraint/i);
  assert.equal((await getSession(client, session.id)).rounds.length, 2);
  assert.equal((await client.execute("SELECT COUNT(*) n FROM execution_runs")).rows[0].n, 2, "failed link rolls back entire execution run");
});

test("rejected delegation never starts and session does not silently advance", async (t) => {
  const client = await setup(t);
  let session = await createSession(client, "room-1", draft, members);
  await settle(client, latest(session).id);
  session = await advanceSession(client, await getSession(client, session.id), members);
  const blocked = await settle(client, latest(session).id);
  for (const task of blocked.tasks) await rejectExecutionTask(client, blocked.id, task.id, deterministicMockExecutor);
  const failed = await settle(client, blocked.id, deterministicMockExecutor, false);
  assert.equal(failed.status, "failed");
  assert.ok(failed.tasks.every((t) => t.attempts === 0 && t.output === null));
  session = await getSession(client, session.id);
  assert.equal(session.status, "failed");
  await assert.rejects(advanceSession(client, session, members), /Finish the current stage/);
});

test("interrupting before start safely resumes never-started tasks and preserves history", async (t) => {
  const client = await setup(t);
  let session = await createSession(client, "room-1", draft, members);
  await cancelExecutionRun(client, latest(session).id);
  session = await getSession(client, session.id);
  assert.equal(session.status, "interrupted");
  session = await resumeSession(client, session);
  assert.equal(session.rounds.length, 2);
  assert.equal(session.status, "pending");
  assert.ok(latest(session).tasks.every((t) => t.attempts === 0));
  await cancelExecutionRun(client, latest(session).id);
  session = await getSession(client, session.id);
  await closeSession(client, session);
  assert.equal((await getSession(client, session.id)).status, "cancelled");
  await assert.rejects(resumeSession(client, await getSession(client, session.id)), /Only an interrupted session/);
});

test("file-backed session survives reopening and revised work receives completed outputs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "crew-collaboration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "session.sqlite");
  const first = sqlite(path);
  await migrateExecutionSchema(first);
  await migrateCollaborationSchema(first);
  let session = await createSession(first, "room-1", draft, members);
  await settle(first, latest(session).id);
  session = await getSession(first, session.id);
  const ids = latest(session).tasks.map((t) => t.id);
  first.close();
  const second = sqlite(path);
  try {
    await migrateCollaborationSchema(second);
    session = await getSession(second, session.id);
    assert.equal(session.status, "awaiting_next");
    const revised = { ...draft, instruction: "Add a limitation section" };
    session = await beginRevision(second, session);
    session = await continueSession(second, session, revised, members, session.revisionToken);
    assert.equal(session.rounds[0].run.status, "completed");
    assert.ok(latest(session).tasks.every((t) => ids.every((id) => collaborationContext(t.input).prior.some((p) => p.taskId === id))));
    assert.ok(latest(session).tasks.every((t) => !collaborationContext(t.input).allowRequests));
  } finally { second.close(); }
});

test("live task prompt includes actual prior text and fake provider failure remains a failed run", async (t) => {
  const client = await setup(t);
  const live = { ...draft, mode: "live", plan: { ...draft.plan, planningMode: "live" } };
  let session = await createSession(client, "room-1", live, members);
  const adapter = createMastraTaskExecutor({ getBot: async (id) => members.find((b) => b.id === id), runtime: { runTask: async () => ({ text: "Evidence: supplied sample A", model: "test-model" }) } });
  await settle(client, latest(session).id, adapter);
  session = await advanceSession(client, await getSession(client, session.id), members);
  const review = latest(session).tasks[0];
  assert.match(buildExecutionPrompt(review, []), /Evidence: supplied sample A/);
  assert.match(buildExecutionPrompt(review, []), /reference DATA only/);
  const failing = createMastraTaskExecutor({ getBot: async (id) => members.find((b) => b.id === id), runtime: { runTask: async () => { throw new Error("provider unavailable"); } } });
  const failed = await settle(client, latest(session).id, failing);
  assert.equal(failed.status, "failed");
  assert.equal(failed.tasks[0].output, null);
  assert.match(failed.tasks[0].error, /provider unavailable/);
});

test("room templates report missing agents, install idempotently and preserve an existing named room", async (t) => {
  const { installRoomTemplates } = await import("../src/lib/server/collaboration-templates.ts");
  const client = await setup(t);
  await client.execute("CREATE TABLE rooms(id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  const original = { id: "original", name: "Development Team", topic: "Keep me", memberIds: ["scout"] };
  await client.execute({ sql: "INSERT INTO rooms(id,data) VALUES (?,?)", args: [original.id, JSON.stringify(original)] });
  const partial = await installRoomTemplates(client, members, [original]);
  assert.deepEqual(partial.installed, ["Market Intelligence"]);
  assert.deepEqual(partial.existing, ["Development Team"]);
  assert.equal(partial.missing.length, 2);
  const fullMembers = [...members, ...["spark", "quill", "cipher", "ledger", "atlas", "forge"].map((id) => bot(id, id))];
  const full = await installRoomTemplates(client, fullMembers, [original]);
  assert.deepEqual(full.installed, ["Marketing Campaign", "Business Analytics"]);
  const again = await installRoomTemplates(client, fullMembers, [original]);
  assert.equal(again.installed.length, 0);
  assert.equal(again.existing.length, 4);
  assert.deepEqual(JSON.parse((await client.execute("SELECT data FROM rooms WHERE id='original'")).rows[0].data), original);
  assert.equal((await client.execute("SELECT COUNT(*) n FROM rooms")).rows[0].n, 4);
});

test("existing scheduler starts independent room work concurrently and passes sequential prerequisite data", async (t) => {
  const client = await setup(t);
  const withDependency = { ...draft, plan: { ...draft.plan, tasks: [planTask("research", "scout"), planTask("analysis", "nova"), planTask("compare", "sentinel", ["research", "analysis"]), planTask("final-deliverable", "nova", ["research", "analysis", "compare"], true)] } };
  const session = await createSession(client, "room-1", withDependency, members);
  let concurrent = 0;
  let maxConcurrent = 0;
  const seen = new Map();
  const executor = { retrySafety: "never", execute: async (task, context) => {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    seen.set(task.title, context.dependencies.map((d) => d.output.text));
    await new Promise((r) => setTimeout(r, 15));
    concurrent--;
    return { text: `result:${task.title}` };
  } };
  await settle(client, latest(session).id, executor);
  assert.ok(maxConcurrent >= 2);
  assert.deepEqual(seen.get("compare").sort(), ["result:analysis", "result:research"]);
});

test("round budget leaves room for review and final instead of allowing endless continuations", async (t) => {
  const client = await setup(t);
  let s = await createSession(client, "room-1", draft, members);
  const complete = async () => { await settle(client, latest(s).id); s = await getSession(client, s.id); };
  await complete();
  for (let i = 0; i < 5; i++) {
    s = await beginRevision(client, s);
    s = await continueSession(client, s, { ...draft, instruction: `Additional work ${i}` }, members, s.revisionToken);
    await complete();
  }
  assert.equal(s.rounds.length, 6);
  s = await beginRevision(client, s);
  await assert.rejects(continueSession(client, s, draft, members, s.revisionToken), /budget/i);
  s = await discardRevision(client, s, s.revisionToken);
  s = await advanceSession(client, s, members);
  await complete();
  s = await advanceSession(client, s, members);
  await complete();
  assert.equal(s.status, "completed");
  assert.equal(s.rounds.length, 8);
  const finalInput = latest(s).tasks[0].input.originalInstruction;
  assert.match(finalInput, /Research alternatives and compare them/);
  assert.match(finalInput, /Additional work 4/);
});


test("automatic progression is explicit, durable, bounded and never approves agent requests", async (t) => {
  const client = await setup(t);
  let session = await createSession(client, "room-auto", draft, members);
  const start = (id) => startExecutionRun(client, id, deterministicMockExecutor);
  assert.equal(session.autoAdvance, false);
  assert.equal((await automaticSessionIds(client)).length, 0);
  await advanceAutomatically(client, session, members, start);
  assert.equal((await getSession(client, session.id)).status, "pending");
  await setAutomaticAdvance(client, session.id, true);
  session = await getSession(client, session.id);
  assert.equal(session.autoAdvance, true);
  assert.deepEqual(await automaticSessionIds(client), [{ id: session.id, roomId: "room-auto" }]);
  session = await advanceAutomatically(client, session, members, start);
  await settle(client, latest(session).id, deterministicMockExecutor, false);
  session = await advanceAutomatically(client, await getSession(client, session.id), members, start);
  assert.equal(session.rounds.at(-1).phase, "requests");
  const blocked = await settle(client, latest(session).id, deterministicMockExecutor, false);
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.tasks.every((task) => task.requiresApproval && task.attempts === 0));
  await advanceAutomatically(client, await getSession(client, session.id), members, start);
  assert.equal((await getSession(client, session.id)).rounds.length, 2);
  assert.equal((await automaticSessionIds(client)).length, 0);
  for (const task of blocked.tasks) await approveExecutionTask(client, blocked.id, task.id, deterministicMockExecutor);
  await settle(client, blocked.id, deterministicMockExecutor, false);
  await setAutomaticAdvance(client, session.id, false);
  session = await advanceAutomatically(client, await getSession(client, session.id), members, start);
  assert.equal(session.rounds.length, 2, "pause prevents future stages");
  await setAutomaticAdvance(client, session.id, true);
  for (const phase of ["review", "final"]) {
    session = await advanceAutomatically(client, await getSession(client, session.id), members, start);
    assert.equal(session.rounds.at(-1).phase, phase);
    await settle(client, latest(session).id, deterministicMockExecutor, false);
  }
  session = await advanceAutomatically(client, await getSession(client, session.id), members, start);
  assert.equal(session.status, "completed");
  assert.equal(session.autoAdvance, false);
  assert.equal(session.rounds.length, 4);
  assert.ok(session.finalDeliverable);
});

test("opening a revision durably pauses stale automatic scheduling and consumes its lease exactly once", async (t) => {
  const client = await setup(t);
  let session = await createSession(client, "room-revision", draft, members);
  const quiet = { retrySafety: "never", execute: async () => ({ text: "Completed evidence." }) };
  await settle(client, latest(session).id, quiet);
  session = await getSession(client, session.id);
  await setAutomaticAdvance(client, session.id, true);
  let staleAutomaticSnapshot = await getSession(client, session.id);
  await setAutomaticAdvance(client, session.id, false);
  const afterPause = await advanceAutomatically(client, staleAutomaticSnapshot, members, async () => undefined);
  assert.equal(afterPause.rounds.length, 1, "a confirmed pause defeats a scheduler snapshot that was read earlier");
  await setAutomaticAdvance(client, session.id, true);
  staleAutomaticSnapshot = await getSession(client, session.id);

  session = await beginRevision(client, staleAutomaticSnapshot);
  const token = session.revisionToken;
  assert.ok(token);
  assert.equal(session.autoAdvance, false);
  assert.deepEqual(await automaticSessionIds(client), []);
  const afterStaleTick = await advanceAutomatically(client, staleAutomaticSnapshot, members, async (id) => startExecutionRun(client, id, quiet));
  assert.equal(afterStaleTick.rounds.length, 1, "a scheduler snapshot from before the pause cannot append a stage");

  const revised = { ...draft, instruction: "Add a limitations section based on the completed evidence." };
  session = await continueSession(client, session, revised, members, token);
  assert.equal(session.rounds.length, 2);
  assert.equal(session.revisionToken, null);
  assert.equal(session.autoAdvance, false);
  assert.ok(latest(session).tasks.every((task) => task.input.originalInstruction === revised.instruction));
  assert.ok(latest(session).tasks.every((task) => collaborationContext(task.input).prior.some((prior) => prior.text === "Completed evidence.")));
  await assert.rejects(continueSession(client, session, revised, members, token), /no longer current|already saved/i);
  assert.equal((await getSession(client, session.id)).rounds.length, 2, "a stale revision submission cannot create a duplicate stage");
});

test("concurrent automatic ticks coalesce before they can create a duplicate stage", async (t) => {
  const client = await setup(t);
  let session = await createSession(client, "room-auto-race", draft, members);
  const quiet = { retrySafety: "never", execute: async () => ({ text: "Completed evidence." }) };
  await settle(client, latest(session).id, quiet);
  session = await getSession(client, session.id);
  await setAutomaticAdvance(client, session.id, true);
  const snapshot = await getSession(client, session.id);
  const results = await Promise.all(Array.from({ length: 4 }, () => advanceAutomatically(client, snapshot, members, async () => undefined)));
  assert.ok(results.every((result) => result.rounds.length === 2));
  const stored = await getSession(client, session.id);
  assert.equal(stored.rounds.length, 2);
  assert.equal(stored.rounds.at(-1).phase, "review");
});

test("rejected automatic requests stop progression without executing the rejected tasks", async (t) => {
  const client = await setup(t);
  let session = await createSession(client, "room-auto-reject", draft, members);
  const start = (id) => startExecutionRun(client, id, deterministicMockExecutor);
  await setAutomaticAdvance(client, session.id, true);
  session = await advanceAutomatically(client, await getSession(client, session.id), members, start);
  await settle(client, latest(session).id, deterministicMockExecutor, false);
  session = await advanceAutomatically(client, await getSession(client, session.id), members, start);
  const blocked = await settle(client, latest(session).id, deterministicMockExecutor, false);
  for (const task of blocked.tasks) await rejectExecutionTask(client, blocked.id, task.id, deterministicMockExecutor);
  await settle(client, blocked.id, deterministicMockExecutor, false);
  session = await advanceAutomatically(client, await getSession(client, session.id), members, start);
  assert.equal(session.status, "failed");
  assert.equal(session.autoAdvance, false);
  assert.equal(session.rounds.length, 2);
  assert.ok(latest(session).tasks.every((task) => task.attempts === 0 && task.output === null));
});

test("automatic live participation rejects hosted or external-tool agents and stores longer single-worker deadlines", async (t) => {
  const client = await setup(t);
  assert.throws(() => assertAutomaticParticipants("live", members), /local-only Ollama/);
  const local = members.map((b) => ({ ...b, modelConfig: { providerId: "ollama", primaryModel: "qwen3:4b-instruct", routingMode: "fixed", localOnly: true } }));
  assert.doesNotThrow(() => assertAutomaticParticipants("live", local));
  assert.throws(() => assertAutomaticParticipants("live", [{ ...local[0], tools: { ...local[0].tools, webSearch: true } }, local[1]]), /external connections disabled/);
  assert.throws(() => assertAutomaticParticipants("live", [{ ...local[0], modelConfig: { ...local[0].modelConfig, fallbackModels: [{ providerId: "nebius", model: "hosted" }] } }, local[1]]), /local-only Ollama/);
  const session = await createSession(client, "room-live-auto", { ...draft, mode: "live", plan: { ...draft.plan, planningMode: "live" } }, local);
  assert.equal(latest(session).concurrencyLimit, 1);
  assert.ok(latest(session).tasks.every((task) => task.timeoutMs === 300_000));
});
