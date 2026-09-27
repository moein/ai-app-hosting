import { MAX_EMAIL_BYTES, MAX_EMAIL_RECIPIENTS } from '@repo/shared';

export type ValidMessage = {
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  fromName?: string;
};

// Pragmatic address check: one @, no spaces/quotes/angle brackets/control characters, a dotted domain.
const EMAIL =
  /^[^\s@"<>(),;:\\[\]]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
export const isEmail = (value: string) => value.length <= 254 && EMAIL.test(value);
const normalize = (value: string) => value.trim().toLowerCase();

/** Removes quotes, angle brackets, backslashes and line breaks; ≤ 64 characters (MAIL-2.3). */
export function sanitizeFromName(name: string): string {
  return [
    ...name
      .replace(/["<>\\\r\n\t]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, 64)
    .join('')
    .trim();
}

/** MAIL-2.4. The message comes from untrusted app code, so every field is checked at runtime. */
export function validateMessage(input: unknown): { ok: true; message: ValidMessage } | { ok: false; reason: string } {
  if (typeof input !== 'object' || input === null) return { ok: false, reason: 'message must be an object' };
  const msg = input as Record<string, unknown>;

  const rawTo = typeof msg.to === 'string' ? [msg.to] : msg.to;
  if (!Array.isArray(rawTo) || !rawTo.every((v): v is string => typeof v === 'string')) {
    return { ok: false, reason: '`to` must be an email address or an array of them' };
  }
  const to = [...new Set(rawTo.map(normalize))];
  if (to.length === 0) return { ok: false, reason: '`to` needs at least one recipient' };
  if (to.length > MAX_EMAIL_RECIPIENTS) return { ok: false, reason: `at most ${MAX_EMAIL_RECIPIENTS} recipients` };
  const bad = to.find((address) => !isEmail(address));
  if (bad !== undefined) return { ok: false, reason: `invalid recipient address: ${bad.slice(0, 100)}` };

  if (typeof msg.subject !== 'string' || msg.subject.length < 1 || msg.subject.length > 200) {
    return { ok: false, reason: '`subject` must be 1–200 characters' };
  }
  if (/[\r\n]/.test(msg.subject)) return { ok: false, reason: '`subject` must not contain line breaks' };

  for (const field of ['text', 'html', 'reply_to', 'from_name'] as const) {
    if (msg[field] !== undefined && typeof msg[field] !== 'string') {
      return { ok: false, reason: `\`${field}\` must be a string` };
    }
  }
  const text = msg.text as string | undefined;
  const html = msg.html as string | undefined;
  if (!text && !html) return { ok: false, reason: 'provide `text` or `html`' };

  let replyTo: string | undefined;
  if (msg.reply_to !== undefined) {
    replyTo = normalize(msg.reply_to as string);
    if (!isEmail(replyTo)) return { ok: false, reason: '`reply_to` is not a valid email address' };
  }

  const bytes = new TextEncoder().encode([msg.subject, text ?? '', html ?? '', ...to].join('')).byteLength;
  if (bytes > MAX_EMAIL_BYTES) return { ok: false, reason: `message exceeds ${MAX_EMAIL_BYTES} bytes` };

  const message: ValidMessage = { to, subject: msg.subject };
  if (text) message.text = text;
  if (html) message.html = html;
  if (replyTo) message.replyTo = replyTo;
  if (typeof msg.from_name === 'string') message.fromName = msg.from_name;
  return { ok: true, message };
}
