# 20 — App Analytics: Tasks

Depends on: 09 (dispatcher), 13 (pricing), 04 (tool catalog).

- [ ] **1. `buildTrafficPoint` (pure) + tests**
  Path normalization, kind/device/referrer classification, visitor hash, slot layout.
  Satisfies: ANLY-1.1 (layout), ANLY-1.2, ANLY-1.3, ANLY-1.4, ANLY-1.5
  Tests: path table (ids, uuids, hex, long tokens, query/fragment dropped, truncation, garbage → `/`); kind table (api, navigations, assets); bot/mobile/tablet/desktop user agents; referrer cases; the point contains no IP, UA or query string (serialize and scan); hash differs by day and by visitor, is stable within a day; secret changes the hash.

- [ ] **2. Dispatcher integration + config + secret**
  `TRAFFIC` binding, `TRAFFIC_SALT_SECRET` in `set-secrets.mjs` (generated), write in `waitUntil`-free synchronous fashion after the response, failure swallowed with metric.
  Satisfies: ANLY-1.1, ANLY-1.6, ANLY-3.3
  Tests (fake dataset): one point per dispatched request (live apps only — not 404/503 platform pages); a throwing dataset doesn't affect the response; response bytes/duration captured; WebSocket 101 responses recorded once.

- [ ] **3. `AnalyticsClient` + query builder + `get_app_analytics`**
  Satisfies: ANLY-2.1, ANLY-2.2, ANLY-2.3
  Tests: SQL text per period and section against fixtures; appId assertion refuses anything but the id shape; result assembly incl. empty data, sampling note, unavailable old periods; requires ready app; catalog conformance; read-only annotations.

- [ ] **4. Pricing update + guide**
  `perRoutedRequestUsd`, `guide` section (new `analytics` topic or in `troubleshooting.md`: "is anyone using my app?").
  Satisfies: ANLY-2.4, ANLY-3.1, ANLY-3.2
  Tests: spec 13 cost test updated; guide mentions what is/isn't measured.

- [ ] **5. E2E on dev** (spec 12)
  Flows: `F-ANLY-1` (slow-ish: deploy the fixture; make page and API requests with a referrer and a 404 path; poll `get_app_analytics` up to 5 minutes until page views ≥ the number sent, the referrer host and the 404 path appear; a raw Analytics Engine query of that app's rows contains no IP address).
  Satisfies: E2E-3.3
