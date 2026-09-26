import { customAlphabet } from 'nanoid';
import { e2eEnv } from './env';

/** Unique per test-file process; every identity a test creates derives from it (E2E-1.4). */
export const runId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8)();

/** `<local>+<runId>-<n>@<domain>` — a subaddress of E2E_INBOX_ADDRESS, delivered to the e2e inbox. */
export function testEmail(n: number | string): string {
  const [local, domain] = e2eEnv().E2E_INBOX_ADDRESS.split('@') as [string, string];
  return `${local}+${runId}-${n}@${domain}`;
}

export const appName = (n: number | string) => `e2e ${runId} ${n}`;
