# 14 — Website: Tasks

**Descoped (2026-09-30):** the homepage is its own project, separate from this repository. The worker built for it (`apps/website`: step flow, prompt builder, Claude screenshots) was removed from the repo and the platform's deploy (it stays in git history, commit `eb42bdd`, for reuse). The apex `APPS_DOMAIN` is served by the dispatcher again (404 page, `PLATFORM_WEBSITE_URL` empty), and `www.` follows RUN-1.2. Requirements and design are kept as the brief for that project; nothing here is implemented or tracked in this repo any more.

- [x] **1–5.** Built and verified on dev (worker, prompt builder, step flow, screenshots, `F-WEB-1`), then removed with this descoping.
- [x] **6.** Moot: the deferred OAuth wording update belongs to the separate homepage project (connect step and prompt should follow `docs/connect.md`: add the connector, sign in on the page Claude opens, then chat — no in-chat login).
