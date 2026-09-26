import {
  LOGIN_CODE_TTL_MS,
  type Logger,
  type SendLoginCodeInput,
  type SendLoginCodeResult,
  toPlatformError,
} from '@repo/shared';
import type { ResendClient } from '../integrations/resend';

const minutes = Math.round(LOGIN_CODE_TTL_MS / 60_000);

/** Subject, text and HTML of the login-code email (AUTH-1.8). */
export function loginCodeContent(code: string): { subject: string; text: string; html: string } {
  const warning =
    'Only enter this code in an AI chat that you started yourself. Never share it with anyone else. If you did not ask for this code, you can ignore this email.';
  return {
    subject: `Your login code: ${code}`,
    text: `Your login code is: ${code}\n\nIt expires in ${minutes} minutes.\n\n${warning}\n`,
    html: `<p>Your login code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>It expires in ${minutes} minutes.</p><p>${warning}</p>`,
  };
}

/** Sends a login code through Resend (MAIL-3). Never logs the code; returns a result instead of throwing. */
export async function sendLoginCode(
  deps: { resend: ResendClient; platformMailDomain: string; environment: string; logger: Logger },
  input: SendLoginCodeInput,
): Promise<SendLoginCodeResult> {
  try {
    const { id } = await deps.resend.send(
      {
        from: `Login <login@${deps.platformMailDomain}>`,
        to: [input.to],
        ...loginCodeContent(input.code),
        tags: [
          { name: 'env', value: deps.environment },
          { name: 'kind', value: 'login_code' },
        ],
      },
      { idempotencyKey: `login-code/${input.codeId}` },
    );
    deps.logger.info('login code email sent', { codeId: input.codeId, resendId: id });
    return { ok: true, id };
  } catch (error) {
    const platformError = toPlatformError(error);
    deps.logger.warn('login code email failed', { codeId: input.codeId, code: platformError.code });
    return { ok: false, error: platformError.toJSON() };
  }
}
