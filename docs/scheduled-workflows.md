# Scheduled workflows

OpenCrewBot stores recurring workflow definitions and occurrence history in SQLite. A schedule always creates a fresh Module D execution run; it does not create a second agent-execution system.

## Using it

Open **Schedules** in the sidebar. Create a workflow with an assigned agent, objective, timezone, and one of: every N minutes, every N hours, daily at a local time, or weekly at a local day and time. One minute is allowed for local demonstrations. Select a saved workflow to edit its schedule, pause or resume it, run a manual occurrence, inspect occurrence status, or open the linked execution run.

The UI creates a safe MOCK single-task plan. The API also preserves validated multi-task plans, dependencies, execution mode, assigned agents, and skill validation:

- `GET` / `POST` `/api/scheduled-workflows`
- `GET` / `PATCH` `/api/scheduled-workflows/:id`
- `POST` `/api/scheduled-workflows/:id/run`

## Runtime and reliability boundaries

The scheduler is registered through Next instrumentation, starts only in a running Node server, and has a global development guard so hot reload does not add timer loops. It is disabled for tests and production builds. Start `pnpm dev` for local use or run a long-lived `pnpm start` process after a production build. A browser tab is not required; a powered-off computer or stopped process cannot run schedules.

Times are stored as UTC and shown in the browser's local formatting. Daily and weekly schedules use the explicit IANA timezone supplied by the owner. During a spring DST jump, a missing local minute is skipped; during a fall-back, the first matching local minute after the prior cursor is used.

Each automatic occurrence has a unique durable occurrence key. The scheduler first persists that claim, then creates and links an execution run. It prevents a second open occurrence for the same workflow. After a restart, incomplete claims are recovered, but no execution is replayed merely because it was interrupted. Missed time is intentionally coalesced into at most one current occurrence rather than backfilled without limit.

Scheduled runs retain the existing execution engine's task approvals, cancellation, retry safety, execution-mode handling, skill boundaries, and central external-action authorization. Scheduling grants no new external-write permission. LIVE schedules require the configured model key and never silently downgrade to MOCK.

## Verification

Use a MOCK workflow set to one minute, keep the server running, and inspect the newly linked run in **Execution Dashboard**. Pause it and verify that no new occurrence is created; resume it and use **Run now** to create one manual occurrence. The SQLite occurrence history records the trigger, timestamps, run link, completion state, and any failure.
