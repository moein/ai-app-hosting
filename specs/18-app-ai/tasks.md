# 18 — App AI: Tasks

Depends on: 06/09 (bindings, contract), 13 (usage, pricing), 03 (`get_usage`, quota).

- [ ] **1. Models, rates, limits, usage metrics, pricing**
  `ai-models.ts` (copy ids and neuron rates from the Workers AI catalog/pricing, dated), limit constants, `ai_requests`/`ai_neurons` metrics, `ai_tokens` daily counter, `estimateCostUsd`.
  Satisfies: APPAI-3.3 (data), APPAI-1.2
  Tests: every tier has a rate; catalog/price coverage (spec 13's test); neuron estimation for known token counts; `DAILY_LIMITS` has `ai_tokens`.

- [ ] **2. `apps/ai` worker + `AppAi.chat`**
  Scaffold (`wrangler.jsonc` with `ai`, `d1_databases`, `ratelimits`, `METRICS`), entrypoint, validation, quota, rate limit, usage recording, JSON mode.
  Satisfies: APPAI-1.1–1.5, APPAI-3.1, APPAI-3.2, APPAI-3.4, APPAI-3.5, APPAI-4.3
  Tests (fake `AI` binding): tier mapping; invalid/oversized input never calls the model; quota check before / usage after (overshoot by at most one call); rate limit; model error → retryable and no usage; JSON mode parse success/failure; tokens fall back to an estimate; nothing logged from prompts; deleted app.

- [ ] **3. `AppAi.embed`**
  Satisfies: APPAI-2.1
  Tests: single vs batch; input limits; usage; dimensions.

- [ ] **4. Binding, contract, `get_usage`, guide, fixture**
  `AI` in `buildBindings`, `RESERVED_BINDINGS`, `get_usage.ai_tokens_today`, `guide/ai.md`, contract list, fixture route; deploy script includes `ai`.
  Satisfies: APPAI-4.1, APPAI-4.2, APPAI-3.6, APPAI-2.2
  Tests: bindings exactly match; `vars.AI` → CON-R10; guide contains API, tiers, error codes and the untrusted-output warning; `get_usage` shape.

- [ ] **5. E2E on dev** (spec 12)
  Flows: `F-AI-1` (fixture route calls `env.AI.chat` with a tiny prompt and `env.AI.embed`; usage counters and `app_usage_daily` rows appear; an over-limit input returns `too_large`).
  Satisfies: E2E-3.3
