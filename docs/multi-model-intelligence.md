# Multi-model intelligence

**Final-version update:** automatic routing can select owner-designated task-category alternates ahead of the primary; local-only routes are not end-to-end privacy isolation. The Models & usage UI includes provider verification. Local Ollama live inference and structured generation were demonstrated; hosted and live fallback remain unverified. See [module J acceptance](module-j-acceptance.md).

Module J adds an owner-controlled model registry, deterministic routing metadata, per-agent model preferences, and a persistent usage ledger. Credentials never leave server environment variables and are never returned by APIs or stored in SQLite.

## Providers

- **Nebius Token Factory** remains the supported live Mastra provider and preserves existing `bot.model` records.
- **Deterministic MOCK** is explicitly simulated and is never a fallback for a failed live call.
- **OpenAI-compatible hosted** and **local Ollama** use the pinned `@ai-sdk/openai-compatible` 2.0.62 adapter, passed as an AI SDK language-model object into the existing Mastra Agent/AgentController runtime.

Compatible-provider requests are origin-pinned to the owner configuration, reject redirects, and carry a provider-specific credential only for the configured hosted provider. Ollama receives no hosted credential. `POST /api/models/providers/openai-compatible/verify` and `POST /api/models/providers/ollama/verify` make an explicit, read-only `/models` request; a listed configuration is not considered verified until that succeeds.

## Owner configuration

Copy placeholders from `.env.example`; do not put credentials in the browser. Hosted endpoints must be owner-configured HTTPS URLs. Ollama is limited to `http://127.0.0.1:11434/v1` (or `localhost` on port 11434), and weights are never downloaded by OpenCrewBot.

Set `NEBIUS_API_KEY` to use the existing live path. Optionally configure `OPENCREWBOT_OPENAI_COMPATIBLE_*` or the loopback `OPENCREWBOT_OLLAMA_*` variables to register their allowed models. `OPENCREWBOT_PLANNER_PROVIDER` / `OPENCREWBOT_PLANNER_MODEL` and `OPENCREWBOT_AGENT_FACTORY_PROVIDER` / `OPENCREWBOT_AGENT_FACTORY_MODEL` select the server-owned provider and model for Chief of Staff and Agent Factory LIVE requests. Those selections are never read from a user prompt. Restart the long-running application after changing environment configuration.

## Routing and accounting

An agent may retain its legacy fixed Nebius model or store `modelConfig` with a primary provider/model, fixed or automatic mode, fallbacks, local-only requirement, and output limit. Deterministic classification uses bounded categories (research, coding, planning, writing, math, structured output, tools, or general); it does not make a paid classifier call. The configured primary compatible candidate is selected and the reason is persisted with execution usage records. A hard cost budget is deliberately rejected: post-inference accounting cannot honestly enforce a pre-inference monetary cap.

Persistent execution tasks may use owner-configured fallbacks only after a transient failure before any text is emitted. Every attempt is stored, cancellation stops further attempts, local-only agents exclude hosted fallbacks, and MOCK is never a LIVE fallback. Interactive conversations deliberately do not retry providers after streaming begins. Usage records report provider counts only when the runtime supplies them; otherwise they are marked `unknown`. The supported Mastra/AI-SDK fields are `promptTokens`/`inputTokens`, `completionTokens`/`outputTokens`, `totalTokens`, `cachedInputTokens`, and `reasoningTokens`; cumulative stream updates replace prior values rather than being summed. Costs are estimates, not invoices; local inference has no API token charge but is not represented as zero total cost. Chief of Staff and Agent Factory record the same usage and pricing fields after successful structured generation.

## Verification

Run `pnpm dev`, configure a provider in your local `.env`, restart, then use the owner-triggered verify endpoint (or the equivalent Models UI action once added) before assigning it to an agent. Assign an Ollama model using `OPENCREWBOT_OLLAMA_ENABLED=1`, `OPENCREWBOT_OLLAMA_BASE_URL=http://127.0.0.1:11434/v1`, and an explicit model allowlist. Send a harmless text prompt and inspect `/api/models/providers` and `/api/models/usage`. The repository test suite does not call paid providers and does not constitute live verification.
