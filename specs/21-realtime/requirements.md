# 21 — Realtime: Requirements

Some apps need live updates: a chat, a shared shopping list that updates on everyone's phone, a live scoreboard, "who's online". A single Worker can't hold connections across requests, so the platform provides rooms: the `REALTIME` binding lets an app's route hand a WebSocket to a platform-run room that relays messages between everyone connected, keeps a short history, tracks presence, and lets the app's server code publish to a room. The app decides *who* may join (its own routes authenticate, e.g. with spec 16); the platform runs the rooms, enforces limits and meters usage.

## Stories & acceptance criteria

### LIVE-1 — Rooms
As an app, I want to connect my visitors to a named room, so that they see each other's messages instantly.

- **LIVE-1.1** WHEN an app route forwards a WebSocket upgrade request to `env.REALTIME.fetch(request)` for room `<name>` THE SYSTEM SHALL connect the visitor to that room of that app; room names match `[A-Za-z0-9_.:-]{1,64}` and are scoped to the app (two apps can use the same name without meeting).
- **LIVE-1.2** THE app SHALL be able to pass who the visitor is (`x-realtime-user`: JSON `{ id, name? }`) and their role (`x-realtime-role`: `member` (default) or `viewer`); THE SYSTEM SHALL treat these as set by the app (trusted for that app) and never accept them from the visitor's own message.
- **LIVE-1.3** WHEN a connection is accepted THE SYSTEM SHALL send `{ "type": "welcome", "connection_id", "users", "history" }` (current users of the room and the last `REALTIME_HISTORY_MESSAGES` messages from the last `REALTIME_HISTORY_HOURS` hours).
- **LIVE-1.4** WHEN a `member` sends `{ "type": "message", "data": <JSON> }` THE SYSTEM SHALL deliver `{ "type": "message", "from": { id, name }, "data", "ts" }` to every other connection in the room (and to the sender when the connection was opened with `?echo=1`), and add it to the history; `viewer` messages are rejected with `{ "type": "error", "code": "read_only" }`.
- **LIVE-1.5** WHEN users join or leave THE SYSTEM SHALL send `{ "type": "presence", "users": [...] }` to the room; the same user id connected twice appears once.
- **LIVE-1.6** THE SYSTEM SHALL answer `{ "type": "ping" }` with `{ "type": "pong" }` and use WebSocket hibernation so idle rooms cost (almost) nothing.

### LIVE-2 — Server-side publishing
- **LIVE-2.1** WHEN app code calls `env.REALTIME.publish(room, data, { from? })` THE SYSTEM SHALL deliver `{ "type": "message", "from": <from or null>, "data", "ts" }` to all connections of the room, add it to the history, and return `{ ok: true, delivered }`.
- **LIVE-2.2** WHEN app code calls `env.REALTIME.connections(room)` THE SYSTEM SHALL return `{ ok: true, count, users }`.
- **LIVE-2.3** ALL binding methods SHALL return `{ ok: false, error: { code, message } }` instead of throwing (`invalid_room`, `too_large`, `rate_limited`, `app_deleted`).

### LIVE-3 — Limits
As the operator, I want bounded resource use, so that one app can't run up the bill.

- **LIVE-3.1** THE SYSTEM SHALL cap a room at `REALTIME_MAX_CONNECTIONS_PER_ROOM` connections and an app at `REALTIME_MAX_CONNECTIONS_PER_APP` in total (upgrades over the cap answer `429`).
- **LIVE-3.2** THE SYSTEM SHALL reject messages over `REALTIME_MAX_MESSAGE_BYTES` (`{ "type": "error", "code": "too_large" }`) and close a connection that sends more than `REALTIME_MAX_MESSAGES_PER_SECOND` sustained (`1008`).
- **LIVE-3.3** THE SYSTEM SHALL delete a room's history `REALTIME_HISTORY_HOURS` after its last message and NOT keep any other room data.
- **LIVE-3.4** WHEN an app is deleted THE SYSTEM SHALL refuse new connections and close existing ones on their next message or at the connection age limit `REALTIME_MAX_CONNECTION_HOURS`.

### LIVE-4 — Operating and metering
- **LIVE-4.1** WHEN `list_realtime_rooms({ app })` is called THE SYSTEM SHALL return the app's rooms that have connections (name, connection count), the app total and the caps.
- **LIVE-4.2** THE SYSTEM SHALL record per app and day (spec 13): `realtime_messages` (messages received from clients and published) and `realtime_connection_minutes`, and price them.
- **LIVE-4.3** THE guide (new topic `realtime`) SHALL document the server route that upgrades and forwards, the browser client (connect, reconnect with backoff, message shape), authentication through the app's own routes, publishing from HTTP handlers, the limits, and that messages are ephemeral apart from the short history.

### LIVE-5 — Binding and delivery path
- **LIVE-5.1** THE SYSTEM SHALL add `REALTIME` (service binding to the platform's `AppRealtime` entrypoint with props `{ appId, orgId, slug }`) to every deployed app; `REALTIME` becomes a reserved binding name.
- **LIVE-5.2** THE dispatcher SHALL pass WebSocket (101) responses through unchanged.

## Non-functional requirements

- Message fan-out within 250 ms for a room at capacity.
- Room state survives hibernation (history and presence are rebuilt from storage and socket attachments).
- No message contents are logged or tracked; only counts.

## Out of scope

- Message persistence beyond the short history, delivery guarantees/acks, direct messages between specific users, binary frames, presence beyond join/leave, WebRTC/voice/video, user-defined Durable Objects (a later contract version).
