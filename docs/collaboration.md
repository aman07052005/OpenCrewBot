# Module C — Persistent multi-agent collaboration

## Scope

Collaboration extends the original room UI. Ordinary chat, existing room routing, individual bot records and Markdown memory remain unchanged. Every collaboration stage is a real persisted Module D execution run. The owner explicitly starts each stage; this version does not automatically schedule the next stage in the background.

## Architecture and storage

- `collaboration_sessions`: room, original objective, selected member IDs, mode, current approved Chief of Staff plan, creation/closure timestamps.
- `collaboration_rounds`: ordered linked execution runs, phase, and stage instruction. `(session_id, ordinal)` and `run_id` are unique. Creation of a run and its link is atomic; a duplicate or closed-session link rolls back the run.
- `execution_runs`, `execution_tasks`, `execution_task_dependencies`: unchanged persistent execution engine tables, including task input, output, attempts, approval, errors and timestamps.
- The message timeline is a deterministic read model of stored task inputs/outputs and timestamps, not a separate mutable chat transcript. It survives restarts, gives each event a stable task-derived ID and avoids duplicate inserts. Agent proposals are stored in actual output text; routed requests additionally live in the resulting task input.
- `migrateCollaborationSchema` is additive and idempotent. Existing Module D schema migrations are not changed.

## Workflow

1. Install room templates or create a normal room with at least two bots.
2. Open a room and choose **Start collaboration / history**. Enter an objective, choose members and select MOCK or LIVE.
3. **Generate plan** runs the existing Chief of Staff planner restricted to chosen room members. Edit titles, task instructions, agents and work dependencies if needed. The server validates membership, the dependency DAG, the final task, and the selected execution mode.
4. **Save approved plan** creates the session and a pending work run, without starting it. **Start stage** runs the work using the existing scheduler, concurrency limit 3. Dependent tasks receive the real prerequisite outputs.
5. **Prepare next stage** creates a pending request run when valid work-stage proposals exist. Start it and approve or reject each request individually. Rejected requests never execute; a failed request stage requires a revised plan rather than silently continuing.
6. Prepare and start the review stage. The reviewer is chosen from the room, preferring a verification-capable agent that has not authored a previous output where possible. It receives previous successful output excerpts and is instructed to identify unsupported claims, contradictions and gaps.
7. Prepare and start the final stage. The selected consolidation agent receives work, request responses and review outputs, and is instructed to produce the original deliverable incorporating revisions. The final deliverable remains attached to the session.
8. **Open run** opens the linked execution dashboard for detailed task data, inputs, outputs and timestamps.

### Agent proposals

Live work tasks may emit at most one fenced JSON block at the end of their actual response:

````text
```collaboration-request
{"type":"question","recipientId":"actual-room-agent-id","content":"Specific bounded question"}
```
````

Allowed types: `question`, `delegation`, `verification_request`, `challenge`. The coordinator derives the sender from the completed task, rejects self/unknown recipients, extra JSON keys, malformed or oversized content, and deduplicates recipient/content pairs. Only the original work stage may propose requests. No nested delegation, automatic permission escalation, or recursive agent conversation is permitted. Accepted requests become real execution tasks with approval required, not tool calls. A request response is labelled as an answer, verification result, or intermediate output according to its request type. Timeline notices identify invalid and undispatched proposals. Review results can contain corrections/challenges; the system does not claim every result is independently true.

### Bounds and context

Server constants in `collaboration-protocol.ts` define limits: 2–12 members, 40 created tasks (including interrupted attempts), 8 stages, 6 delegated tasks, one delegation layer, one attempt per task, 120 seconds per task. New stages reserve budget for review and consolidation. Initial Chief of Staff plans retain their existing 20-task limit. Each previous successful output is passed as a bounded excerpt of up to 3,000 characters; full originals remain in the linked run. Direct DAG prerequisite data retains the existing engine behavior. Large results may need manual follow-up; the final agent must acknowledge gaps.

## Interruption and recovery

A completed non-final stage is a safe pause boundary (`awaiting_next`). **Interrupt** cancels the current run, retaining already committed results; provider cancellation is best effort and late outputs are guarded by the existing engine. **Resume unstarted tasks** creates a new pending run only when all unfinished tasks have zero attempts and their dependencies are completed or also safe to resume. Previously attempted tasks are never replayed by this control. A failed/interrupted stage can instead use **Revise instruction** to generate and approve a new plan for additional or changed work. Completed outputs remain available. The final stage sees the initial objective and revised instructions. Cancelling a session closes it permanently; completed work remains in history.

On restart, the existing execution recovery handles active runs. Mock work interrupted during execution may fail because collaboration uses a one-attempt limit; live interrupted calls are not retried automatically. Pending stages, completed stages, blocked requests and session history are stored. The UI reconstructs the state from persisted run status rather than relying on in-memory session counters. No autonomous cross-stage scheduler runs after restart.

