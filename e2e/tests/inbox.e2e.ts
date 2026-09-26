import { describe, expect, it } from 'vitest';
import { e2eEnv } from '../src/env';
import { flow } from '../src/flows';
import { waitForEmail } from '../src/inbox';
import { runId, testEmail } from '../src/run';

describe('e2e inbox', () => {
  it(flow('F-E2E-1', 'a probe sent through Resend to a fresh subaddress arrives in the e2e inbox'), async () => {
    const { RESEND_API_KEY, E2E_PROBE_FROM } = e2eEnv();
    if (!RESEND_API_KEY || !E2E_PROBE_FROM) throw new Error('F-E2E-1 needs RESEND_API_KEY and E2E_PROBE_FROM in .env');
    const to = testEmail('probe');
    const since = Date.now() - 1_000;
    const subject = `e2e probe ${runId}`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: E2E_PROBE_FROM, to: [to], subject, text: `probe for run ${runId}` }),
    });
    expect(res.status, await res.clone().text()).toBe(200);

    const message = await waitForEmail({ to, since, timeoutMs: 120_000, match: (m) => m.subject === subject });
    expect(message.to).toBe(to);
    expect(message.text).toContain(runId);
  });
});
