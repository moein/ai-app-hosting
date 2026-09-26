# 01 — Slugs: Requirements

Every organization and every app has a globally unique slug that is valid as a DNS label. An app's slug is its subdomain: `<app-slug>.APPS_DOMAIN`.

## Stories & acceptance criteria

### SLUG-1 — Validation
As the platform, I want every slug to be a safe DNS label, so that it can always be used as a subdomain, Worker script name, repo name and D1 database name.

- **SLUG-1.1** THE SYSTEM SHALL accept a slug only if its length is between 3 and 63 characters inclusive.
- **SLUG-1.2** THE SYSTEM SHALL accept a slug only if it contains only lowercase ASCII letters `a-z`, digits `0-9` and hyphens `-`.
- **SLUG-1.3** THE SYSTEM SHALL accept a slug only if it starts with a letter and ends with a letter or digit.
- **SLUG-1.4** THE SYSTEM SHALL reject any slug containing two consecutive hyphens (`--`).
- **SLUG-1.5** THE SYSTEM SHALL reject any slug that appears in the reserved list (design.md).
- **SLUG-1.6** WHEN `validateSlug(s)` is called THE SYSTEM SHALL return `{ ok: true }` or `{ ok: false, reason }` where `reason ∈ { too_short, too_long, invalid_chars, invalid_start, invalid_end, double_hyphen, reserved }` (first failing rule in that order).

### SLUG-2 — Generation from a name
As a non-technical user, I want a readable address generated from my app's name, so that I don't have to invent one.

- **SLUG-2.1** WHEN a slug is generated from a name THE SYSTEM SHALL derive a base by: Unicode NFKD normalization, removing combining marks, lowercasing, replacing every run of characters outside `[a-z0-9]` with a single hyphen, and trimming leading/trailing hyphens.
- **SLUG-2.2** IF the base starts with a digit THEN THE SYSTEM SHALL prefix it with the kind prefix (`app-` for apps, `org-` for orgs).
- **SLUG-2.3** IF the base is shorter than 3 characters after SLUG-2.1–2.2 THEN THE SYSTEM SHALL use the kind word (`app` or `org`) as the base and force a random suffix.
- **SLUG-2.4** THE SYSTEM SHALL truncate the base to at most 58 characters (so a 5-character suffix fits within 63) and re-trim trailing hyphens after truncation.
- **SLUG-2.5** IF the base is reserved or already taken THEN THE SYSTEM SHALL append `-` plus 4 random characters from `[0-9a-z]` and check again, up to 5 attempts, after which it SHALL fail with `INTERNAL`.
- **SLUG-2.6** THE SYSTEM SHALL only ever return generated slugs that pass `validateSlug`.
- **SLUG-2.7** WHEN an organization slug is generated at signup THE SYSTEM SHALL use the local part of the user's email (before `@`, with any `+tag` removed) as the name.

### SLUG-3 — Uniqueness
As the platform, I want slugs to be unique, so that every subdomain and resource name maps to exactly one entity.

- **SLUG-3.1** THE SYSTEM SHALL enforce uniqueness of organization slugs across all organizations with a database unique index.
- **SLUG-3.2** THE SYSTEM SHALL enforce uniqueness of app slugs across all apps, **including deleted apps**, with a database unique index.
- **SLUG-3.3** WHEN two creations race for the same slug THE SYSTEM SHALL let exactly one win and SHALL retry the loser per SLUG-2.5 (for generated slugs) or return `SLUG_UNAVAILABLE` (for requested slugs).
- **SLUG-3.4** THE SYSTEM SHALL NOT allow changing an org or app slug in v1.

### SLUG-4 — Requested app slug
As a user, I want to pick my app's address when I have one in mind, so that it's memorable.

- **SLUG-4.1** WHEN `create_app` is called with an explicit `slug` IF it fails validation THEN THE SYSTEM SHALL return `SLUG_INVALID` with `details.reason` and `details.suggestion` (a valid generated slug from the same input).
- **SLUG-4.2** WHEN `create_app` is called with an explicit valid `slug` IF it is taken or reserved THEN THE SYSTEM SHALL return `SLUG_UNAVAILABLE` with `details.suggestion` (an available slug generated from it) and SHALL NOT create the app.
- **SLUG-4.3** WHEN `check_slug` is called THE SYSTEM SHALL report whether the slug is valid and available, with a suggestion when it is not.

## Non-functional requirements

- Slug functions are pure and synchronous except the availability check, which is injected (`isTaken(slug) => Promise<boolean>`), so they are unit-testable without D1.
- Randomness comes from `crypto.getRandomValues` via the injectable `Random` interface.

## Out of scope

- Renaming slugs, slug history/redirects.
- Profanity/brand-abuse filtering beyond the reserved list (see open questions).
- Internationalized (punycode) slugs.
