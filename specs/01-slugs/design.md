# 01 — Slugs: Design

## Where slugs are used

| Use | Derived value | Constraint that shaped the rules |
|---|---|---|
| App subdomain | `<slug>.APPS_DOMAIN` | DNS label: ≤ 63, `[a-z0-9-]`, no leading/trailing hyphen |
| Worker script name (dispatch namespace) | `<slug>` | lowercase, `[a-z0-9-]` |
| GitHub repo name | `<slug>` (prod) / `dev-<slug>` (dev) | ≤ 100 chars |
| App D1 database name | `app-<slug>-<env>` | account-unique names |
| SES sender local part | `<slug>@APPS_MAIL_DOMAIN` | RFC 5321 local part |
| SES tenant name | uses org **ID**, not slug (spec 11) | — |

`--` is banned so that (a) `xn--` punycode labels are impossible, and (b) `--` stays free as a future separator (e.g. `<app>--<preview>.APPS_DOMAIN`).

## Module: `packages/shared/slugs.ts`

```ts
type SlugKind = 'app' | 'org';
type SlugFailure = 'too_short' | 'too_long' | 'invalid_chars' | 'invalid_start'
                 | 'invalid_end' | 'double_hyphen' | 'reserved';

validateSlug(s: string): { ok: true } | { ok: false; reason: SlugFailure };
slugBase(name: string, kind: SlugKind): { base: string; forceSuffix: boolean };
randomSuffix(random: Random): string;                     // 4 chars [0-9a-z]
generateSlug(name: string, kind: SlugKind,
             isTaken: (s: string) => Promise<boolean>,
             random: Random): Promise<string>;
orgNameFromEmail(email: string): string;                  // local part, '+tag' removed
```

### Validation order (SLUG-1.6)

1. length < 3 → `too_short`
2. length > 63 → `too_long`
3. `/[^a-z0-9-]/` → `invalid_chars`
4. first char not `[a-z]` → `invalid_start`
5. last char not `[a-z0-9]` → `invalid_end`
6. contains `--` → `double_hyphen`
7. in `RESERVED_SLUGS` → `reserved`

### Generation algorithm

```
base = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
          .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
if /^[0-9]/.test(base): base = `${kind}-${base}`
forceSuffix = false
if base.length < 3: base = kind; forceSuffix = true
base = base.slice(0, 58).replace(/-+$/, '')

candidate = forceSuffix ? `${base}-${suffix()}` : base
for attempt in 1..5:
  if validateSlug(candidate).ok && !(await isTaken(candidate)): return candidate
  candidate = `${base}-${suffix()}`
throw PlatformError('INTERNAL')
```

`suffix()` draws 4 chars uniformly from `0123456789abcdefghijklmnopqrstuvwxyz` using rejection sampling on `crypto.getRandomValues` (36^4 ≈ 1.7M combinations per base).

Examples:

| Input | Kind | Result (if free) |
|---|---|---|
| `My Todo App` | app | `my-todo-app` |
| `Café Crème!!` | app | `cafe-creme` |
| `2048 Game` | app | `app-2048-game` |
| `🍕` | app | `app-k3x9` |
| `API` | app | `api-7fq2` (reserved → suffix) |
| `moein+test@tropee.com` | org | `moein` |

### Race handling (SLUG-3.3)

`isTaken` is a best-effort pre-check. The authoritative check is the `UNIQUE` index at insert time. Callers wrap *generate + insert* in a loop: on a unique-constraint violation for a generated slug, regenerate with a forced suffix (counts toward the 5 attempts). For a requested slug, a violation maps to `SLUG_UNAVAILABLE`.

## Reserved list

`RESERVED_SLUGS` (exported constant, reviewed in PRs):

```
abuse account accounts admin administrator api app apps assets auth autoconfig
autodiscover billing blog cdn cloudflare console dashboard dev dns docs e2e email
ftp github help hostmaster imap internal localhost login logout mail mcp
noreply no-reply ns1 ns2 ns3 ns4 platform pop pop3 postmaster prod root
security signin signup smtp staging static status support system test
webmail webmaster wpad www
```

Applies to both kinds (one list keeps it simple; org slugs may become subdomains later).

## Data model

Slug columns live on their owners (spec 03):

```sql
organizations.slug TEXT NOT NULL UNIQUE
apps.slug          TEXT NOT NULL UNIQUE   -- rows are soft-deleted, so deleted slugs stay taken (SLUG-3.2)
```

Org and app slugs are separate namespaces (an org and an app may share a slug).

## MCP surface

- `create_app({ name, slug? })` — spec 03/04.
- `check_slug({ slug })` → `{ slug, valid, available, reason?, suggestion? }` (SLUG-4.3).

## Error codes (added to `packages/shared/errors.ts`)

| Code | retryable | Hint |
|---|---|---|
| `SLUG_INVALID` | false | The address isn't valid (`details.reason`). Use `details.suggestion` or ask the user for another. |
| `SLUG_UNAVAILABLE` | false | That address is taken. Offer the user `details.suggestion` or ask for another. |

## Open questions

1. Do we need a profanity / trademark blocklist before public launch?
2. Should org and app slugs share one namespace (future `<org>.APPS_DOMAIN` vanity pages)?
3. Should slugs of deleted apps ever be released (e.g. after 90 days, once repo/DB are purged)?
