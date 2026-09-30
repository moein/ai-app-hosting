# 21 — Realtime: Design

## Topology

```
browser ─wss─▶ dispatcher ─▶ app Worker (its route authenticates, sets x-realtime-user/role)
                                 └─ env.REALTIME.fetch(upgrade request)  (service binding, entrypoint AppRealtime, props { appId, orgId, slug })
                                        └─ apps/realtime worker (realtime-<env>)
                                             ├─ Room DO   idFromName("<appId>:<room>")   (hibernating WebSockets, SQLite history)
                                             └─ AppRegistry DO idFromName("<appId>")     (connection caps per app, room counts)
app HTTP handler ─▶ env.REALTIME.publish(room, data) / connections(room) / list ─▶ same Room DO (RPC)
```

Platform-provided rooms instead of user-defined Durable Objects: user DO classes would need per-app migrations in uploaded scripts, arbitrary code owning durable state, and per-app DO billing that Cloudflare doesn't attribute to a script; a platform hub gives isolation (ids prefixed by app), caps, metering and a small, well-understood protocol. User-defined DOs can come with a later contract version.

**First task is a spike** (task 1): verify on dev that a WebSocket upgrade travels visitor → dispatcher → app Worker → `REALTIME.fetch` → Room DO and back (101 response with `webSocket` preserved through the service binding and the dispatch stub). If the chain can't carry it, fallback: the dispatcher itself recognizes the reserved path `/__live/<room>` and calls the hub directly, with the app authorizing joins via a short-lived signed ticket from `env.REALTIME.ticket(...)`. The requirements stay the same; the design section is amended with the outcome.

## Worker `apps/realtime`

- `wrangler.jsonc`: DO bindings `ROOM` (`Room`), `REGISTRY` (`AppRegistry`) with a `new_sqlite_classes` migration for both, `d1_databases` (`DB`: platform D1, for usage counters and app status), no secrets.
- Deployed with the other workers, before the api; the api needs a binding to it only for `list_realtime_rooms` (service binding `REALTIME_ADMIN` → entrypoint `RealtimeAdmin`, no app props).

### `AppRealtime` entrypoint (called by app scripts)

```ts
export class AppRealtime extends WorkerEntrypoint<Env, AppMailProps> {
  fetch(request: Request): Promise<Response>;     // WebSocket upgrade for GET /rooms/<name>[?echo=1]
  publish(room: string, data: unknown, options?: { from?: { id: string; name?: string } }): Promise<{ ok: true; delivered: number } | RtError>;
  connections(room: string): Promise<{ ok: true; count: number; users: { id: string; name?: string }[] } | RtError>;
}
type RtError = { ok: false; error: { code: 'invalid_room' | 'too_large' | 'rate_limited' | 'app_deleted'; message: string } };
```

`fetch` validates (method, `Upgrade: websocket`, room name → `426`/`400`), checks the app is active (D1, cached ≤ 60 s in the isolate), asks the registry (`acquire`), then forwards to the Room DO (`stub.fetch`) with the trusted user/role headers copied from the request into internal headers (`x-rt-user`, `x-rt-role`) and app id from props.

### `Room` DO (`apps/realtime/src/room.ts`)

