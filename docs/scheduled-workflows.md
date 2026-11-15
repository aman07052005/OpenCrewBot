# Scheduled workflows

OpenCrewBot stores recurring workflow definitions and occurrence history in SQLite. A schedule always creates a fresh Module D execution run; it does not create a second agent-execution system.

## Using it

Open **Schedules** in the sidebar. Create a workflow with an assigned agent, objective, execution mode, task timeout, timezone, and one of: every N minutes, every N hours, daily at a local time, or weekly at a local day and time. One minute is allowed for local demonstrations. Select a saved workflow to edit its schedule, pause or resume it, run a manual occurrence, inspect occurrence status, or open the linked execution run. Cards display the persisted MOCK or LIVE mode.

The UI creates a single persistent task. MOCK is the default and uses a 30-second timeout. LIVE uses the assigned agent's configured model and defaults to 300 seconds. The timeout may be set from 10 milliseconds through 300 seconds, matching the execution engine's server-side limits.

Single-task schedules can change execution mode and timeout during editing. Editing changes the workflow definition used by future occurrences; prior occurrence records and their linked execution runs are retained. For API-created multi-task plans, the UI disables mode and timeout editing and submits the original plan unchanged rather than collapsing it into one task. The API continues to preserve validated tasks, dependencies, execution mode, assigned agents, and skill validation:

- `GET` / `POST` `/api/scheduled-workflows`
- `GET` / `PATCH` `/api/scheduled-workflows/:id`
- `POST` `/api/scheduled-workflows/:id/run`

## Runtime and reliability boundaries

The scheduler is registered through Next instrumentation, starts only in a running Node server, and has a global development guard so hot reload does not add timer loops. It is disabled for tests and production builds. Start `pnpm dev` for local use or run a long-lived `pnpm start` process after a production build. A browser tab is not required; a powered-off computer or stopped process cannot run schedules.

Times are stored as UTC and shown in the browser's local formatting. Daily and weekly schedules use the explicit IANA timezone supplied by the owner. During a spring DST jump, a missing local minute is skipped; during a fall-back, the first matching local minute after the prior cursor is used.

Each automatic occurrence has a unique durable occurrence key. The scheduler first persists that claim, then creates and links an execution run. It prevents a second open occurrence for the same workflow. After a restart, incomplete claims are recovered, but no execution is replayed merely because it was interrupted. Missed time is intentionally coalesced into at most one current occurrence rather than backfilled without limit.

Scheduled runs retain the existing execution engine's task approvals, cancellation, retry safety, execution-mode handling, local-only routing, skill boundaries, and external-operation restrictions. Scheduling grants no new permission or external-write capability. When a LIVE definition is created, edited, or launched, every assigned agent must resolve to an owner-configured, allowlisted live model. Configuration or inference failure fails validation or the occurrence; MOCK output is never substituted.

## Verification

Use a MOCK workflow set to one minute, keep the server running, and inspect the newly linked run in **Execution Dashboard**. Confirm its task timeout is 30 seconds. Create a LIVE workflow for an agent with a configured model, confirm the card says LIVE, and inspect the linked run to verify its mode and 300-second default. Pause it and verify that no new occurrence is created; resume it and use **Run now** to create one manual occurrence. The SQLite occurrence history records the trigger, timestamps, run link, completion state, and any failure.

The scheduler is process-local and does not wake a stopped machine. Editing does not alter an occurrence already in progress. The UI intentionally does not restructure multi-task plans or add scheduled external writes.
