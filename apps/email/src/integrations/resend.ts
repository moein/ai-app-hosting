import { Logger, PlatformError } from '@repo/shared';

export type ResendEmail = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  tags: { name: string; value: string }[];
};

export interface ResendClient {
  send(email: ResendEmail, options: { idempotencyKey: string }): Promise<{ id: string }>;
}

const API = 'https://api.resend.com/emails';

/** Resend REST client with the platform's error mapping (MAIL-3.3). */
export function createResendClient(apiKey: string, fetchImpl: typeof fetch = fetch): ResendClient {
  return {
    async send(email, { idempotencyKey }) {
      let response: Response;
      try {
        response = await fetchImpl(API, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify(email),
        });
      } catch (error) {
        throw new PlatformError('UPSTREAM_ERROR', { message: 'Could not reach the email provider.', cause: error });
      }
      if (response.ok) {
        const { id } = (await response.json()) as { id: string };
        return { id };
      }
      const body = await response.text();
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new PlatformError('UPSTREAM_ERROR', {
          message: 'The email provider is temporarily unavailable.',
          ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { details: { retry_after_seconds: retryAfter } } : {}),
        });
      }
      Logger.root.error('resend rejected the request', { status: response.status, body: body.slice(0, 500) });
      throw new PlatformError('INTERNAL');
    },
  };
}