- `fetch`: creates a `WebSocketPair`, `ctx.acceptWebSocket(server)` (hibernation API), stores per-socket state with `serializeAttachment` (`connectionId`, user, role, echo, connectedAt), sends `welcome`, broadcasts `presence`.
- `webSocketMessage(ws, message)`: rate limit (token bucket in memory rebuilt from the attachment's counters; sustained over the limit → close 1008), size check, JSON parse (`{ type: 'ping' | 'message' }`), role check, fan-out via `ctx.getWebSockets()`, history append (SQLite `history(id, ts, from_id, from_name, data)`, trimmed to `REALTIME_HISTORY_MESSAGES`), counters.
- `webSocketClose/Error`: presence update, registry release.
- `publish(data, from)` RPC (via the entrypoint): same fan-out and history path.
- `alarm()` (every minute while sockets exist; once after the last close): (1) report `count` to the registry, (2) flush usage counters to D1 (`addAppUsage`: `realtime_messages`, `realtime_connection_minutes` = Σ open sockets × elapsed minutes), (3) when no sockets: delete history older than `REALTIME_HISTORY_HOURS` and stop scheduling.
- Connections older than `REALTIME_MAX_CONNECTION_HOURS` are closed (1001, "reconnect") at the alarm; clients reconnect. This also closes sockets of deleted apps.

### `AppRegistry` DO (per app)

Keeps `rooms: Map<room, { count, reportedAt }>`. `acquire(room)` returns `ok` when `Σ counts (fresh entries) + 1 ≤ REALTIME_MAX_CONNECTIONS_PER_APP` (entries older than 3 minutes are ignored so a Room that vanished without reporting can't leak capacity) and the room's own count `< REALTIME_MAX_CONNECTIONS_PER_ROOM`; `report(room, count)` from Room alarms; `rooms()` for `list_realtime_rooms`.

### Protocol (JSON text frames)

```
client → hub   { "type": "message", "data": <any JSON, ≤ REALTIME_MAX_MESSAGE_BYTES> } | { "type": "ping" }
hub → client   { "type": "welcome", "connection_id", "users": [{id,name?}], "history": [{ "from": {id,name?}|null, "data", "ts" }] }
               { "type": "message", "from": {id,name?}|null, "data", "ts" }
               { "type": "presence", "users": [{id,name?}] }
               { "type": "pong" } | { "type": "error", "code": "read_only" | "too_large" | "invalid_message" | "rate_limited" }
```

## App-side contract (guide `guide/realtime.md`)

```ts
app.get('/api/live/:room', async (c) => {
  const user = await c.env.AUTH.getUser(getCookie(c, 'session') ?? '');       // or the app's own check
  if (!user) return c.text('sign in first', 401);
  const headers = new Headers(c.req.raw.headers);
  headers.set('x-realtime-user', JSON.stringify({ id: user.id, name: user.email.split('@')[0] }));
  return c.env.REALTIME.fetch(new Request(`https://realtime/rooms/${c.req.param('room')}`, { headers }));
});
app.post('/api/live/:room/publish', async (c) => c.json(await c.env.REALTIME.publish(c.req.param('room'), await c.req.json())));
```

Browser client (~30 lines, in the guide): `new WebSocket(`wss://${location.host}/api/live/${room}`)`, JSON messages, reconnect with exponential backoff, handle `welcome`/`presence`/`message`.

## Contract, bindings, dispatcher

- `buildBindings` adds `{ name: 'REALTIME', service: 'realtime-<env>', entrypoint: 'AppRealtime', props }`; `RESERVED_BINDINGS` gains `'REALTIME'`; `contract.md` bindings list gains it; fixture routes as above.
- `apps/dispatcher/src/route.ts`: `if (response.status === 101) return response` before HSTS/cookie handling (rewrapping would lose the `webSocket`). Tested with a fake 101.
- Cookies: the WebSocket upgrade carries the app's cookies like any request; cookie isolation (spec 09) still applies to the request headers the app sees.

## Tool

```
list_realtime_rooms  in { app }   out { rooms: { name: string; connections: number }[]; total_connections: number; limits: { per_room: number; per_app: number }; next_step: string }
```

Annotations `{ readOnly, idempotent }`; title "List live rooms". Implemented through `RealtimeAdmin.rooms(appId)` (service binding from the api).

## Usage (spec 13)

`usage.ts` gains `realtime_messages` and `realtime_connection_minutes` (flow, add); `pricing.ts` prices them (Durable Objects request pricing with the 20:1 WebSocket message ratio, and a duration-based per-connection-minute estimate assuming hibernation; both verified against Cloudflare's pricing at implementation, dated by `asOf`). Written by Room alarms with `addAppUsage`.

## Limits (`packages/shared/src/limits.ts`)

| Constant | Value |
|---|---|
| `REALTIME_MAX_CONNECTIONS_PER_ROOM` | 100 |
| `REALTIME_MAX_CONNECTIONS_PER_APP` | 500 |
| `REALTIME_MAX_MESSAGE_BYTES` | 16_384 |
| `REALTIME_MAX_MESSAGES_PER_SECOND` | 10 |
| `REALTIME_HISTORY_MESSAGES` | 50 |
| `REALTIME_HISTORY_HOURS` | 24 |
| `REALTIME_MAX_CONNECTION_HOURS` | 12 |

## Security notes

- Isolation by construction: Room ids are `<appId>:<room>` with the app id from binding props; an app can't name another app's room.
- Authorization is the app's job (its route decides who upgrades and with which role); the hub trusts only headers arriving through the app's own binding.
- Clients can't spoof `from`: it's set by the hub from the trusted attachment; message `data` is opaque and never interpreted.
- Abuse bounds: connection caps, message size and rate, history cap, and metering; no persistent user data beyond the history TTL.

## Open questions

1. Optional message persistence (D1-backed) for longer chat history.
2. Per-room `viewer`-only broadcast channels for one-to-many announcements.
3. Custom Durable Object classes for advanced apps.
