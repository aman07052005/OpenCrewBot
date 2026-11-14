import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";
import { migrateExecutionSchema } from "../src/lib/server/execution-schema.ts";
import { migrateApprovalSchema } from "../src/lib/server/approval-schema.ts";
import { actionAudit, authorizeAction, decideAction, executeApprovedAction, getAction, proposeAction, simulatedInvocationCount } from "../src/lib/server/approval-service.ts";

const bot = (approval = "ask", policy) => ({ id: "agent-1", name: "Agent", handle: "agent", title: "Agent", description: "", instructions: "", emoji: "", color: "", model: "test", tools: { webSearch: false, memory: false, codeMode: false, browser: false, askUser: true }, connections: [], approval, permissionPolicy: policy, pinned: false, createdAt: "2026-01-01T00:00:00Z" });
const payload = { destination: "buyer@example.com", subject: "Hello", body: "A simulated proposal" };
async function fixture(t) { const client = createClient({ url: "file::memory:" }); await migrateExecutionSchema(client); await migrateApprovalSchema(client); t.after(() => client.close()); return client; }

test("permission engine fails closed and implements all three levels", () => {
  assert.equal(authorizeAction(bot("ask"), "simulated.email.send", payload).decision, "approval-required");
  assert.equal(authorizeAction(bot("controlled", { preapprovedOperations: ["simulated.email.send"], allowedDestinations: ["example.com"], maxActionsPerDay: 2 }), "simulated.email.send", payload).decision, "allowed");
  assert.equal(authorizeAction(bot("controlled", { preapprovedOperations: [], allowedDestinations: [], maxActionsPerDay: 2 }), "simulated.email.send", payload).decision, "approval-required");
  assert.equal(authorizeAction(bot("full"), "simulated.email.send", payload).decision, "allowed");
  assert.equal(authorizeAction(bot("full"), "unknown.write", payload).decision, "denied");
  assert.equal(authorizeAction({ ...bot("full"), tools: { ...bot().tools, askUser: false } }, "simulated.email.send", payload).decision, "denied");
});

test("approved simulated actions execute exactly once while rejected and cancelled actions never execute", async (t) => {
  const client = await fixture(t); const before = simulatedInvocationCount();
  const pending = await proposeAction(client, bot(), { operation: "simulated.email.send", arguments: payload });
  assert.equal(pending.status, "pending"); assert.match(pending.preview, /No email has been sent/);
  await decideAction(client, pending.id, "reject"); const rejected = await executeApprovedAction(client, pending.id, bot()); assert.equal(rejected.invocationCount, 0); assert.equal(simulatedInvocationCount(), before);
  const cancelled = await proposeAction(client, bot(), { operation: "simulated.email.send", arguments: payload }); await decideAction(client, cancelled.id, "cancel"); await executeApprovedAction(client, cancelled.id, bot()); assert.equal(simulatedInvocationCount(), before);
  const approved = await proposeAction(client, bot(), { operation: "simulated.email.send", arguments: payload }); await decideAction(client, approved.id, "approve");
  await Promise.all([executeApprovedAction(client, approved.id, bot()), executeApprovedAction(client, approved.id, bot())]); const once = await getAction(client, approved.id); assert.equal(once?.status, "succeeded"); assert.equal(once?.invocationCount, 1); assert.equal(simulatedInvocationCount(), before + 1);
});

test("expired and tampered requests cannot execute, and controlled scopes are rechecked", async (t) => {
  const client = await fixture(t); const before = simulatedInvocationCount();
  const pending = await proposeAction(client, bot(), { operation: "simulated.email.send", arguments: payload });
  await client.execute({ sql: "UPDATE action_requests SET expires_at=? WHERE id=?", args: ["2000-01-01T00:00:00.000Z", pending.id] });
  const expired = await executeApprovedAction(client, pending.id, bot()); assert.equal(expired.status, "expired"); assert.equal(expired.invocationCount, 0);
  const controlled = bot("controlled", { preapprovedOperations: ["simulated.email.send"], allowedDestinations: ["example.com"], maxActionsPerDay: 10 });
  const action = await proposeAction(client, controlled, { operation: "simulated.email.send", arguments: payload }); assert.equal(action.status, "approved");
  await client.execute({ sql: "UPDATE action_requests SET arguments_json=? WHERE id=?", args: [JSON.stringify({ ...payload, destination: "buyer@outside.example" }), action.id] });
  const blocked = await executeApprovedAction(client, action.id, controlled); assert.equal(blocked.status, "failed"); assert.equal(simulatedInvocationCount(), before);
});

