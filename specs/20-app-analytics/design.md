# 20 — App Analytics: Design

## Flow

```
visitor ──▶ dispatcher (route live) ──▶ app
               │ after the response (never blocks):
               └─ env.TRAFFIC.writeDataPoint({ indexes:[appId], blobs:[…], doubles:[…] })   dataset app_traffic_<env>

api tool get_app_analytics ──▶ Analytics Engine SQL API (CF_API_TOKEN, Account Analytics Read) ──▶ aggregated result
```

Why the dispatcher: static pages served by the assets binding never invoke the app's Worker (`run_worker_first` covers only `/api/*`), so the tail worker can't see them; the dispatcher sees every request and already knows the app id from the route. Where `Sec-Fetch-Dest` and friends are available it can label navigations correctly.

## Data point layout (`apps/dispatcher/src/traffic.ts`)

Analytics Engine limits: ≤ 20 blobs, ≤ 20 doubles, 1 index (≤ 96 bytes), ≤ 250 points per invocation — one point per request fits.

| Slot | Meaning |
|---|---|
| `index1` | app id (`app_…`), the sampling key |
| `blob1` | kind: `page` \| `asset` \| `api` |
| `blob2` | normalized path (≤ `ANALYTICS_PATH_MAX_CHARS`) |
| `blob3` | status class: `2xx` `3xx` `4xx` `5xx` |
| `blob4` | country (ISO 3166-1 alpha-2 from `request.cf.country`, or `XX`) |
| `blob5` | device: `mobile` \| `tablet` \| `desktop` \| `bot` |
| `blob6` | referrer host (`direct` when absent or the app's own host) |
| `blob7` | visitor hash (16 hex chars) |
| `blob8` | method |
| `double1` | count (always 1) |
| `double2` | response bytes (`content-length`, else 0) |
| `double3` | dispatch duration in ms |

`traffic.ts` is a pure module (`buildTrafficPoint(request, response, ctx)`), unit-tested table-style.

### Visitor hash

`hex16(HMAC-SHA256(TRAFFIC_SALT_SECRET, "<UTC yyyy-mm-dd>|<ip>|<user-agent>"))`. `TRAFFIC_SALT_SECRET` is a dispatcher secret (generated per environment by `scripts/set-secrets.mjs`, like the peppers). The date component rotates the effective salt daily; the IP and user agent are used in memory only.

### Classification

- `kind`: path starts with `/api/` → `api`; else method GET/HEAD and (`sec-fetch-dest: document` or `accept` includes `text/html`) and the last path segment has no file extension → `page`; else `asset`.
- `device`: user-agent patterns (bot first: `bot|crawler|spider|preview|monitor|headless…`; then tablet, mobile, else desktop). Pattern lists are constants with tests; no full UA is stored.
- `referrer host`: `new URL(referer).hostname` minus a leading `www.`; same host → `direct`; parse failure → `direct`.

## Reading (`apps/api/src/analytics/`)

`AnalyticsClient.query(sql): Promise<Row[]>` (POST `/accounts/{a}/analytics_engine/sql`, `FORMAT JSON`, verified to work with the existing token) with a fake. Queries are built by one module from a validated `appId` (`/^app_[A-Za-z0-9_-]{11}$/` — never from user input, and asserted again before interpolation, since Analytics Engine's SQL API has no bound parameters) and a period enum → interval:

```sql
-- totals
SELECT SUM(_sample_interval * double1) AS requests, … FROM app_traffic_<env> WHERE index1 = '<appId>' AND timestamp > NOW() - INTERVAL '7' DAY …
-- page views:   kind = 'page' AND blob5 != 'bot'
-- visitors:     COUNT(DISTINCT blob7) WHERE kind = 'page' AND blob5 != 'bot'    (approximate under sampling; noted)
-- top pages:    GROUP BY blob2 … ORDER BY views DESC LIMIT ANALYTICS_TOP_N
-- referrers / countries / devices likewise; errors: blob3 IN ('4xx','5xx') GROUP BY blob2, blob3
-- series:       toStartOfDay(timestamp) GROUP BY day
```

The dataset name comes from `ENVIRONMENT`. Analytics Engine only creates a dataset on its first write, so a query against a dataset that doesn't exist yet (no request has ever been recorded in that environment) fails with an unknown-table error; the client maps that to an empty result rather than an error. Results are assembled into the tool's output; `data_note` mentions sampling when `_sample_interval` > 1 anywhere in the range and lag ("the last few minutes may be missing").

## Tool

```
get_app_analytics  in { app: string; period?: '24h' | '7d' | '30d' }
                   out { period; page_views; visitors; api_requests; errors: { count; share }; top_pages: { path; views }[]; top_referrers: { host; visits }[];
                         countries: { country; visits }[]; devices: { device; visits }[]; error_paths: { path; status_class; count }[];
                         daily: { day; page_views; visitors }[]; data_note?: string; next_step: string }
```

Annotations `{ readOnly, idempotent }`; title "Show app traffic".

## Configuration

- `apps/dispatcher/wrangler.jsonc`: `analytics_engine_datasets: [{ binding: 'TRAFFIC', dataset: 'app_traffic_<env>' }]`; secret `TRAFFIC_SALT_SECRET`.
- `apps/api` needs no new binding (SQL over REST with `CF_API_TOKEN`).

## Cost and usage

Each request adds one Analytics Engine write (10 M/month included with Workers Paid, then $0.25 per million); `pricing.ts` adds `perRoutedRequestUsd += 0.25e-6` (spec 13 test updated). The reads (a handful of SQL queries per tool call) are negligible.

## Limits (`packages/shared/src/limits.ts`)

| Constant | Value |
|---|---|
| `ANALYTICS_TOP_N` | 10 |
| `ANALYTICS_PATH_MAX_CHARS` | 100 |

## Security and privacy notes

- No IPs, no full user agents, no cookies, no query strings (which often carry tokens or emails) are stored; the visitor hash is salted by day and truncated.
- Each app's rows are keyed by `index1`; the tool only ever queries the resolved app's id.
- Dispatcher-level collection also counts requests of bots and health checks; they're excluded from visitors/page views by the device label but still counted as requests.

## Open questions

1. A privacy notice snippet the AI can add for owners in regulated regions.
2. Visits vs page views vs sessions definitions if owners ask for "sessions".
3. Custom events from app code through a binding.