## Room templates

The **New room** drawer offers an idempotent install action:

| Room | Required handles |
| --- | --- |
| Market Intelligence | scout, nova, sentinel |
| Marketing Campaign | spark, quill, scout |
| Business Analytics | cipher, ledger, atlas |
| Development Team | forge, sentinel, atlas |

The installer skips existing IDs and case-insensitive names. Missing agents are reported rather than fabricated. Create the missing agents using Agent Factory or manually select alternative members in the existing room form. Existing room records and chat histories are never overwritten by the installer.

## Local API

- `POST /api/rooms/templates/install`
- `GET /api/rooms/:id/collaborations` (latest 20 sessions in that room)
- `POST /api/rooms/:id/collaborations/plan` (instruction, memberIds, mode)
- `POST /api/rooms/:id/collaborations` (approved draft)
- `GET /api/rooms/:id/collaborations/:sessionId`
- `POST /api/rooms/:id/collaborations/:sessionId` (action: start, advance, interrupt, resume, cancel, or continue with draft)
- Existing Module D task approval, rejection, and run detail endpoints are reused.

All endpoints reuse the local API boot and error wrapper. The existing localhost/origin restrictions are unchanged.

## Modes and permissions

MOCK uses a deterministic simulation that generates explicit mock messages, exercises actual SQLite state transitions, approvals and dependency routing, and records the IDs of results consumed. It never claims actual research or verification. LIVE uses the existing configured Mastra adapter and model; model failures remain failures, not mock results. No paid model calls are required for tests. Live execution requires existing Nebius configuration and is not verified by a mock run.

The adapter checks room membership again at task execution. The original isolated runtime still enforces the existing tool allowlist; collaboration does not enable memory writes, external write actions, browser control, connected apps or MCP. Agent messages and prior outputs are untrusted reference data and cannot authorize tools. Approval of a delegated task does not expand tool permissions. No credentials or application database contents are included in the patch.

## Verification

Run on the project machine:

```powershell
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm build
git diff --check
```

The new tests use Node's built-in `node:sqlite` with a minimal client adapter to exercise real SQLite transactions in isolated memory/file databases. Production continues to use `@libsql/client`. Tests cover membership, the full mock lifecycle, real task routing and approvals, duplicate proposals and atomic round creation, rejection, safe continuation, persistence after reopening, live prompt context using a fake runtime, provider failure, room templates, parallel/sequential dependencies and stage bounds.

### Manual browser checklist

- Start the app with `pnpm dev`. Create/install the workforce templates if not already present; make sure Nova exists with handle `nova`.
- Open New room → Install collaboration rooms. Repeat and confirm no duplicate rooms. If a room is missing agents, correct them in Agent Factory or create a room with alternatives.
- Open Market Intelligence → Start collaboration / history. Use MOCK and enter: `Research three competitor categories; compare positioning and identify missing evidence; draft a concise report.`
- Generate plan, inspect assignments and dependencies, save, and start. Confirm work outputs and the visible simulated labels.
- Prepare/start the next stage; approve requests for the successful demo. Confirm request responses and then run review and final stages. Check final received-task IDs and open an associated run.
- In a separate session, reject a request; confirm zero attempts and no output for that task. Interrupt a pending stage and resume unstarted tasks. Restart the server and inspect saved session history.
- Test ordinary room chat separately. If a configured live provider is available, explicitly select LIVE and record actual provider results; do not claim live verification based on MOCK.

## Known limitations

Owner-started stages are intentionally bounded and not autonomous across runs. There is no multi-hop free-form agent chat or continuously running background coordinator. Live review is a model-generated assessment, not proof of factual truth. Context passed across runs is excerpted. The limits are source-level constants rather than user-configurable per-session settings. Room deletion removes ordinary room navigation; session rows are retained. Module E–J features, external-action approval lifecycle and integrations remain separate work. Browser behavior, full Next.js build/lint/typecheck and the complete dependency-backed regression suite must be verified on a machine with the project's installed dependencies.

### Optional automatic stage progression

After saving a room plan, select **Run automatically**. A durable owner opt-in allows the server scheduler to prepare and start the next bounded stage every 30 seconds, without an open room tab. Manual start remains the default. Delegation and verification requests retain their original task-level approval gates; no approval is granted by the coordinator. A failed, interrupted or cancelled stage stops progression. Pause prevents new stages, but does not stop a currently executing stage; use Interrupt for that. A revised instruction disables automatic progression until explicitly enabled again. Existing sessions default to manual mode. The scheduler is designed for a single local server process, not a distributed service. LIVE automatic mode requires local-only Ollama participants with web search, code, browser and external connections disabled, checked before each stage. LIVE room runs use one task at a time and a 300-second task deadline. The existing manual room mode and external tool restrictions remain unchanged.
