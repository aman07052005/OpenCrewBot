# Module J acceptance notes

## Protected provider boundary

Only server-owned environment configuration selects a live provider. Nebius, HTTPS OpenAI-compatible endpoints, and loopback-only Ollama are supported. Compatible-provider requests are origin pinned and redirects are rejected. LIVE never falls back to MOCK. Local-only routes exclude hosted fallbacks, and scheduled workflows, collaboration, and persistent tasks use the same route resolver.

Chief of Staff and Agent Factory use `OPENCREWBOT_PLANNER_PROVIDER` / `OPENCREWBOT_PLANNER_MODEL` and `OPENCREWBOT_AGENT_FACTORY_PROVIDER` / `OPENCREWBOT_AGENT_FACTORY_MODEL`. Their structured results still pass the existing schemas and plan/configuration validation. Agent Factory continues to set Ask First and does not accept permissions or arbitrary tools from model output.

## Accounting and limits

The ledger persists provider-reported input, output, total, cached-input, and reasoning tokens when supplied. Unknown fields stay null. It stores the configured pricing version and estimated USD cost; Ollama has no hosted-token price. Maximum output tokens are sent in the model request settings. Hard monetary budgets are rejected because no supported provider reservation API can make them an enforceable admission control.

## Safe local demonstration

1. Configure an allowlisted provider in the owner environment and restart the server. Do not place credentials in browser settings.
2. Open **Models & usage**, verify the provider, and assign an allowlisted model to a non-sensitive test agent.
3. For planner or factory live tests, set the corresponding global provider/model environment values and submit a harmless draft-only request.
4. Confirm the usage row shows the selected provider/model, reported counts when supplied, and an estimate only when pricing is configured.
5. Test a failed provider request and confirm that no MOCK result appears. For a local-only agent, confirm a hosted fallback is rejected.

Remaining limitations: provider verification is a read-only `/models` request and does not prove model capability; hard cost reservations are not implemented; the model dashboard reports persisted data but does not edit server environment configuration.


## Targeted routing and accounting hardening

In an agent editor, choose a primary provider/model, select Automatic, and add up to five ordered alternate models. Assign a preferred task category to an alternate to make it the first choice for that category; Fixed mode always starts with the primary. Untagged alternates are fallback-only. Only server-allowlisted compatible model IDs are eligible; set `OPENCREWBOT_OPENAI_COMPATIBLE_MODELS` and/or `OPENCREWBOT_OLLAMA_MODELS` before running these models. The selected model is reflected in subsequent conversation usage records. When a conversation changes model, the runtime recreates its controller; simultaneous turns requiring different models for the same bot may need to be retried after the other turn finishes.

Local-only inference requires an Ollama primary and Ollama-only alternatives. This restricts the agent's own model calls; it is **not** end-to-end data isolation for shared rooms, planners, other agents or external tools. Do not use confidential data in cross-agent workflows. Automatic classification is deterministic and owner-directed, not a benchmarked claim about model quality. The usage dashboard summarizes the most recent 100 attempts; mock usage is excluded from its aggregates.

`tests/model-routing-hardening.test.mjs` exercises task-dependent selection, fixed routing, allowlists, duplicate suppression, bounded fallbacks and local-only model restrictions with synthetic environment values and no provider calls. The controlled provider transport, runtime switching, streamed usage and fallback execution still require integration verification with installed dependencies. Provider connection checks do not persist verification timestamps; hard monetary reservations remain unsupported.

## Local planner performance

The Chief of Staff drawer supports selecting the available agents before generating a plan. The server verifies these IDs and validates all generated assignments against that roster. The local Ollama planner sends bounded profile summaries instead of full personas, uses the existing strict JSON schema, and has a five-minute inference deadline with a 3,072 output-token cap. Hosted planning and factory limits remain unchanged. This reduces planning overhead but does not guarantee completion on all hardware or complex prompts. A timed-out or invalid plan remains a failure, never a mock result. For the initial local verification, select two configured local agents and ask for two short work tasks and a final report.
