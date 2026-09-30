# 20 — App Analytics: Requirements

App owners want to know if anyone is using their app: how many visitors this week, which pages, where they came from, whether errors are happening. Every request to an app already passes through the dispatcher, which sees pages and static assets that never reach the app's own code. The dispatcher records one privacy-friendly data point per request, and an MCP tool answers "how is my app doing?" from them. No cookies, no IP addresses, no query strings, no scripts in the app's pages.

## Stories & acceptance criteria

### ANLY-1 — Collecting traffic
As the platform, I want a data point per request, so that owners can see traffic.

- **ANLY-1.1** FOR every request the dispatcher forwards to a live app THE SYSTEM SHALL write one Analytics Engine data point to the `app_traffic_<env>` dataset without delaying the response, containing: app id (index), request kind (`page`, `asset`, `api`), normalized path, status class, country, device class, referrer host, an anonymous visitor hash, and count / response bytes / duration.
- **ANLY-1.2** THE SYSTEM SHALL NOT record IP addresses, cookies, query strings, headers other than those mapped above, or request/response bodies.
- **ANLY-1.3** THE visitor hash SHALL be a truncated HMAC of client IP and user agent keyed with a secret combined with the UTC date, so it can't be linked across days or reversed; visitors are counted as distinct hashes per period (approximate under sampling).
- **ANLY-1.4** THE SYSTEM SHALL normalize paths: drop query and fragment, lowercase the host part only (not the path), replace segments that look like identifiers (all digits ≥ 4, UUIDs, hex ≥ 12, mixed alphanumeric ≥ 16) with `:id`, truncate to `ANALYTICS_PATH_MAX_CHARS`, and map anything unparseable to `/`.
- **ANLY-1.5** THE SYSTEM SHALL classify `kind` as `api` for `/api/` paths, `page` for GET/HEAD navigations (`Sec-Fetch-Dest: document` or an HTML `Accept` without a file extension) and `asset` otherwise; bots (user agent matching a known-bot pattern) are labelled device `bot` and excluded from visitor and page-view counts.
- **ANLY-1.6** WHEN writing fails THE SYSTEM SHALL swallow the error (never affecting the request) and count `analytics_write_failed` in metrics.

### ANLY-2 — Reading traffic
As an AI client, I want a summary, so that I can tell the owner how the app is doing.

- **ANLY-2.1** WHEN `get_app_analytics({ app, period? })` is called (`period`: `24h`, `7d` (default), `30d`) THE SYSTEM SHALL return: total page views, unique visitors, API requests, error requests (5xx) and their share; the top `ANALYTICS_TOP_N` pages, referrers, countries and devices with counts; the paths with the most 4xx/5xx; and a daily series of page views and visitors.
- **ANLY-2.2** THE tool SHALL be read-only, require a ready app of the caller, use only that app's data (the app id comes from the resolved app, never from user text), and report `data_note` when the period is partly not yet available or sampled.
- **ANLY-2.3** THE SYSTEM SHALL keep traffic data for Analytics Engine's retention (3 months); older periods are reported as unavailable, not empty.
- **ANLY-2.4** THE guide SHALL explain what is measured and what is not (privacy), that numbers are approximate, and how to answer "is anyone using my app?".

### ANLY-3 — Privacy and cost
- **ANLY-3.1** THE guide SHALL tell the AI that analytics are built in (no tracking scripts, cookie banners or third-party analytics are needed for basic traffic counts).
- **ANLY-3.2** THE SYSTEM SHALL account the analytics writes in the routed-request overhead of the cost model (spec 13 pricing) so their cost is visible.
- **ANLY-3.3** WHEN an app is deleted THE SYSTEM SHALL stop recording (its route is gone) and keep existing data until retention expires.

## Non-functional requirements

- Zero added latency to requests: `writeDataPoint` is synchronous and non-blocking; all mapping is O(1) string work.
- `get_app_analytics` p95 < 2 s (a handful of Analytics Engine SQL queries).
- Data points appear in queries within about 2 minutes.

## Out of scope

- Per-user tracking, funnels, events sent by the app's own code, session replay, A/B tests, data export, alerts, UTM breakdowns (later).
- Analytics for requests the dispatcher never sees.
