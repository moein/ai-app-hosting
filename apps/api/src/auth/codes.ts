import { type Random, randomString } from '@repo/shared';

const encoder = new TextEncoder();

/** Emails are compared and stored trimmed and lowercased (AUTH-1.2). `+tags` are kept. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Removes spaces and hyphens users often type (AUTH-2.2). */
export const stripCode = (code: string) => code.replace(/[\s-]/g, '');

/** Uniform 6-digit code, leading zeros kept (rejection sampling in randomString). */
export const generateLoginCode = (random: Random) => randomString(random, '0123456789', 6);

/** Hex HMAC-SHA256(pepper, "email:code") — only this is stored (AUTH-1.4). */
export async function hashLoginCode(pepper: string, email: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${email}:${code}`));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two hex hashes. */
export function hashesEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}
