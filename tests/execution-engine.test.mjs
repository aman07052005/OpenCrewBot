import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createClient } from "@libsql/client";
import { migrateExecutionSchema } from "../src/lib/server/execution-schema.ts";
import {
  approveExecutionTask,
  cancelExecutionRun,
  claimNextExecutionTask,
  createExecutionRun,
  deterministicMockExecutor,
  getExecutionRun,
  listExecutionRuns,
  recoverExecutionRuns,
  rejectExecutionTask,
  startExecutionRun,
} from "../src/lib/server/execution-engine.ts";

async function fixture(t, migrate = true) {
  const client = createClient({ url: "file::memory:" });
  if (migrate) await migrateExecutionSchema(client);
  t.after(async () => {
    await client.close();
  });
  return {
    client,
  };
}

async function waitFor(check, message = "condition was not reached", timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

const executor = (execute, retrySafety = "never") => ({ retrySafety, execute });

async function runUntilSettled(client, id, taskExecutor = deterministicMockExecutor) {
  await startExecutionRun(client, id, taskExecutor);
  await waitFor(async () => {
    const run = await getExecutionRun(client, id);
    return ["blocked", "completed", "failed", "cancelled"].includes(run.status);
  }, `run ${id} did not settle`);
  await waitFor(() => !globalThis.__opencrewbotExecutionJobs?.has(id), `scheduler for ${id} did not stop`);
  return getExecutionRun(client, id);
}

test("additive migration preserves existing application tables and is idempotent", async (t) => {
  const f = await fixture(t, false);
  await f.client.execute("CREATE TABLE bots (id TEXT PRIMARY KEY)");
  await migrateExecutionSchema(f.client);
  const tables = await f.client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const names = new Set(tables.rows.map((row) => row.name));
  assert.ok(names.has("bots"));
  assert.ok(names.has("execution_runs"));
  assert.ok(names.has("execution_tasks"));
  assert.ok(names.has("execution_task_dependencies"));
  assert.equal((await f.client.execute("SELECT COUNT(*) AS n FROM schema_migrations")).rows[0].n, 2);
});

test("creation validates circular, missing, and duplicate dependencies", async (t) => {
  const { client } = await fixture(t);
  const base = { name: "invalid graph", tasks: [
    { key: "a", title: "A", agentId: "bot-a", dependsOn: ["b"] },
    { key: "b", title: "B", agentId: "bot-b", dependsOn: ["a"] },
  ] };
  await assert.rejects(createExecutionRun(client, base), /circular dependency/);
  await assert.rejects(createExecutionRun(client, { ...base, tasks: [{ key: "a", title: "A", agentId: "bot-a", dependsOn: ["missing"] }] }), /invalid dependency/);
  await assert.rejects(createExecutionRun(client, { ...base, tasks: [{ key: "a", title: "A", agentId: "bot-a" }, { key: "a", title: "A2", agentId: "bot-a" }] }), /unique/);
});

test("execution history supports stable offset pages without dropping stored runs", async (t) => {
  const { client } = await fixture(t);
  const created = await Promise.all(["first", "second", "third"].map((name) => createExecutionRun(client, {
    name,
    tasks: [{ key: "task", title: name, agentId: "bot-a" }],
  })));
  for (const [index, run] of created.entries()) {
    await client.execute({ sql: "UPDATE execution_runs SET created_at=? WHERE id=?", args: [`2026-01-0${index + 1}T00:00:00.000Z`, run.id] });
  }
  const firstPage = await listExecutionRuns(client, 2, 0);
  const secondPage = await listExecutionRuns(client, 2, 2);
  assert.equal(firstPage.length, 2);
  assert.equal(secondPage.length, 1);
  assert.equal(new Set([...firstPage, ...secondPage].map((run) => run.id)).size, 3);
  assert.deepEqual(new Set([...firstPage, ...secondPage].map((run) => run.id)), new Set(created.map((run) => run.id)));

  const inserted = await createExecutionRun(client, { name: "inserted later", tasks: [{ key: "task", title: "later", agentId: "bot-a" }] });
  await client.execute({ sql: "UPDATE execution_runs SET created_at=? WHERE id=?", args: ["2099-01-01T00:00:00.000Z", inserted.id] });
  const refreshedFirstPage = await listExecutionRuns(client, 2);
  const cursor = refreshedFirstPage.at(-1);
  const cursorPage = await listExecutionRuns(client, 2, 0, { createdAt: cursor.createdAt, id: cursor.id });
  assert.equal(cursorPage.length, 2);
  assert.equal(new Set([...refreshedFirstPage, ...cursorPage].map((run) => run.id)).size, 4);
  assert.ok(refreshedFirstPage.some((run) => run.id === inserted.id));
});

test("scheduler honors dependencies, runs independent work in parallel, and persists output", async (t) => {
  const { client } = await fixture(t);
  const run = await createExecutionRun(client, {
    name: "dependency and parallelism",
    concurrencyLimit: 2,
    tasks: [
      { key: "research", title: "Research", agentId: "bot-scout", input: { topic: "birds" } },
      { key: "draft", title: "Draft", agentId: "bot-quill" },
      { key: "review", title: "Review", agentId: "bot-atlas", dependsOn: ["research"] },
    ],
  });
  let active = 0;
  let maximum = 0;
  const completed = [];
  const result = await runUntilSettled(client, run.id, executor(async (task) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 35));
    active--;
    completed.push(task.title);
    return { task: task.title };
  }));
  assert.equal(result.status, "completed");
  assert.ok(maximum <= 2);
  assert.equal(maximum, 2);
  assert.ok(completed.indexOf("Research") < completed.indexOf("Review"));
  assert.deepEqual(result.tasks.find((task) => task.title === "Review").dependencies, [result.tasks.find((task) => task.title === "Research").id]);
  assert.deepEqual(result.tasks.find((task) => task.title === "Research").output, { task: "Research" });
  assert.ok(result.tasks.every((task) => task.status === "succeeded"));
});

