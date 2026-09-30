# 18 — App AI: Requirements

Apps want small AI features: summarize a note, classify a message, answer questions about their own content, search by meaning. This spec gives every app an `AI` binding backed by Cloudflare Workers AI, run by the platform: no API keys for the user, model names hidden behind two tiers, quotas per organization and cost tracked per app (spec 13). The binding is a platform service (like `EMAIL`), not raw Workers AI, so the platform controls models, limits, metering and abuse.

## Stories & acceptance criteria

### APPAI-1 — Text generation
As an app, I want to ask a model to write or classify text, so that I can add AI features in a few lines.

- **APPAI-1.1** WHEN app code calls `env.AI.chat({ messages, model?, max_tokens?, temperature?, json? })` THE SYSTEM SHALL run the request on Workers AI and return `{ ok: true, text, usage: { input_tokens, output_tokens }, model }`.
- **APPAI-1.2** `model` SHALL be `'fast'` (default) or `'smart'`, mapped by the platform to concrete models (`AI_MODELS`); apps can't name other models.
- **APPAI-1.3** `messages` SHALL be 1–`AI_MAX_MESSAGES` entries of `{ role: 'system' | 'user' | 'assistant', content: string }` with at most `AI_MAX_INPUT_CHARS` characters in total; `max_tokens` defaults to `AI_DEFAULT_OUTPUT_TOKENS` and is capped at `AI_MAX_OUTPUT_TOKENS`.
- **APPAI-1.4** WHEN `json` is `true` THE SYSTEM SHALL ask the model for a JSON object and return it parsed as `data` (and the raw `text`); IF the reply is not valid JSON THEN it SHALL return `{ ok: false, error: { code: 'model_error' } }`.
- **APPAI-1.5** IF the input is invalid or too large THEN THE SYSTEM SHALL return `{ ok: false, error: { code: 'invalid_request' | 'too_large', message } }` without calling the model.

### APPAI-2 — Embeddings
- **APPAI-2.1** WHEN app code calls `env.AI.embed({ input })` (a string or up to `AI_MAX_EMBED_INPUTS` strings, each ≤ `AI_MAX_EMBED_CHARS`) THE SYSTEM SHALL return `{ ok: true, vectors: number[][], dimensions, usage: { input_tokens } }` from the platform's embedding model (`AI_MODELS.embed`).
- **APPAI-2.2** THE guide SHALL show storing vectors in the app's D1 and ranking by cosine similarity in code (no vector database in v1).

### APPAI-3 — Limits, quotas and cost
As the operator, I want AI usage bounded and metered, so that one app can't run up the bill.

- **APPAI-3.1** THE SYSTEM SHALL limit each app to `AI_REQUESTS_PER_APP_PER_MINUTE` calls per minute (`rate_limited`, with `retry_after_seconds`) and each organization to `MAX_AI_TOKENS_PER_ORG_PER_DAY` tokens (input + output) per UTC day (`quota_exceeded`).
- **APPAI-3.2** THE quota check SHALL happen before the model call using the tokens used so far today; the call's own tokens are added after it, so one call may overshoot by at most one request.
- **APPAI-3.3** THE SYSTEM SHALL record per app and day, in `app_usage_daily` (spec 13): `ai_requests` and `ai_neurons` (estimated Workers AI neurons from the token usage and the model's neuron rates, `AI_NEURON_RATES`), and price them (`pricing.ts`).
- **APPAI-3.4** THE SYSTEM SHALL NOT log or store prompts or replies; only counts, model tier and sizes.
- **APPAI-3.5** IF Workers AI is unavailable or errors THEN THE SYSTEM SHALL return `{ ok: false, error: { code: 'model_error', retryable: true } }` and not count usage.
- **APPAI-3.6** `get_usage` SHALL include the org's AI tokens used today against the limit.

### APPAI-4 — Binding and guide
- **APPAI-4.1** THE SYSTEM SHALL add `AI` (service binding to the platform's `AppAi` entrypoint with props `{ appId, orgId, slug }`) to every deployed app; `AI` becomes a reserved binding name (CON-2.5, CON-R10).
- **APPAI-4.2** THE guide (new topic `ai`) SHALL document `chat`/`embed`, the two tiers, limits and error codes, treating model output as untrusted (never as HTML or code to run), cost awareness, and a JSON-classification example.
- **APPAI-4.3** WHEN the app is deleted THE `AI` binding SHALL return `{ ok: false, error: { code: 'app_deleted' } }`.

## Non-functional requirements

- Added platform latency (excluding the model) < 100 ms p95.
- Workers AI processes data without retaining it for training; the guide tells app owners to disclose AI use to their users where appropriate.

## Out of scope

- Streaming replies, image/audio/vision models, tool calling, fine-tuning, a vector database, bring-your-own model or API key, per-app custom quotas.
