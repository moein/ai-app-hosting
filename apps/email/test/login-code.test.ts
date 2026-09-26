import { Logger, PlatformError } from '@repo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResendClient, ResendEmail } from '../src/integrations/resend';
import { loginCodeContent, sendLoginCode } from '../src/platform-mail/login-code';

const deps = (resend: ResendClient) => ({
  resend,
  platformMailDomain: 'mail.example',
  environment: 'dev',
  logger: new Logger({ test: true }),
});

describe('login code email (MAIL-3, AUTH-1.8)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('contains the code, its validity and the warning', () => {
    const { subject, text, html } = loginCodeContent('048213');
    expect(subject).toContain('048213');
    for (const body of [text, html]) {
      expect(body).toContain('048213');
      expect(body).toContain('10 minutes');
      expect(body).toContain('Only enter this code in an AI chat that you started yourself');
      expect(body).toContain('ignore this email');
    }
  });

  it('sends from login@<PLATFORM_MAIL_DOMAIN> with an idempotency key per code', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const sent: { email: ResendEmail; key: string }[] = [];
    const resend: ResendClient = {
      send: async (email, { idempotencyKey }) => {
        sent.push({ email, key: idempotencyKey });
        return { id: 'msg_1' };
      },
    };
    const result = await sendLoginCode(deps(resend), { to: 'a@b.co', code: '123456', codeId: 'lc_abc' });
    expect(result).toEqual({ ok: true, id: 'msg_1' });
    expect(sent[0]?.email.from).toBe('Login <login@mail.example>');
    expect(sent[0]?.email.to).toEqual(['a@b.co']);
    expect(sent[0]?.key).toBe('login-code/lc_abc');
    expect(sent[0]?.email.tags).toEqual([
      { name: 'env', value: 'dev' },
      { name: 'kind', value: 'login_code' },
    ]);
  });

  it('returns the error instead of throwing, and never logs the code', async () => {
    const logs = [vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map((spy) =>
      spy.mockImplementation(() => {}),
    );
    const resend: ResendClient = {
      send: async () => {
        throw new PlatformError('UPSTREAM_ERROR');
      },
    };
    const result = await sendLoginCode(deps(resend), { to: 'a@b.co', code: '987654', codeId: 'lc_x' });
    expect(result).toMatchObject({ ok: false, error: { code: 'UPSTREAM_ERROR', retryable: true } });
    const logged = logs.flatMap((spy) => spy.mock.calls.map((call) => String(call[0]))).join('\n');
    expect(logged).not.toContain('987654');
  });
});
