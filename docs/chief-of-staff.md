# Chief of Staff

The Chief of Staff turns a natural-language business instruction into a reviewable task graph for the agents already configured in OpenCrewBot. The feature uses Module D's persistent execution engine; it does not create agents or change their permissions.

## Architecture

1. The dashboard sends the original instruction and an explicit planning mode to `POST /api/chief-of-staff/plan`.
2. Capability discovery reads each saved agent's ID, name, role, description, instructions, configured model, enabled tool settings, and connected service IDs. It reports which enabled tools are available in persistent execution and which remain unavailable there.
3. Mock mode creates a deterministic, clearly labelled development plan without making an LLM call. Live mode uses a tool-free Mastra planner and structured Zod output, with only the current agent catalog in its prompt. It never falls back to mock after a live error.
4. The plan is parsed with Zod, checked against known agent IDs, and passed through Module D's execution graph validator. Plans contain at least one work task and at most 20 tasks total.
5. The dashboard previews and lets the owner edit task titles, instructions, assignments, work-task dependencies, and task count. The final consolidation task always depends on every work task, so the execution engine supplies all those outputs to it.
6. Saving the reviewed plan calls `POST /api/chief-of-staff/runs`. The engine persists the original instruction, overall planning rationale, planning mode, task instructions and task-level assignment rationales, plus the normal run and dependency data.

The additive execution schema migration adds nullable planning metadata columns to `execution_runs`; existing Module D and original OpenCrewBot data remain in place.

## Usage

1. Open **Executions** and choose **Plan with Chief of Staff**.
2. Enter the business outcome, audience, constraints, and desired deliverable format.
3. Select **MOCK · DETERMINISTIC** to preview a local development plan, or **LIVE MODEL** to use the configured planner model. The mode must be selected explicitly.
4. Review the generated plan. Edit task text and assignments, change dependencies, add or remove work tasks, then select an execution mode.
5. Choose **Create execution run**. The run appears in the existing execution dashboard. It stays pending until **Start** is selected; the execution mode is also explicit and separate from planning mode.

Live planning and live execution can call paid models. The dashboard labels both decisions. Mock planning does not call a model; mock execution uses the deterministic simulated executor.

## Configuration

- Live planning requires `NEBIUS_API_KEY`. Without it, the API returns an error and does not make or substitute a mock plan.
- `OPENCREWBOT_PLANNER_MODEL` optionally selects a Nebius model for planning. If unset, planning uses the model catalog's `DEFAULT_MODEL`.
- Live task execution uses each assigned agent's saved model, subject to the existing Module D live execution configuration and key checks.
- Tool discovery reflects each agent's settings. Persistent task sessions continue to use Module D's fixed read-only execution allowlist. Browser control, memory tools, connected app/MCP actions, and interactive questions are not enabled by the planner. Planning cannot grant permissions or satisfy a tool approval.
- Tavily search tools are available in an execution only when the agent has web search enabled and `TAVILY_API_KEY` is configured. TypeScript code mode remains limited to enabled read-only tools.

No environment file is changed by this feature. Configure optional values in the deployment environment or your local ignored `.env` file.

## Limitations

- Plans are bounded to 20 total tasks and 12,000 characters of original instruction. A live model response that is malformed, too large, uses unknown agent IDs, or has invalid dependencies is rejected for review and retry.
- Mock plans use deterministic objective splitting and keyword overlap against agent profiles. They are development scaffolding, not semantic LLM planning.
- The live planner sees configured tool capabilities but cannot call tools or verify external facts. Task agents can only use the existing execution allowlist.
- The final consolidation task receives the direct outputs of every work task. Large outputs can exceed a configured model's context window; reduce the plan or task output sizes if that occurs.
- This feature does not infer or approve side effects. Agents can prepare research, recommendations, and drafts, but external actions remain governed by the existing app and approval paths.
