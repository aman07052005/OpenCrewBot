# Demonstration recording guide (5–10 minutes)

This is a narration outline and screen sequence, not a claim that a recording already exists. Use the actual local app and completed history; do not rerun expensive operations unnecessarily. Before recording, confirm every statement against the corresponding screen. Use synthetic inputs only. Crop or hide sensitive IDs, credentials and unrelated browser tabs. Keep both schedules paused except when intentionally demonstrating recurrence. Do not expose a public server.

## Preparation

- Start Ollama and `pnpm dev`; open the localhost app. Configure the agents you intend to use with the tested local model and no hosted fallbacks.
- Prepare the completed GitHub, CSV, competitor, campaign and collaboration runs in history. Have the rejected GitHub approval, memory audit, chart output, schedules and model usage available.
- Verify the newest live schedule occurrence before claiming a successful live recurrence. Pause it after the check. If it is unavailable or fails, show the actual state and the prior MOCK history, not a simulated result renamed LIVE.
- Use existing results in the recording so a slow local model does not consume the entire video. State that you are showing saved execution history, then demonstrate a short interactive action if useful.

## Suggested 8–9 minute recording

| Time | Screen | What to explain |
| --- | --- | --- |
| 0:00–0:40 | README / localhost sidebar | “This is my extension of the MIT-licensed Studio1 OpenCrewBot. I retained the original chat and agent runtime, then added persistent business workflows. It runs locally.” |
| 0:40–1:30 | Agent Factory / agent roster / Models & usage | Show Orion's role and saved configuration, five workforce templates and room templates. Explain the actual Ollama model, routing controls, reported tokens and unknown cost fields. Hosted inference is configured in code but not demonstrated. |
| 1:30–2:45 | Executions: completed GitHub Chief of Staff run | Expand original instruction and rationale, show generated task assignment, external read, dependency output, Orion synthesis. Explain that the planner chose a registered read, not an unrestricted tool. The completed run retrieved public metadata and proposed next inspection steps; no repository change occurred. |
| 2:45–3:30 | Approvals: approved and rejected GitHub requests | Show actual approval decision and zero invocation count on the rejected request. Open rejected run: external task failed, dependent skipped. Explain task approval versus external-action approval and the three permission levels. |
| 3:30–4:35 | Skills manager / completed analysis | Show Data Analysis CSV input, revenue 40,000, units 400, East highest 15,000, grouped chart and downloadable analysis.json. Explain deterministic computation vs live synthesis. Show registry containing eight skills. |
| 4:35–5:25 | Competitor and campaign history | Open completed report and campaign strategy plus calendar outputs. Identify the supplied baseline and hypothetical campaign assumptions. Explain that drafts are local and nothing is published. |
| 5:25–6:40 | Strategy Intelligence room | Show live plan, Scout's needs analysis, Orion's feature ideas, Scout's critique and final report. Then show separate MOCK revision continuation: server-side reservation, new instruction, preserved outputs and review/final stages. Explicitly distinguish real model collaboration from simulated revision test. |
| 6:40–7:20 | Memory manager and Orion conversation | Show preference audit from bullets to tables and actual table response to the same prompt. If restart persistence was verified, show the saved preference after restart; otherwise mention the isolated automated test only. |
| 7:20–8:00 | Schedules | Show manual/automatic history, actual mode of the linked occurrence, and pause/resume. A supplied baseline is reused; no claim of refreshed competitor information. |
| 8:00–8:45 | Connections / tests / README | Show public GitHub, authorized synthetic Gmail and local MCP status without IDs or secrets. State latest test result from terminal, explain limitations and point to the setup/architecture/verification docs. |

## Optional fresh demo prompt

For a short live room (Scout and Orion, local-only, no external tools):

> Using only this hypothetical business brief, recommend two improvements for an educational career-exploration portal: students need clearer course-to-career links and accessible descriptions. Scout should identify assumptions; Orion should propose a privacy-preserving solution. Review and consolidate in under 100 words. No external tools or invented evidence.

Choose manual start for the first stage if demonstrating instruction revision. At a completed non-final boundary, reserve **Revise instruction** before generating the new plan. Use a short constraint such as “Prioritize accessibility, low cost and no behavioral tracking; revise the previous ideas and recommend one.” Review the plan and run the continuation. Only call this a live revision demonstration if LIVE continuation actually succeeds and incorporates the constraint.

## Closing narration

“The main engineering contribution is a shared persistent execution engine rather than separate demo-only workflows. The planner and room coordinator generate tasks, skills return structured results, registered reads require scoped authorization, and the history records successes and failures. Local inference, real read integrations and deterministic computations are distinguished from simulations. Remaining limitations include hosted provider verification, constrained automatic collaboration, and no arbitrary external writes. Setup and exact verification boundaries are documented in the repository.”

## Submission handoff

- Repository branch: `https://github.com/aman07052005/OpenCrewBot/tree/assignment-3` (verify the final commit is pushed and visible).
- Recording: add the actual accessible link or file to the submission form. No recording link is invented here.
- Local setup: README; architecture: `docs/architecture.md`; requirements and evidence: `docs/assignment-verification.md`.
- No public deployment URL; local working demonstration is the chosen delivery mode. Include any required submission fields from the original assignment instructions.