test("audit records lifecycle and controlled daily limits require a new approval", async (t) => {
  const client = await fixture(t); const controlled = bot("controlled", { preapprovedOperations: ["simulated.email.send"], allowedDestinations: [], maxActionsPerDay: 1 });
  const first = await proposeAction(client, controlled, { operation: "simulated.email.send", arguments: payload }); assert.equal(first.status, "approved");
  const second = await proposeAction(client, controlled, { operation: "simulated.email.send", arguments: { ...payload, destination: "second@example.com" } }); assert.equal(second.status, "pending");
  assert.ok((await actionAudit(client, first.id)).some((entry) => entry.event === "proposed"));
});

test("approval state is persistent, auditable, and permission revocation blocks execution", async (t) => {
  const client = await fixture(t); const allowed = bot("controlled", { preapprovedOperations: ["simulated.email.send"], allowedDestinations: [], maxActionsPerDay: 20 }); const action = await proposeAction(client, allowed, { operation: "simulated.email.send", arguments: { ...payload, body: "token=secret" } });
  assert.match(action.arguments.body, /REDACTED/);
  const blocked = await executeApprovedAction(client, action.id, bot("controlled", { preapprovedOperations: [], allowedDestinations: [], maxActionsPerDay: 20 })); assert.equal(blocked.status, "failed");
  const stored = await getAction(client, action.id); assert.equal(stored.status, "failed"); assert.ok((await actionAudit(client, action.id)).some((entry) => entry.event === "failed"));
});

test("Gmail read requires explicit approval at all permission levels, and rejection never invokes provider", async (t) => {
  const client = await fixture(t); const args = { accountId: "ca_test", subject: "OpenCrewBot Demo TEST2026" };
  const gmailBot = (mode = "ask") => ({ ...bot(mode), connections: ["composio:gmail"] });
  for (const mode of ["ask", "controlled", "full"]) assert.equal(authorizeAction(gmailBot(mode), "gmail.demo.read", args).decision, "approval-required");
  assert.equal(authorizeAction(bot("full"), "gmail.demo.read", args).decision, "denied");
  let calls = 0; const handlers = { gmailRead: async () => { calls++; return { simulated: false, synthetic: true }; } };
  const rejected = await proposeAction(client, gmailBot(), { operation: "gmail.demo.read", arguments: args });
  await decideAction(client, rejected.id, "reject"); await executeApprovedAction(client, rejected.id, gmailBot(), handlers); assert.equal(calls, 0);
  const approved = await proposeAction(client, gmailBot(), { operation: "gmail.demo.read", arguments: args });
  await decideAction(client, approved.id, "approve"); await Promise.all([executeApprovedAction(client, approved.id, gmailBot(), handlers), executeApprovedAction(client, approved.id, gmailBot(), handlers)]); assert.equal(calls, 1); assert.equal((await getAction(client, approved.id)).invocationCount, 1);
});

test("Gmail approval is tied to exact subject and account; revoked connections block execution", async (t) => {
  const client = await fixture(t); const args = { accountId: "ca_test", subject: "OpenCrewBot Demo TEST2026" }; const connected = { ...bot(), connections: ["composio:gmail"] };
  const action = await proposeAction(client, connected, { operation: "gmail.demo.read", arguments: args }); await decideAction(client, action.id, "approve");
  await client.execute({ sql: "UPDATE action_requests SET arguments_json=? WHERE id=?", args: [JSON.stringify({ ...args, subject: "OpenCrewBot Demo CHANGED" }), action.id] });
  const handlers = { gmailRead: async () => { throw new Error("must not invoke"); } };
  assert.equal((await executeApprovedAction(client, action.id, connected, handlers)).invocationCount, 0);
  const revoked = await proposeAction(client, connected, { operation: "gmail.demo.read", arguments: args }); await decideAction(client, revoked.id, "approve"); assert.equal((await executeApprovedAction(client, revoked.id, bot(), handlers)).invocationCount, 0);
});
