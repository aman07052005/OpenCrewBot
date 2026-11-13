# Persistent execution engine

Module D adds a durable task-graph runner alongside the existing Mastra chat runtime. Chat messages, rooms, ordinary Mastra sessions, and their approval handling are unchanged. A run records its `executionMode`: `mock` uses the deterministic local executor, while `live` uses the assigned bot's Mastra agent and Nebius model. The default is `mock`; live execution is never substituted with mock output when a model call fails.

## Storage

The existing `opencrewbot.db` database receives additive migrations recorded in `schema_migrations`. They create the execution tables and add a persisted `execution_mode` column to runs:

- `execution_runs` stores run identity, lifecycle status, concurrency limit, timestamps, and run-level errors.
- `execution_tasks` stores task identity, run and agent assignment, JSON input and output, approval state, attempts, retry/timeout limits, status, timestamps, and errors.
- `execution_task_dependencies` stores dependency edges separately so the scheduler can query them without relying on SQLite JSON extensions.

Runs and tasks remain available after completion, failure, cancellation, and server restart. The task graph is validated before its rows are inserted: task keys must be unique, dependencies must exist, and a depth-first cycle check rejects circular graphs. The task IDs exposed in the API are generated UUIDs; keys in the create request are only used to refer to other tasks in the same request.

## Lifecycle and scheduling

Create a run in `pending` state. Tasks needing authorization begin as `blocked`; other tasks begin as `pending`. Set `executionMode` to `mock` or `live` in the create request. If omitted, `OPENCREWBOT_EXECUTION_MODE` is used, defaulting to `mock`. Starting a run schedules any tasks whose dependencies all succeeded. Independent tasks execute in parallel up to the run's `concurrencyLimit` (1–32).

Claims use one conditional SQLite `UPDATE ... RETURNING` statement. The statement verifies that the task is still pending, dependencies succeeded, the run is active, and the number of running tasks is below the configured limit. This gives multiple scheduler instances a shared database-level claim and limit check, rather than relying only on process memory.

Errors and timeouts are retried up to `maxAttempts` (1–10) only for executors explicitly declared `idempotent`. Every attempt receives the same stable task ID as its `idempotencyKey`, so an idempotent external adapter can deduplicate requests. Executors default to `never` retry, which prevents accidental duplicate side effects when an adapter's safety is unknown. An exhausted or rejected task becomes `failed`; its dependents become `skipped`, while unrelated tasks can still finish. A run becomes `failed` if any task failed or was skipped, `completed` when all tasks succeed, or `blocked` when progress is waiting for an approval. A run can be cancelled while pending, running, or blocked. In-flight executors receive an abort signal, and conditional status writes prevent late results from replacing cancellation state.

The approval endpoints are explicit: a blocked task marked `requiresApproval` is not claimable until `/approve` records `approvedAt` and returns it to the pending queue. `/reject` permanently fails the blocked task and fails the run after dependency propagation; a later approval cannot restart it. This task-level approval does not grant tool permission. Live execution creates a fresh Mastra controller, session, resource, and thread for every attempt, and waits for an actual successful `agent_end` event plus text output before saving success.

Live sessions receive the assigned bot's current model, instructions, and Markdown memory. They can use bot-enabled Tavily search/read tools and the isolated QuickJS code tool when configured. They never receive memory-write tools, browser tools, Composio apps, or MCP tools. Mastra permissions allow only the read category and deny edit, execute, MCP, and other categories; ask-user and subagent built-ins are disabled. So a task approval cannot bypass the separate tool approval lifecycle. The existing chat approval path remains unchanged.

## Restart recovery and delivery semantics

At application boot, any `running` run is recovered. Its in-flight tasks are returned to `pending` if retry budget remains, or marked failed if attempts are exhausted; then the scheduler resumes the run. Completed task output and error history stay in SQLite.

Mock tasks with retry budget are safe to replay. Live execution is non-idempotent by default and never automatically retries a failed call. On restart, an interrupted in-flight live task is marked failed because the model request may already have been billed; tasks that had not started can still run. The runner is process-local for execution and cancellation signals, with SQLite conditional claims providing duplicate-claim protection. It is designed for the app's existing local, single-owner deployment model, not as a distributed worker service.

## Mock output

Mock output is stable JSON with `mode: "mock"`, `simulated: true`, and the label `SIMULATED OUTPUT — deterministic mock executor`, along with task ID, agent ID, and input. It performs no network access. Live output has `mode: "live"`, `simulated: false`, the actual response text, model ID, assigned bot, and isolated session ID. Provider/runtime failures are stored as task errors.

## API

