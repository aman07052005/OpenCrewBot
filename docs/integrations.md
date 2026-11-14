# External integrations

Module H uses a server-owned integration registry and never treats configuration as proof that a provider works. The Connections drawer shows the current status, operations, scope, and the most recent successful connection check or sanitized failure. Registry verification state is stored in the existing settings store under `integrations.connection-status.v1`; no application tables or user data are replaced.

| Integration | Implemented bounded operations | Authentication and scope | Actual verification state |
| --- | --- | --- | --- |
| GitHub | Repository metadata, one directory listing, one selected file, issue inspection, pull-request inspection | Public GitHub REST only; one explicit `owner/repository`, optional ref/path/number | No repository is verified until the owner performs an inspection successfully. |
| Gmail | Authenticated profile verification; approved synthetic test-message retrieval; local email drafting | One owner-authorized test mailbox through Composio; exact synthetic subject and body | Actual Gmail profile response required; live message retrieval must be verified locally. |
| MCP | Connection test, tool discovery/schema inspection, owner-enabled read-only tool call | Explicit configured server, bot connection, current `readOnlyHint`, owner enablement | No server is verified by default. The included local synthetic demo was protocol-verified during development, but is not automatically configured in an installation. |

## Architecture and authorization

The registry is server-only. A provider response is needed before it becomes `connected-verified`; otherwise it is `not-configured`, `configured-unverified`, or `connection-failed`. Provider failures are redacted and retained as a bounded last-error value.

GitHub and MCP calls validate agent identity and their exact operation inputs before a request leaves the server. They are read-only operations, so they do not create a Module G external-write action request. Gmail test-message reads use the persistent Module G lifecycle, even for Full Access. Other sensitive operations remain disabled rather than being routed around Module G.

- GitHub requires a real bot with web-search enabled or an explicit GitHub connection. It uses no server token, therefore has no private-repository access.
- MCP requires an explicitly configured server and an agent explicitly connected to that server. A tool must be both owner-enabled and currently advertised by the server with `readOnlyHint: true`; this condition is rechecked on every direct invocation and while building chat tools.
- MCP server output and provider errors are bounded and redacted before they reach the UI, model context, or saved status.
- Chat sessions no longer receive raw MCP tools simply because a server is connected. They receive only the same owner-enabled, currently read-only allow-list. Composio actions retain Mastra's provider-managed human prompt, including at Full Access, until a supported action is migrated to Module G's persistent lifecycle.
- Execution tasks intentionally do not receive Composio or MCP tools. MOCK execution never contacts an integration, and a LIVE failure never becomes a mock success.

Module G still owns the only registered external-write adapter (`simulated.email.send`). Its per-action `invocationCount` is the durable value shown in Approvals Manager; the simulated adapter's process-wide sequence is now named `adapterInvocationSequence` so it cannot be confused with that action's count.

## GitHub

Use the **GitHub read-only inspection** card in Connections. Select an authorized agent, provide `owner/repository`, select the operation, and supply only the required path or issue/PR number. The API is also available as `POST /api/integrations/github`.

Repository identifiers, refs, numbers, and paths are validated. Paths must be repository-relative and cannot traverse directories. Requests are aborted after 12 seconds. Raw provider responses are limited to 512 KB, files to 256 KB, and directory output to 100 entries. The adapter never clones a repository, executes downloaded source, creates a patch, or writes to GitHub.

A selected source file of at most 100 KB can be sent to the local, deterministic **Code Review** skill from the card. That creates a persistent MOCK execution-history entry; it does not execute code, invoke a model, alter the repository, or store the fetched content as trusted memory. Findings identify the selected path and are based only on supplied source text.

Private GitHub repositories, broad tokens, GitHub app installation, and repository modifications are intentionally unsupported pending a separately scoped connection and resource-policy design.

## Gmail

Use only a dedicated, authorized test mailbox with synthetic content. Prefer a Gmail read-only OAuth configuration (`https://www.googleapis.com/auth/gmail.readonly`); the Composio project key must permit proxy execute. Do not grant additional mailbox permissions just to test this demo. The existing OAuth flow is unchanged. If the provider cannot supply a suitable authorized connection, leave Gmail unverified. Never paste credentials into prompts or commit them.