test("atomic task claiming lets only one worker claim a task", async (t) => {
  const { client } = await fixture(t);
  const run = await createExecutionRun(client, { name: "claim once", tasks: [{ key: "only", title: "One task", agentId: "bot-a" }] });
  await client.execute("UPDATE execution_runs SET status='running' WHERE id=?", [run.id]);
  const claims = await Promise.all([
    claimNextExecutionTask(client, run.id),
    claimNextExecutionTask(client, run.id),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal((await getExecutionRun(client, run.id)).tasks[0].attempts, 1);
});

test("retries errors and propagates exhausted failures to dependent tasks", async (t) => {
  const { client } = await fixture(t);
  const run = await createExecutionRun(client, { name: "retry and propagation", concurrencyLimit: 2, tasks: [
    { key: "retry", title: "Retry me", agentId: "bot-a", maxAttempts: 2 },
    { key: "fail", title: "Fail me", agentId: "bot-a", maxAttempts: 2 },
    { key: "blocked-child", title: "Dependent", agentId: "bot-b", dependsOn: ["fail"] },
  ] });
  const attempts = new Map();
  const idempotencyKeys = new Map();
  const result = await runUntilSettled(client, run.id, executor(async (task, { idempotencyKey }) => {
    const keys = idempotencyKeys.get(task.title) ?? [];
    keys.push(idempotencyKey);
    idempotencyKeys.set(task.title, keys);
    const count = (attempts.get(task.title) ?? 0) + 1;
    attempts.set(task.title, count);
    if (task.title === "Retry me" && count === 1) throw new Error("temporary");
    if (task.title === "Fail me") throw new Error("permanent");
    return { ok: true };
  }, "idempotent"));
  assert.equal(result.status, "failed");
  assert.equal(result.tasks.find((task) => task.title === "Retry me").attempts, 2);
  assert.equal(result.tasks.find((task) => task.title === "Retry me").status, "succeeded");
  assert.equal(new Set(idempotencyKeys.get("Retry me")).size, 1);
  assert.equal(result.tasks.find((task) => task.title === "Fail me").status, "failed");
  assert.equal(result.tasks.find((task) => task.title === "Dependent").status, "skipped");
  assert.match(result.tasks.find((task) => task.title === "Fail me").error, /permanent/);
});

test("unknown retry safety never retries an executor that may have side effects", async (t) => {
  const { client } = await fixture(t);
  const run = await createExecutionRun(client, { name: "no unsafe retry", tasks: [{ key: "effect", title: "Possibly external", agentId: "bot-a", maxAttempts: 5 }] });
  let sideEffectCalls = 0;
  const result = await runUntilSettled(client, run.id, executor(async () => {
    sideEffectCalls++;
    throw new Error("response lost after a possible side effect");
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.tasks[0].attempts, 1);
  assert.equal(sideEffectCalls, 1);
});

test("approval tasks remain blocked until authorized, then resume dependencies", async (t) => {
  const { client } = await fixture(t);
  const created = await createExecutionRun(client, { name: "approval gate", tasks: [
    { key: "approved", title: "Needs approval", agentId: "bot-a", requiresApproval: true },
    { key: "after", title: "After approval", agentId: "bot-b", dependsOn: ["approved"] },
    { key: "independent", title: "Independent", agentId: "bot-c" },
  ] });
  const blocked = await runUntilSettled(client, created.id);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.tasks.find((task) => task.title === "Needs approval").status, "blocked");
  assert.equal(blocked.tasks.find((task) => task.title === "After approval").status, "pending");
  assert.equal(blocked.tasks.find((task) => task.title === "Independent").status, "succeeded");

  const gated = blocked.tasks.find((task) => task.title === "Needs approval");
  const approved = await approveExecutionTask(client, created.id, gated.id, deterministicMockExecutor);
  assert.ok(approved.approvedAt);
  await waitFor(async () => (await getExecutionRun(client, created.id)).status === "completed");
  await waitFor(() => !globalThis.__opencrewbotExecutionJobs?.has(created.id));
  const finished = await getExecutionRun(client, created.id);
  assert.equal(finished.tasks.find((task) => task.title === "Needs approval").status, "succeeded");
  assert.equal(finished.tasks.find((task) => task.title === "After approval").status, "succeeded");
  assert.equal(await approveExecutionTask(client, created.id, gated.id, deterministicMockExecutor), null);
});

test("rejected approval permanently prevents execution and skips dependents", async (t) => {
  const { client } = await fixture(t);
  const created = await createExecutionRun(client, { name: "reject approval", tasks: [
    { key: "gated", title: "Approval required", agentId: "bot-a", requiresApproval: true },
    { key: "child", title: "Dependent task", agentId: "bot-b", dependsOn: ["gated"] },
  ] });
  const blocked = await runUntilSettled(client, created.id);
  const gated = blocked.tasks.find((task) => task.title === "Approval required");
  const rejected = await rejectExecutionTask(client, created.id, gated.id, deterministicMockExecutor);
  assert.equal(rejected.status, "failed");
  await waitFor(async () => (await getExecutionRun(client, created.id)).status === "failed");
  await waitFor(() => !globalThis.__opencrewbotExecutionJobs?.has(created.id));
  assert.equal(await approveExecutionTask(client, created.id, gated.id, deterministicMockExecutor), null);
  const finished = await getExecutionRun(client, created.id);
  assert.equal(finished.tasks.find((task) => task.id === gated.id).status, "failed");
  assert.match(finished.tasks.find((task) => task.id === gated.id).error, /rejected/);
  assert.equal(finished.tasks.find((task) => task.id === gated.id).output, null);
  assert.equal(finished.tasks.find((task) => task.title === "Dependent task").status, "skipped");
});

test("cancellation stops active work and timeout failures consume retry budget", async (t) => {
  const { client } = await fixture(t);
  const cancellable = await createExecutionRun(client, { name: "cancel", tasks: [{ key: "wait", title: "Wait", agentId: "bot-a" }] });
  await startExecutionRun(client, cancellable.id, executor(async () => new Promise((resolve) => setTimeout(() => resolve({ late: true }), 80))));
  await waitFor(async () => (await getExecutionRun(client, cancellable.id)).tasks[0].status === "running");
  assert.equal(await cancelExecutionRun(client, cancellable.id), true);
  await waitFor(async () => (await getExecutionRun(client, cancellable.id)).tasks[0].status === "cancelled");
  await waitFor(() => !globalThis.__opencrewbotExecutionJobs?.has(cancellable.id));
  await new Promise((resolve) => setTimeout(resolve, 90));
  const afterLateCancel = await getExecutionRun(client, cancellable.id);
  assert.equal(afterLateCancel.status, "cancelled");
  assert.equal(afterLateCancel.tasks[0].status, "cancelled");
  assert.equal(afterLateCancel.tasks[0].output, null);

  const timed = await createExecutionRun(client, { name: "timeout", tasks: [{ key: "slow", title: "Slow", agentId: "bot-a", timeoutMs: 15, maxAttempts: 2 }] });
  const attempts = [];
  const failed = await runUntilSettled(client, timed.id, executor(() => {
    attempts.push(true);
    return new Promise((resolve) => setTimeout(() => resolve({ late: true }), 80));
  }, "idempotent"));
  assert.equal(failed.tasks[0].status, "failed");
  assert.equal(failed.tasks[0].attempts, 2);
  assert.equal(attempts.length, 2);
  assert.match(failed.tasks[0].error, /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 90));
  const afterLateTimeout = await getExecutionRun(client, timed.id);
  assert.equal(afterLateTimeout.tasks[0].status, "failed");
  assert.equal(afterLateTimeout.tasks[0].output, null);
});

test("on-disk persistence, restart recovery, and legacy application data compatibility", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "opencrewbot-execution-restart-"));
  const dbUrl = pathToFileURL(join(dir, "opencrewbot.db")).href;
  const memoryDir = join(dir, "workspaces", "bot-a");
  await mkdir(memoryDir, { recursive: true });
  const memoryText = "# Notes\n- Keep short answers.\n";
  await writeFile(join(memoryDir, "MEMORY.md"), memoryText, "utf8");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const root = fileURLToPath(new URL("../", import.meta.url));
  const engineUrl = pathToFileURL(resolve(root, "src/lib/server/execution-engine.ts")).href;
  const schemaUrl = pathToFileURL(resolve(root, "src/lib/server/execution-schema.ts")).href;
  const launch = (source) => {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message || "child process failed");
    return JSON.parse(child.stdout.trim());
  };

  const created = launch(`
    import assert from "node:assert/strict";
    import { createClient } from "@libsql/client";
    import { migrateExecutionSchema } from ${JSON.stringify(schemaUrl)};
    import { claimNextExecutionTask, createExecutionRun } from ${JSON.stringify(engineUrl)};
    const client = createClient({ url: ${JSON.stringify(dbUrl)} });
    await client.batch([
      "CREATE TABLE bots (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
      "CREATE TABLE rooms (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
      "CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL)",
      "CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)",
      "CREATE TABLE conversations (id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0, last_read_at TEXT)"
    ], "write");
    await client.execute({sql:"INSERT INTO bots VALUES (?,?)",args:["bot-a",JSON.stringify({id:"bot-a",name:"Legacy bot"})]});
    await client.execute({sql:"INSERT INTO rooms VALUES (?,?)",args:["room-a",JSON.stringify({id:"room-a",name:"Legacy room"})]});
    await client.execute({sql:"INSERT INTO messages VALUES (?,?,?,?)",args:["message-a","dm:bot-a","2026-01-01T00:00:00.000Z",JSON.stringify({id:"message-a",role:"user"})]});
    await client.execute({sql:"INSERT INTO conversations VALUES (?,?,?)",args:["dm:bot-a",4,"2026-01-01T00:00:00.000Z"]});
    await client.execute({sql:"INSERT INTO settings VALUES (?,?)",args:["legacy","true"]});
    await migrateExecutionSchema(client);
    const run = await createExecutionRun(client,{name:"interrupted",tasks:[{key:"persisted",title:"Persisted task",agentId:"bot-a",maxAttempts:3}]});
    const taskId = run.tasks[0].id;
    await client.execute("UPDATE execution_runs SET status='running',started_at=? WHERE id=?",[new Date().toISOString(),run.id]);
    const secondWorker = createClient({ url: ${JSON.stringify(dbUrl)} });
    const claims = await Promise.all([claimNextExecutionTask(client,run.id),claimNextExecutionTask(secondWorker,run.id)]);
    assert.equal(claims.filter(Boolean).length,1);
    assert.equal((await client.execute("SELECT attempts FROM execution_tasks WHERE id=?",[taskId])).rows[0].attempts,1);
    secondWorker.close();
    client.close();
    console.log(JSON.stringify({runId:run.id,taskId,concurrentClaims:claims.filter(Boolean).length}));
  `);

  const recovered = launch(`
    import assert from "node:assert/strict";
    import { createClient } from "@libsql/client";
    import { migrateExecutionSchema } from ${JSON.stringify(schemaUrl)};
    import { deterministicMockExecutor, getExecutionRun, recoverExecutionRuns } from ${JSON.stringify(engineUrl)};
    const client = createClient({ url: ${JSON.stringify(dbUrl)} });
    await migrateExecutionSchema(client);
    const before = await getExecutionRun(client, ${JSON.stringify(created.runId)});
    assert.equal(before.tasks[0].id, ${JSON.stringify(created.taskId)});
    assert.equal(before.tasks[0].status, "running");
    const bot = await client.execute("SELECT data FROM bots WHERE id='bot-a'");
    const room = await client.execute("SELECT data FROM rooms WHERE id='room-a'");
    const message = await client.execute("SELECT data FROM messages WHERE id='message-a'");
    const conversation = await client.execute("SELECT generation FROM conversations WHERE id='dm:bot-a'");
    const setting = await client.execute("SELECT data FROM settings WHERE key='legacy'");
    await recoverExecutionRuns(client, () => deterministicMockExecutor);
    const until = Date.now() + 3000;
    let run;
    do {
      run = await getExecutionRun(client, ${JSON.stringify(created.runId)});
      if (run.status === "completed") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < until);
    assert.equal(run.status, "completed");
    assert.equal(run.tasks[0].attempts, 2);
    assert.equal(run.tasks[0].output.label, "SIMULATED OUTPUT — deterministic mock executor");
    client.close();
    console.log(JSON.stringify({run,bot:JSON.parse(bot.rows[0].data),room:JSON.parse(room.rows[0].data),message:JSON.parse(message.rows[0].data),generation:Number(conversation.rows[0].generation),setting:setting.rows[0].data}));
  `);

  assert.equal(recovered.bot.name, "Legacy bot");
  assert.equal(recovered.room.name, "Legacy room");
  assert.equal(recovered.message.role, "user");
  assert.equal(recovered.generation, 4);
  assert.equal(recovered.setting, "true");
  assert.equal(await readFile(join(memoryDir, "MEMORY.md"), "utf8"), memoryText);
  assert.equal(created.concurrentClaims, 1);
});