| Method and path | Purpose |
| --- | --- |
| `POST /api/execution-runs` | Create a run and task graph. Run fields include `executionMode` (`mock` or `live`) and optional `concurrencyLimit` (defaults to 3). Task fields: `key`, `title`, `agentId`, optional `input`, `dependsOn` keys, `requiresApproval`, `maxAttempts`, and `timeoutMs`. |
| `GET /api/execution-runs?limit=100` | List recent run summaries. |
| `GET /api/execution-runs/:id` | Inspect a run and its tasks, dependencies, outputs, errors, and timestamps. |
| `POST /api/execution-runs/:id/start` | Start or resume a pending/approval-blocked run. |
| `POST /api/execution-runs/:id/cancel` | Cancel an active run. |
| `POST /api/execution-runs/:id/tasks/:taskId/approve` | Authorize one task that is waiting for approval. |
| `POST /api/execution-runs/:id/tasks/:taskId/reject` | Reject one task that is waiting for approval. |

`agentId` must identify an existing OpenCrewBot bot when a run is created. Responses are JSON, consistent with the current API route style. A `400` response carries validation and lifecycle errors.

`OPENCREWBOT_EXECUTION_MODE=mock|live` sets the default mode for newly created runs. Live runs require `NEBIUS_API_KEY`; starting one without the key returns an error and does not change it to mock. Run mode is persisted so a restart cannot silently switch execution behavior.

## Dashboard usage

Open **Executions** from the existing sidebar. The history view reads saved run records from the execution API, shows each run's mode, status, creation time and task progress, and loads older history in cursor-based pages. Run details refresh every two seconds while the view is open; the selected conversation and its transcript are retained when switching between chat and the dashboard.

Choose **New run** to name a run, select `MOCK · SIMULATED` or `LIVE MODEL`, set a concurrency limit, and add tasks assigned to existing bots. Each task has a title, instructions, optional dependencies, and an optional task approval gate. Dependency choices are limited to earlier tasks in the form, which makes the graph acyclic. Creating a run only saves it; press **Start** in its detail view to execute it. Live mode uses the bot's configured model and can make a paid model call. The dashboard labels this mode before starting and does not switch a failed live run to mock mode.

Use **Approve task** or **Reject task** only for a task marked as awaiting approval. This task-level decision controls whether that task may enter the run queue. It does not grant permission to use external tools. Execution sessions continue to exclude side-effectful tools, and a task approval cannot approve a chat tool call or other external action. The task detail view also displays dependencies, assigned agent, lifecycle times, attempt count, timeout, persisted input, output, and errors. Mock runs and their output are explicitly labelled `MOCK · SIMULATED` / `SIMULATED OUTPUT`; live results are labelled `REAL MODEL OUTPUT` only when their stored output confirms live mode. Unknown output formats are labelled as unknown.

The page shows loading, empty, and API error states. A run still marked `running` is described as possibly recovering after a server restart; polling updates its state when the server recovery process finishes. Execution history remains available after refreshing the browser because it is read from SQLite.

### Manual dashboard verification

1. Start the app in the usual localhost development mode and open **Executions**.
2. Create a mock run with two existing bots, two tasks, and make the second task depend on the first. Leave one task approval gate enabled.
3. Verify the blocked task offers task-only Approve/Reject controls. Approve it, start the run, and confirm the dependent task waits until its dependency succeeds.
4. Confirm the run and task show `MOCK · SIMULATED` / `SIMULATED OUTPUT`, inspect the dependency and output details, then refresh the browser and verify the completed history remains.
5. For cancellation UI checks, create and start a run with a sufficiently long task timeout, then select **Cancel** while it is running and verify the terminal status is refreshed.

These dashboard checks can be performed in mock mode without model charges or external tool actions. Use live mode only when you intentionally want to make a real model request; the existing manual live check below describes its prerequisites.

## Tests

Run the isolated database tests with Node 24:

```sh
node --experimental-strip-types --test tests/execution-engine.test.mjs
```

Most tests create isolated in-memory SQLite databases, so they cannot read or alter the application's `data/opencrewbot.db`. The restart integration test creates a temporary on-disk SQLite database, closes it in one child process, reopens and recovers it in a second process, verifies legacy rows and memory files, then removes only its own temporary directory. Fake-runtime tests cover live output, dependency context, session isolation, failures, cancellation, and permission policy; they make no model or external service calls.

## Manual live check

1. Set `OPENCREWBOT_EXECUTION_MODE=live` and a valid `NEBIUS_API_KEY` in your local environment, then restart the app.
2. Create a run assigned to an existing bot with `executionMode: "live"`, one simple text task, and no tool use required.
3. Start it and inspect the run. A successful task should contain `mode: "live"`, `simulated: false`, the model ID, and the model's actual text. A provider failure should appear in the task's `error` field, never as mock output.
4. To try safe search, enable that bot's web-search tool and configure Tavily. Browser, connected-app, MCP, and memory-write actions remain unavailable in task sessions.

Live checks call a paid model service and may incur model/search charges. Automated tests use fake runtimes and do not perform this manual check.