1. Connect the test account using the existing Gmail row under **Apps via Composio**. Disconnect any other Gmail accounts from this installation. A stored active OAuth connection alone is not verification.
2. In Gmail itself, arrange for a single plain-text test email to be present in the test inbox (manually, outside OpenCrewBot). Use subject `OpenCrewBot Demo TEST2026` and body `OpenCrewBot synthetic test: revenue 120 units 12.`. Use a different alphanumeric/hyphen suffix of 4–32 characters if the subject is already used. No signature, attachments, or extra content.
3. Assign Gmail to Quill in the bot details, with Ask First and approval interaction enabled.
4. In the **Gmail — authorized synthetic test read** card, confirm the test-mailbox checkbox and press **Verify Gmail profile**. This calls Google's `users.getProfile` through Composio's authenticated proxy. The actual email address is not returned or persisted. The registry displays the last successful verification for the currently active connection, not the old OAuth-state-only flag.
5. Select Quill and enter the exact test subject, then **Propose test-message read**. The pending action binds the connection ID and exact subject. Open Approvals, review the preview, then Approve and Execute approved read. Rejecting leaves the invocation count at zero. All permission levels require explicit approval for this operation. Approved Gmail reads expire after the original 15-minute approval window.
6. A successful action displays `provider: gmail`, `simulated: false`, `synthetic: true`, the actual message ID, exact subject, and decoded synthetic body. The action result and timeline persist; the read does not send or modify mail. A failure never becomes a simulated result. The invocation count counts adapter attempts, not individual HTTP requests.

The adapter uses only fixed authenticated GET operations: `profile`, a bounded inbox search (two candidates maximum), selected message metadata, and selected message body. It requires an exact subject match and rejects ambiguous results, mismatching body content, oversized payloads, and unsupported MIME/attachments. Each provider request has a 12-second timeout and 128 KB response cap. Only the known synthetic body is returned; raw provider errors, account email address, and headers are not stored. Generic Composio Gmail chat tools are excluded from bot sessions. The direct generic actions POST endpoint cannot propose Gmail reads; the dedicated route checks explicit owner confirmation, current connection, and bot assignment. Execution checks the same account is still active. There is no automatic retry or replay. Profile verification is an owner-initiated connection check, not an agent action.

This is an owner-mediated integration, not unrestricted autonomous mailbox access. The existing Email Drafting skill is local only; copy the synthetic result into that skill manually if needed. No external draft creation, sending, deletion, mailbox-wide browsing, or autonomous execution-engine Gmail access is provided. The app relies on the owner to use a test-only mailbox; OAuth authorization scope is controlled by Composio, not verified from token contents. Other legacy connected-app paths still require their existing provider approvals.

Provider references: [Composio authenticated proxy](https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteProxy), [Gmail profile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile), [Gmail message search](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [Gmail selected message](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get).

## MCP

Add an HTTPS server in **Connections** (plain HTTP is allowed only for `localhost` or `127.0.0.1`). Tokens and optional headers stay in the server-side settings store; URL user-info is rejected. Press **Test** to make an actual MCP `tools/list` connection check, then **Discover** to inspect server-provided schemas.

Only a tool whose live schema advertises `readOnlyHint: true` can be enabled. Enable it in the discovered-tools card, attach that server to a bot in the bot's Details, enter valid JSON input, and press **Run**. The result is from an actual MCP protocol invocation and is displayed with secrets redacted. Unknown, disabled, changed, write-capable, oversized, and malformed calls fail closed.

For a safe local protocol demonstration, run:

```powershell
node scripts/synthetic-mcp-demo.mjs
```

Then add `http://127.0.0.1:3021/mcp` as an MCP server, test it, discover the two `SYNTHETIC` business-data tools, enable one, attach it to a bot, and invoke it. The demo exposes only fixed synthetic product data and a margin calculation. It has no credentials, filesystem access, subprocess access, or external-network access. A different port can be selected only for isolated testing through `OPENCREWBOT_MCP_DEMO_PORT`.

## Credentials, data, and limitations

Do not put secrets in a server URL. Do not place tokens in frontend source, prompts, or documentation. Integration credentials stay server-side; preview, status, audit, and MCP output paths redact token/password/secret-like fields and text. No `.env` file is modified by Module H.

There is no general user-authentication or per-user ownership layer in the current local application, so “owner” means the person controlling this single installation's Connections settings. Remote MCP servers are trusted only to the limited extent that their live `readOnlyHint` declaration is accurate; OpenCrewBot therefore additionally requires explicit enablement and never exposes unannotated tools to chat. General Gmail mailbox operations and all real external writes remain unavailable; only the approved synthetic test-message read is enabled. Legacy Composio chat actions have provider-managed rather than persistent Module G approval records; they continue to require a human prompt.

## Manual verification checklist

1. Open **Connections** and confirm all three registry rows start as unconfigured or unverified rather than falsely connected.
2. Use a public repository such as `vercel/next.js` in the GitHub card. Inspect metadata, then a selected small file. Confirm the returned source URL and that no write control exists.
3. Connect an authorized Gmail test account, verify its actual Gmail profile, and approve and execute a designated synthetic message read as described above. A connected OAuth state alone is not sufficient.
4. Start the synthetic MCP script, add the local endpoint, press Test and Discover, and confirm both tool schemas say read-only. Enable one, assign the MCP server to a bot, invoke it with its documented JSON, and confirm the result says `synthetic: true`.
5. Disable the MCP tool or remove the bot's server connection; invoke again and confirm it is rejected. Attempt an unannotated/unknown tool and confirm it cannot be enabled or run.
6. Open Approvals Manager and reject a simulated email action. Its persisted timeline must show the rejection and a per-action invocation count of zero.