test("execution API routes remain covered by localhost and same-origin proxy checks", async () => {
  const proxySource = await readFile(new URL("../src/proxy.ts", import.meta.url), "utf8");
  assert.match(proxySource, /matcher:\s*"\/api\/:path\*"/);
  assert.match(proxySource, /LOCAL_HOSTS\s*=\s*new Set\(\["localhost", "127\.0\.0\.1"/);
  assert.match(proxySource, /site !== "same-origin" && site !== "none"/);
  assert.match(proxySource, /originHost !== host/);
  const routes = [
    "../src/app/api/execution-runs/route.ts",
    "../src/app/api/execution-runs/[id]/route.ts",
    "../src/app/api/execution-runs/[id]/start/route.ts",
    "../src/app/api/execution-runs/[id]/cancel/route.ts",
    "../src/app/api/execution-runs/[id]/tasks/[taskId]/approve/route.ts",
    "../src/app/api/execution-runs/[id]/tasks/[taskId]/reject/route.ts",
  ];
  for (const route of routes) {
    assert.match(route.replaceAll("\\", "/"), /^\.\.\/src\/app\/api\//);
    assert.ok((await readFile(new URL(route, import.meta.url), "utf8")).includes("handle("));
  }
});

test("live execution mode is persisted and interrupted live work is never replayed", async (t) => {
  const { client } = await fixture(t);
  const run = await createExecutionRun(client, { executionMode: "live", name: "live no replay", tasks: [{ key: "task", title: "May have reached model", agentId: "bot-a", maxAttempts: 5 }] });
  assert.equal(run.executionMode, "live");
  await client.execute("UPDATE execution_runs SET status='running' WHERE id=?", [run.id]);
  await client.execute("UPDATE execution_tasks SET status='running',attempts=1,claim_token='interrupted-live' WHERE id=?", [run.tasks[0].id]);
  let executorCalls = 0;
  await recoverExecutionRuns(client, (mode) => {
    assert.equal(mode, "live");
    return { retrySafety: "never", execute: async () => { executorCalls++; return { unexpected: true }; } };
  });
  await waitFor(async () => (await getExecutionRun(client, run.id)).status === "failed");
  await waitFor(() => !globalThis.__opencrewbotExecutionJobs?.has(run.id));
  const recovered = await getExecutionRun(client, run.id);
  assert.equal(recovered.executionMode, "live");
  assert.equal(recovered.tasks[0].attempts, 1);
  assert.equal(recovered.tasks[0].status, "failed");
  assert.match(recovered.tasks[0].error, /not retried/);
  assert.equal(executorCalls, 0);
});
