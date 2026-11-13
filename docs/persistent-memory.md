# Module E — Persistent Markdown memory

## Storage and scopes

The existing single-owner application retains the original files. No database schema change or migration is required. All paths are relative to `OPENCREWBOT_DATA_DIR` (default `data/`):

| Scope | File | Loaded when |
|---|---|---|
| Individual agent | `workspaces/<botId>/MEMORY.md` | That agent's normal turns and live execution; mock execution exposes a preview |
| Room | `memory/room/<roomId>/MEMORY.md` | Verified members of the current room, including collaboration tasks |
| Project | `memory/project/<projectId>/MEMORY.md` | Current room is explicitly linked to that project |
| User preferences | `memory/preferences/owner/MEMORY.md` | Memory-enabled agents in all contexts |
| Decisions | `memory/decisions/owner/MEMORY.md` | Memory-enabled agents in all contexts |
| History | `memory/history/owner/MEMORY.md` | Memory-enabled agents in all contexts |

`memory/catalog.json` holds project names/IDs and room associations. Multiple rooms may share one project, each room has at most one active project. Unlinking does not remove the project or its notes. Existing agents and rooms do not get overwritten. Use global notes only for facts that all memory-enabled agents may see; keep room-specific details in the room/project document. The app is single-owner, not a multi-tenant permission system.

## Editing and provenance

Open **Memory manager** in the sidebar. Select a scope and document, edit Markdown, provide a reason, and save. Changes use an atomic file replacement and a SHA-256 revision check. Stale editor saves fail instead of overwriting newer content. The existing agent inspector also uses revision-aware saves. The older agent PUT endpoint remains compatible, but does not provide optimistic concurrency.

Each modified document has an adjacent `MEMORY.md.audit.jsonl` containing actor, time, reason, operation, byte count and old/new revision hashes; the interface displays the newest 50 records. Historical content is intentionally not copied into the audit log. Existing unlogged files and direct edits are shown as untracked; the current contents remain readable. The file and audit are separate writes, so a crash between them can leave a change marked untracked. A malformed audit line also marks the file untracked. Audit is an operational record, not a tamper-proof ledger. Do not place private data in the reason field. Common secret patterns are redacted before saves and prompt retrieval; redaction is not exhaustive.

Existing normal-chat `memory_add` and `memory_edit` tools retain their original private agent scope, now with actor/time/reason/revision provenance. Shared room/project/preferences/decisions/history changes are owner-controlled via the manager; agents can suggest updates but cannot write them automatically. Persistent task sessions remain read-only and have no new tools.

## Retrieval

The existing agent system prompt reads the current private Markdown file. Shared memory is collected at each chat turn or execution task; global notes plus the authorized room and linked project are supplied as reference data. Membership is resolved from stored room/session records, not a user-supplied task scope. No shared notes are loaded for memory-disabled agents. Standalone tasks and DMs receive global context, not room/project context. Old memory injected into historical messages is explicitly superseded by current memory, including an empty current list. Corrections change subsequent retrieval, not old transcripts or completed run outputs. Current user instructions and tool permissions take precedence. Owner preferences take precedence over conflicting agent notes.

Shared context is limited to the first 3,000 characters of each nonempty document; individual live context retains its existing 200-line/16 KiB limit. Save limit is 128 KiB per document. Keep important facts near the beginning. Mock tasks record scoped memory revisions and the first 500 characters of each retrieved file as `memoryReferences`, separate from the collaboration message protocol. This verifies retrieval, not AI comprehension. Live task prompts include current shared context and the private agent system prompt. Live models are not exercised by automated tests.

## APIs

- `GET /api/memory?scope=preferences&id=owner` reads current document and audit (use the actual scope/id).
- `PUT /api/memory` accepts `{scope,id,content,revision,reason}` and requires a matching current revision.
- `GET /api/memory/catalog` lists projects and room links.
- `POST /api/memory/catalog` accepts `{action:"create",name}` or `{action:"link",roomId,projectId}` (`null` unlinks).

Targets are validated against existing agents, rooms, projects or the single owner. All endpoints use the existing local API guard. No new external integrations, permissions or credentials are needed.

## Manual verification (MOCK, no model charges)

1. Open **Memory manager → User preferences**. Save `# Reports\n- Preferred format: bullet points with a short summary.` with reason `Initial demo preference`. Check the provenance row.
2. Open Executions → create a new MOCK execution task assigned to Scout (Memory enabled). Use `Prepare a short market report` as the instruction. Start the run. Inspect the task output JSON; `memoryReferences` should contain the preference preview and revision.
3. Stop the dev server cleanly with Ctrl+C in its terminal and run `pnpm dev` again. Open Memory manager; verify the note and audit persisted. Create a NEW mock run to check fresh retrieval.
4. Correct the preference to `Preferred format: concise table, no bullet points.` with reason `Owner corrected report format`. Create a NEW mock run. Verify the new reference and new revision. Previously completed runs retain their original output for history.
5. Create a project named `MeetUniversity` in Memory manager → Project. Select the new project, enter `# Project\nFocus on education counselling` and save with a reason. Link Market Intelligence to the project. Save room memory in that room separately. Run a mock collaboration and open a stage's execution run to inspect its task output. It should contain global, room and project references. An unrelated standalone run must not show that room/project context.
6. For a real adaptation demonstration, configure the existing live model separately and repeat with a new live task; check the actual response follows the new preference. Do not describe mock file retrieval as real model reasoning.

## Tests and limitations

`pnpm test` runs the existing suite plus the scoped-memory regression tests: legacy preservation, six scopes, project links and isolation, stale-save rejection, correction, real subprocess persistence, secret redaction and bounded retrieval, fake live runtime prompt updates. Run `pnpm exec next typegen`, `pnpm exec tsc --noEmit`, `pnpm lint`, and `pnpm build` locally.

This module uses explicit owner-authored shared memory rather than automatic fact extraction, semantic search or project inference. It is not a guarantee that a model will follow a preference. The compare-and-save guarantee covers the single server process; simultaneous independent server processes/external editors are not synchronized. Historical output and provider thread data are not deleted by changing memory. Shared context is sent to configured live providers when live mode is used. Project-specific standalone execution requires a linked room workflow. No paid model calls are made in tests.
