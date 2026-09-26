import { PlatformError } from './errors';
import { type Random, randomString } from './random';

export type SlugKind = 'app' | 'org';
export type SlugFailure =
  | 'too_short'
  | 'too_long'
  | 'invalid_chars'
  | 'invalid_start'
  | 'invalid_end'
  | 'double_hyphen'
  | 'reserved';

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 63;
const BASE_MAX_LENGTH = 58; // leaves room for "-xxxx" (SLUG-2.4)
const SUFFIX_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const MAX_ATTEMPTS = 5;

/** Reserved for platform use (spec 01 design). Applies to app and org slugs. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(
  `abuse account accounts admin administrator api app apps assets auth autoconfig
  autodiscover billing blog cdn cloudflare console dashboard dev dns docs e2e email
  ftp github help hostmaster imap internal localhost login logout mail mcp
  noreply no-reply ns1 ns2 ns3 ns4 platform pop pop3 postmaster prod root
  security signin signup smtp staging static status support system test
  webmail webmaster wpad www`
    .split(/\s+/)
    .filter(Boolean),
);

/** DNS-label validation, first failing rule wins (SLUG-1). */
export function validateSlug(slug: string): { ok: true } | { ok: false; reason: SlugFailure } {
  if (slug.length < SLUG_MIN_LENGTH) return { ok: false, reason: 'too_short' };
  if (slug.length > SLUG_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  if (/[^a-z0-9-]/.test(slug)) return { ok: false, reason: 'invalid_chars' };
  if (!/^[a-z]/.test(slug)) return { ok: false, reason: 'invalid_start' };
  if (!/[a-z0-9]$/.test(slug)) return { ok: false, reason: 'invalid_end' };
  if (slug.includes('--')) return { ok: false, reason: 'double_hyphen' };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, reason: 'reserved' };
  return { ok: true };
}

/** Readable base derived from a name (SLUG-2.1 – 2.4). */
export function slugBase(name: string, kind: SlugKind): { base: string; forceSuffix: boolean } {
  let base = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (/^[0-9]/.test(base)) base = `${kind}-${base}`;
  let forceSuffix = false;
  if (base.length < SLUG_MIN_LENGTH) {
    base = kind;
    forceSuffix = true;
  }
  return { base: base.slice(0, BASE_MAX_LENGTH).replace(/-+$/, ''), forceSuffix };
}

export const randomSuffix = (random: Random) => randomString(random, SUFFIX_ALPHABET, 4);

/** Local part of an email without a `+tag`, used to name the personal org (SLUG-2.7). */
export function orgNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  return local.split('+')[0] ?? '';
}

/** A valid, available slug for `name`, suffixing on collision or reservation (SLUG-2.5, SLUG-2.6). */
export async function generateSlug(
  name: string,
  kind: SlugKind,
  isTaken: (slug: string) => Promise<boolean>,
  random: Random,
): Promise<string> {
  const { base, forceSuffix } = slugBase(name, kind);
  let candidate = forceSuffix ? `${base}-${randomSuffix(random)}` : base;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (validateSlug(candidate).ok && !(await isTaken(candidate))) return candidate;
    candidate = `${base}-${randomSuffix(random)}`;
  }
  throw new PlatformError('INTERNAL', { message: `Could not generate a free slug for "${name}".` });
}
