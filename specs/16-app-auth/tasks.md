# 16 — App User Sign-in: Tasks

Depends on: 02 (login-code rules), 09 (bindings, contract), 11 (SES sender, `AppMail`, suppression, quota), 13 (usage), 05 (redaction).

- [ ] **1. Schema + ids + hash scope**
  Migration for the four tables, `newId('eu')`, `hashLoginCode` scoped by app id, limit constants.
  Satisfies: UAUTH-2.3
  Tests: migration applies; ids have the prefix; app-scoped hash differs per app.

- [ ] **2. `AppAuth.startLogin` / `finishLogin`**
  Satisfies: UAUTH-1.1–1.7, UAUTH-2.1, UAUTH-2.5
  Tests: sends from the app's sender with app name; identical responses for unknown/allowed/suppressed; rate limits (email/hour, app/day, org quota); attempts and expiry; single use under concurrency; signup vs signin; session cap revokes oldest; failure to send invalidates + refunds; not-ready identity; deleted app.

- [ ] **3. `getUser` / `logout` / `logoutEverywhere` / `updateUser`**
  Satisfies: UAUTH-2.2, UAUTH-2.4, UAUTH-2.6, UAUTH-2.7, UAUTH-5.3
  Tests: sliding expiry with touch interval; expired/revoked → null; tokens of another app unknown; name length limit; app deleted behaviour.

- [ ] **4. Policy + tools** (`set_auth_policy`, `list_app_users`, `delete_app_user`)
  Satisfies: UAUTH-3.1–3.4, UAUTH-4.1–4.4
  Tests: open ↔ allowlist; email and domain matches; revoked sessions on tightening; pagination and count; idempotent delete cascades sessions/codes; requires ready app; redaction; catalog conformance (titles, annotations).

- [ ] **5. Binding, contract, guide, fixture**
  `AUTH` in `buildBindings`, `RESERVED_BINDINGS`, `guide/auth.md`, contract bindings list, fixture routes.
  Satisfies: UAUTH-5.1, UAUTH-5.2
  Tests: bindings list exactly matches; `vars.AUTH` → CON-R10; guide contains the API and recipe; fixture passes the validator and builds.

- [ ] **6. Daily purge of expired sessions/codes** (api cron)
  Satisfies: UAUTH-5.4
  Tests: expired rows removed, live ones kept.

- [ ] **7. E2E on dev** (spec 12)
  Flows: `F-UAUTH-1` (fixture app: start login → real email in the e2e inbox from `hello@mail.<slug>…` → finish → `/api/me` returns the user; logout), `F-UAUTH-2` (allowlist: a non-listed address gets no email; `list_app_users` shows the user; `delete_app_user` then `/api/me` → 401).
  Satisfies: E2E-3.3
