# Skills and tools

**Final-version update:** `/api/skills` is GET catalogue-only; execute through an authorized persistent task or Skills manager. LIVE Chief of Staff can select enabled registered skills with validated inputs. Deterministic local results are not simulated model outputs, even when invoked from a MOCK-labelled run. See [final README](../README.md).

OpenCrewBot's skill registry is server-owned: each entry has a stable ID, validated input contract, declared permissions/tools, and an executable handler. Users and models can select an ID, but cannot upload JavaScript or define a handler.

The eight executable skills are Market Research, Competitor Analysis, Financial Modelling, Presentation Creation, Email Drafting, Code Review, Data Analysis, and Lead Generation. Market/lead skills only interpret supplied evidence in this release; without evidence they return a labelled research framework or gap. Financial and data analysis are deterministic. Presentation produces a downloadable Markdown outline, not PPTX. Email is a draft only. Code review reads explicit supplied text only. Lead Generation never collects personal contact data or sends outreach.

Skill runs use `POST /api/skills` with `{ skillId, input, mode }`; `GET /api/skills` exposes the catalogue. Inputs are bounded and Zod-validated. CSV is limited to 1 MB / 10,000 records, rejects malformed quoting, and formula-like cells are prefixed with an apostrophe in exported previews.

Agents enable skills in Agent Factory. Execution tasks may declare `skillId` and `skillInput`; the server rejects unknown skills and skills not assigned to the task's agent. Results, limitations, and artifacts are persisted as ordinary task output, so dependency outputs and collaboration consolidation can consume them. MOCK does no network I/O. The current handlers are local/read-only in LIVE too; live provider failures are never replaced with mock success.

Example Data Analysis input:

```json
{"csv":"region,revenue\nNorth,120\nSouth,80","groupBy":"region","valueColumn":"revenue"}
```

## Skills Manager

Open **Skills manager** from the sidebar. Select a skill, then choose an installed agent that has that skill enabled in Agent Factory. Edit the schema-shaped JSON starter input and select **Run skill**. The manager creates a persistent MOCK execution task, rather than calling a shortcut endpoint, so the existing agent-skill authorization and execution history apply. Results include limitations and applicable download buttons. The manager renders an SVG bar chart when Data Analysis returns chart-ready grouped results.

For Data Analysis, choose a CSV file (up to 1 MB) or edit JSON records directly. The selected CSV is placed in the JSON editor for preview before execution. Results show dimensions, inferred columns, missing counts, numerical summaries, grouped aggregation, and a downloadable `analysis.json`. CSV and JSON are supported; native XLSX is not.

There is intentionally no unauthenticated/direct skill-run route: `/api/skills` is catalogue-only. Execution requires a known assigned agent with the selected skill enabled. Email Drafting never sends mail; Code Review is read-only and only accepts supplied repository-relative file text; Lead Generation uses only supplied public organization records. Market Research and Lead Generation do not perform live research in this release; they surface supplied evidence or explicit research gaps.

Manual check: install or edit an agent with `skill.data-analysis`, use **Skills manager**, select the agent, upload `docs/skills-sample.csv`, and run. Open **View history** to inspect the persisted task output.

Current limitations: no external research provider is invoked by skills yet, no XLSX parser or PPTX exporter is included. Existing MCP connections are not treated as verified skill providers until a future integration verifies them. MOCK represents local deterministic execution; LIVE is not a substitute for unavailable providers and must report provider failures rather than returning simulated success.
