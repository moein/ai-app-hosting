import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  type AppEmailResult,
  type AppMailProps,
  createMetrics,
  type EmailJob,
  Logger,
  type PlatformMailRpc,
  type SendLoginCodeInput,
  type SendLoginCodeResult,
} from '@repo/shared';
import { sendAppEmail } from './app-mail/send';
import { parseEnv } from './env';
import { createDnsClient } from './integrations/cloudflare-dns';
import { createResendClient } from './integrations/resend';
import { createSesClient, type SesClient } from './integrations/ses';
import { handleEmailJobs } from './jobs/email-jobs';
import { sendLoginCode } from './platform-mail/login-code';

// One client per isolate so the STS account-id lookup is cached.
let ses: { key: string; client: SesClient } | undefined;
function sesClient(env: ReturnType<typeof parseEnv>): SesClient {
  if (ses?.key !== env.AWS_ACCESS_KEY_ID) {
    ses = {
      key: env.AWS_ACCESS_KEY_ID,
      client: createSesClient({
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        region: env.AWS_REGION,
      }),
    };
  }
  return ses.client;
}

/** RPC entrypoint used by the api worker for platform emails (Resend). */
export class PlatformMail extends WorkerEntrypoint<Env> implements PlatformMailRpc {
  async sendLoginCode(input: SendLoginCodeInput): Promise<SendLoginCodeResult> {
    const env = parseEnv(this.env);
    const result = await sendLoginCode(
      {
        resend: createResendClient(env.RESEND_API_KEY),
        platformMailDomain: env.PLATFORM_MAIL_DOMAIN,
        environment: env.ENVIRONMENT,
        logger: Logger.root.child({ worker: 'email', entrypoint: 'PlatformMail' }),
      },
      input,
    );
    const metrics = createMetrics(this.env.METRICS, Logger.root.child({ worker: 'email' }));
    if (result.ok) metrics.write('email_sent', { sub: 'platform', outcome: 'ok' });
    else metrics.write('email_rejected', { sub: 'platform', outcome: 'error', errorCode: result.error.code });
    return result;
  }
}

/** The EMAIL binding of app scripts (SES). Who is sending comes only from the platform-set props (MAIL-2.2). */
export class AppMail extends WorkerEntrypoint<Env, AppMailProps> {
  async send(message: unknown): Promise<AppEmailResult> {
    const logger = Logger.root.child({ worker: 'email', entrypoint: 'AppMail' });
    try {
      const env = parseEnv(this.env);
      return await sendAppEmail(
        {
          db: this.env.DB,
          ses: sesClient(env),
          environment: env.ENVIRONMENT,
          appsDomain: env.APPS_DOMAIN,
          configurationSet: env.SES_CONFIGURATION_SET,
          now: Date.now,
          metrics: createMetrics(this.env.METRICS, logger),
          logger,
        },
        this.ctx.props,
        message,
      );
    } catch (error) {
      logger.error('AppMail.send failed', { error });
      return { ok: false, error: { code: 'send_failed', message: 'The email could not be sent. Try again later.' } };
    }
  }
}

export default {
  fetch(_request, env) {
    parseEnv(env);
    return new Response(null, { status: 404 });
  },
  async queue(batch, env) {
    const parsed = parseEnv(env);
    await handleEmailJobs(batch as MessageBatch<EmailJob>, {
      db: env.DB,
      ses: sesClient(parsed),
      environment: parsed.ENVIRONMENT,
      region: parsed.AWS_REGION,
      dns: createDnsClient({ apiToken: parsed.CF_API_TOKEN, zoneName: parsed.APPS_DOMAIN }),
      appsDomain: parsed.APPS_DOMAIN,
      configurationSet: parsed.SES_CONFIGURATION_SET,
      metrics: createMetrics(env.METRICS, Logger.root.child({ worker: 'email' })),
      logger: Logger.root.child({ worker: 'email', consumer: 'email-jobs' }),
    });
  },
} satisfies ExportedHandler<Env, EmailJob>;
