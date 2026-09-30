# 18 — App AI: Design

## Topology

```
app script ──AI (service binding, entrypoint AppAi, props { appId, orgId, slug })──▶ apps/ai (worker ai-<env>)
                                                                                    ├─ env.AI (Workers AI binding)
                                                                                    ├─ D1: usage_counters (ai_tokens), app_usage_daily (ai_requests, ai_neurons)
                                                                                    └─ Rate Limiting binding (per app, per minute)
```

A new small worker `apps/ai` hosts the entrypoint: it needs the Workers AI binding and D1, nothing else. It is deployed with the other workers (`scripts/deploy.mjs`), before the api. No secrets.

## Entrypoint

```ts
export class AppAi extends WorkerEntrypoint<Env, AppMailProps> {
  chat(input: ChatInput): Promise<ChatResult>;
  embed(input: EmbedInput): Promise<EmbedResult>;
}
type ChatInput = { messages: { role: 'system'|'user'|'assistant'; content: string }[]; model?: 'fast'|'smart'; max_tokens?: number; temperature?: number; json?: boolean };
type ChatResult = { ok: true; text: string; data?: unknown; usage: { input_tokens: number; output_tokens: number }; model: 'fast'|'smart' } | AiError;
type EmbedInput = { input: string | string[] };
type EmbedResult = { ok: true; vectors: number[][]; dimensions: number; usage: { input_tokens: number } } | AiError;
type AiError = { ok: false; error: { code: 'invalid_request' | 'too_large' | 'rate_limited' | 'quota_exceeded' | 'model_error' | 'app_deleted'; message: string; retryable?: boolean; retry_after_seconds?: number } };
```

Conventions match `AppMail`: never throws, identity from props only, runtime validation of every field of the untrusted input.

### `chat` algorithm

```
validate input → invalid_request / too_large
app active? (D1) → app_deleted
rate limit (binding key appId) → rate_limited
quota: SELECT count FROM usage_counters WHERE org_id, metric='ai_tokens', day → ≥ MAX_AI_TOKENS_PER_ORG_PER_DAY → quota_exceeded
result = env.AI.run(AI_MODELS[tier], { messages, max_tokens, temperature, response_format: json ? { type: 'json_object' } : undefined })
  error → model_error (retryable), no usage recorded
tokens = result.usage ?? estimate(chars/4)   // Workers AI text models return usage; fall back to a chars/4 estimate
UPSERT usage_counters (ai_tokens += input+output)               // after the call (APPAI-3.2)
addAppUsage(ai_requests += 1, ai_neurons += neurons(model, in, out))
json mode: JSON.parse(result.response) → data; failure → model_error
```

### Models (`packages/shared/src/ai-models.ts`)

```ts
export const AI_MODELS = { fast: '<workers-ai text model id>', smart: '<larger text model id>', embed: '<embedding model id>' };
export const AI_NEURON_RATES = { fast: { in: …, out: … }, smart: { in: …, out: … }, embed: { in: … } };   // neurons per million tokens
```

Concrete ids and neuron rates are copied from Cloudflare's Workers AI model catalog and pricing pages when implementing (task 1 does this and records the date, like `PRICES.asOf`); apps only ever see the tiers, so swapping models is invisible to them. A test asserts every tier has a rate.

## Data

- `usage_counters.metric` enum gains `'ai_tokens'` (daily org counter, exactly the mechanism of `emails`); `DailyMetric` and `DAILY_LIMITS` in `apps/api/src/apps/quota.ts` gain it; `get_usage` output gains `ai_tokens_today: { used, max, resets_at }`.
- `packages/shared/src/usage.ts` gains `ai_requests` (flow, add) and `ai_neurons` (flow, add); `pricing.ts` gains `ai_neurons: 0.011 / 1000` (Workers AI list price per neuron; verify on the pricing page at implementation) and `ai_requests: 0`; `estimateCostUsd` includes them (spec 13 tests extended).
- No migration for tables; the `usage_counters.metric` enum is Drizzle-only (text column), so only the schema type changes.

## Contract and bindings

- `buildBindings` adds the service binding `{ name: 'AI', service: 'ai-<env>', entrypoint: 'AppAi', props }`; `RESERVED_BINDINGS` gains `'AI'`.
- `guide/ai.md` (new topic); `contract.md` bindings list gains `AI`. Fixture routes: `POST /api/ai/summarize`.

## Limits (`packages/shared/src/limits.ts`)

| Constant | Value |
|---|---|
| `AI_MAX_MESSAGES` | 20 |
| `AI_MAX_INPUT_CHARS` | 32_000 |
| `AI_DEFAULT_OUTPUT_TOKENS` | 512 |
| `AI_MAX_OUTPUT_TOKENS` | 2_000 |
| `AI_REQUESTS_PER_APP_PER_MINUTE` | 30 |
| `MAX_AI_TOKENS_PER_ORG_PER_DAY` | 200_000 |
| `AI_MAX_EMBED_INPUTS` | 50 |
| `AI_MAX_EMBED_CHARS` | 8_000 |

## Security and abuse notes

- The app's visitors choose prompts; the platform can't see intent. Bounds: per-app rate, per-org daily tokens, per-request size, no tools or network for the model, output returned as text only.
- No prompt or reply logging (APPAI-3.4); tracking events don't exist for binding calls (only MCP tools are tracked, spec 05).
- The org quota is shared by all the org's apps, which is the cost boundary.

## Open questions

1. Streaming through RPC (`ReadableStream`), needed for chat UIs.
2. Vision/image models and a Vectorize-backed vector store.
3. Per-plan quotas when billing exists.
