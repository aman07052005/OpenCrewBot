import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../src/lib/client/api.ts";
import { executionOutputKind, executionProgress, executionTaskCounts } from "../src/lib/client/execution-dashboard.ts";

test("dashboard progress counts successful, failed and skipped tasks as finished", () => {
  const run = {
    id: "run-1",
    name: "Saved run",
    status: "failed",
    concurrencyLimit: 2,
    executionMode: "mock",
    createdAt: "2026-11-13T00:00:00Z",
    updatedAt: "2026-11-13T00:00:00Z",
    startedAt: null,
    finishedAt: null,
    error: null,
    tasks: [
      { status: "succeeded" },
      { status: "failed" },
      { status: "skipped" },
      { status: "pending" },
      { status: "blocked" },
    ],
  };
  assert.deepEqual(executionTaskCounts(run), { pending: 1, blocked: 1, running: 0, succeeded: 1, failed: 1, cancelled: 0, skipped: 1 });
  assert.deepEqual(executionProgress(run), {
    total: 5,
    finished: 3,
    succeeded: 1,
    percent: 60,
    counts: { pending: 1, blocked: 1, running: 0, succeeded: 1, failed: 1, cancelled: 0, skipped: 1 },
  });
});

test("dashboard never presents mock output as live output", () => {
  assert.equal(executionOutputKind("mock", { text: "simulated" }), "simulated");
  assert.equal(executionOutputKind("mock", { deterministic: true, simulated: false }), "deterministic");
  assert.equal(executionOutputKind("live", { mode: "mock", simulated: true }), "simulated");
  assert.equal(executionOutputKind("live", { mode: "live", simulated: false }), "live");
  assert.equal(executionOutputKind("live", { text: "missing markers" }), "unlabelled");
});

test("execution API client uses only the local execution routes and sends explicit modes", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ runs: [], run: { id: "run-1" }, task: { id: "task-1" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await api.executionRuns(100, 200);
    await api.executionRuns(100, 0, { createdAt: "2026-11-13T00:00:00Z", id: "run-older" });
    await api.executionRun("run / one");
    await api.createExecutionRun({ name: "Example", executionMode: "mock", concurrencyLimit: 2, tasks: [{ key: "one", title: "Task", agentId: "bot-1", input: "Instructions" }] });
    await api.planChiefOfStaff({ instruction: "Prepare a general business brief", planningMode: "mock" });
    await api.createChiefOfStaffRun({
      name: "Business brief",
      concurrencyLimit: 2,
      executionMode: "mock",
      originalInstruction: "Prepare a general business brief",
      planningMode: "mock",
      plan: { rationale: "Deterministic mock.", planningMode: "mock", planningLabel: "MOCK", tasks: [] },
    });
    await api.startExecutionRun("run-1");
    await api.cancelExecutionRun("run-1");
    await api.approveExecutionTask("run-1", "task-1");
    await api.rejectExecutionTask("run-1", "task-1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests.map(({ url, method }) => [url, method]), [
    ["/api/execution-runs?limit=100&offset=200", "GET"],
    ["/api/execution-runs?limit=100&offset=0&beforeCreatedAt=2026-11-13T00%3A00%3A00Z&beforeId=run-older", "GET"],
    ["/api/execution-runs/run%20%2F%20one", "GET"],
    ["/api/execution-runs", "POST"],
    ["/api/chief-of-staff/plan", "POST"],
    ["/api/chief-of-staff/runs", "POST"],
    ["/api/execution-runs/run-1/start", "POST"],
    ["/api/execution-runs/run-1/cancel", "POST"],
    ["/api/execution-runs/run-1/tasks/task-1/approve", "POST"],
    ["/api/execution-runs/run-1/tasks/task-1/reject", "POST"],
  ]);
  assert.equal(requests[3].body.executionMode, "mock");
  assert.equal(requests[4].body.planningMode, "mock");
  assert.equal(requests[5].body.originalInstruction, "Prepare a general business brief");
});
