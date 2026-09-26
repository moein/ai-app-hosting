import { e2eEnv } from './env';

export type InboxMessage = {
  id: string;
  to: string;
  from: string;
  subject: string;
  text: string | null;
  html: string | null;
  received_at: number;
};

const POLL_INTERVAL_MS = 2_000;

/** Polls the e2e inbox until a message for `to` (received at/after `since`) matches, or times out (E2E-2.3). */
export async function waitForEmail(options: {
  to: string;
  since: number;
  timeoutMs?: number;
  match?: (message: InboxMessage) => boolean;
}): Promise<InboxMessage> {
  const { E2E_INBOX_ORIGIN, E2E_INBOX_TOKEN } = e2eEnv();
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const url = new URL('/messages', E2E_INBOX_ORIGIN);
  url.searchParams.set('to', options.to);
  url.searchParams.set('since', String(options.since));

  for (;;) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${E2E_INBOX_TOKEN}` } });
    if (!res.ok) throw new Error(`e2e inbox responded ${res.status}: ${await res.text()}`);
    const { messages } = (await res.json()) as { messages: InboxMessage[] };
    const found = messages.find(options.match ?? (() => true));
    if (found) return found;
    if (Date.now() >= deadline) {
      throw new Error(`No email for ${options.to} within ${options.timeoutMs ?? 60_000} ms (saw ${messages.length})`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** The 6-digit login code from a login email. */
export function extractLoginCode(message: InboxMessage): string {
  const code = /\b(\d{6})\b/.exec(`${message.subject}\n${message.text ?? ''}`)?.[1];
  if (!code) throw new Error(`No 6-digit code in email "${message.subject}"`);
  return code;
}
