# Backlog — good to have

Items deliberately deferred until **a full dev version works end to end** (all feature E2E tasks passing on dev). Each item gets a proper spec change (requirements → design → tasks) before any code.

| # | Item | Why | Touches |
|---|---|---|---|
| ~~1~~ | ~~**Per-org SES sending subdomain**~~ — superseded (2026-09-27): every app now has its own SES identity `mail.<slug>.APPS_DOMAIN` (spec 11). Old text: **Per-org SES sending subdomain** `<org-slug>.APPS_MAIL_DOMAIN` (e.g. `<org>.mail.motad.app`): a verified SES identity per org, created with its DKIM / MAIL FROM / DMARC records via the Cloudflare DNS API and associated with the org's tenant; apps send from `<slug>@<org-slug>.APPS_MAIL_DOMAIN`. | SES tenants isolate reputation inside SES only; mailbox providers judge by domain, so today one spammy org hurts inbox placement for all apps on the shared `APPS_MAIL_DOMAIN`. | spec 11 (tenant provisioning, `AppMail` from address), spec 01 (org slug becomes part of a hostname) |
