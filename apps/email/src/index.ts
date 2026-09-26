import { WorkerEntrypoint } from 'cloudflare:workers';
import { Logger, type PlatformMailRpc, type SendLoginCodeInput, type SendLoginCodeResult } from '@repo/shared';
import { parseEnv } from './env';
import { createResendClient } from './integrations/resend';
import { sendLoginCode } from './platform-mail/login-code';

/** RPC entrypoint used by the api worker for platform emails (Resend). */
export class PlatformMail extends WorkerEntrypoint<Env> implements PlatformMailRpc {
  async sendLoginCode(input: SendLoginCodeInput): Promise<SendLoginCodeResult> {
    const env = parseEnv(this.env);
    return sendLoginCode(
      {
        resend: createResendClient(env.RESEND_API_KEY),
        platformMailDomain: env.PLATFORM_MAIL_DOMAIN,
        environment: env.ENVIRONMENT,
        logger: Logger.root.child({ worker: 'email', entrypoint: 'PlatformMail' }),
      },
      input,
    );
  }
}

// AppMail (SES) and the tenant queue consumer land with the rest of spec 11. No HTTP routes.
export default {
  fetch(_request, env) {
    parseEnv(env);
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
