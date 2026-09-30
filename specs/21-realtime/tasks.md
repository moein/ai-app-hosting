# 21 — Realtime: Tasks

Depends on: 09 (dispatcher, bindings), 13 (usage), 16 (AUTH, used by the guide/e2e recipe).

- [ ] **1. Spike: WebSocket path on dev**
  A throwaway Room DO + entrypoint + fixture route prove the full chain (visitor → dispatcher → app → `REALTIME.fetch` → DO → back), including 101 passthrough at the dispatcher and the dispatch stub. Record the result (and amend the design if the fallback is needed); the spike code becomes task 2's starting point if it works.
  Satisfies: LIVE-5.2 (feasibility)
  Tests: manual on dev with a Node `WebSocket` client.

- [ ] **2. `apps/realtime` worker: `Room` DO + `AppRealtime.fetch`**
  Upgrade handling, welcome/presence/message/ping, viewer role, echo, history in SQLite, rate limit, size limit, close codes.
  Satisfies: LIVE-1.1–1.6, LIVE-3.2, LIVE-3.3
  Tests (pool-workers with the real DO): two sockets exchange messages; sender excluded unless `echo`; viewer rejected; presence joins/leaves and duplicate user ids; history replayed on join and trimmed; oversize/invalid messages; rate limit closes 1008; hibernation round-trip (attachments survive); room isolation between apps.

- [ ] **3. `publish` / `connections` + `AppRegistry` caps**
  Satisfies: LIVE-2.1–2.3, LIVE-3.1, LIVE-3.4
  Tests: publish reaches all sockets and history; `delivered` count; invalid room names; caps per room and per app (stale registry entries ignored); deleted app refused; errors never thrown.

- [ ] **4. Metering + alarms**
  Alarm loop, usage flush (`addAppUsage`), max connection age, history TTL, pricing entries.
  Satisfies: LIVE-4.2, LIVE-3.3, LIVE-3.4
  Tests: counters flushed per minute and on last close; connection minutes math; alarm stops when empty; history deleted after TTL; spec 13 catalog/price coverage tests updated.

- [ ] **5. Binding, dispatcher 101 passthrough, contract, guide, fixture**
  `REALTIME` binding, `RESERVED_BINDINGS`, dispatcher change, `guide/realtime.md`, fixture routes, deploy script includes `realtime`.
  Satisfies: LIVE-5.1, LIVE-5.2, LIVE-4.3
  Tests: bindings list exact; `vars.REALTIME` → CON-R10; dispatcher passes a 101 through with its socket; guide content.

- [ ] **6. `list_realtime_rooms` tool + `RealtimeAdmin`**
  Satisfies: LIVE-4.1
  Tests: rooms with counts and totals; requires ready app; catalog conformance.

- [ ] **7. E2E on dev** (spec 12)
  Flows: `F-LIVE-1` (fixture app: two Node WebSocket clients in a room — messages relay, history and presence work, a viewer can't send, an over-limit message errors), `F-LIVE-2` (`publish` route reaches connected clients; `list_realtime_rooms` shows the connections; usage rows appear after the next collection/alarm flush).
  Satisfies: E2E-3.3
