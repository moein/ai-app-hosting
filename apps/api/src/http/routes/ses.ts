import { type Clock, Logger } from '@repo/shared';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Db } from '../../db/client';
import { applySesEvent } from '../../mail/ses-events';
import { isSnsUrl, type SnsEnvelope, SnsEnvelopeSchema, verifySnsSignature } from '../../mail/sns';
import { createPlatform } from '../../platform';
import type { AppEnv } from '../env';

export type SesRoutesDeps = {
  db: Db;
  clock: Clock;
  /** Full ARN of `ses-events-<env>`; while unset every request is rejected (spec 11 design). */
  topicArn: string | undefined;
  fetch?: typeof fetch;
};

type SesEnv = AppEnv & { Variables: { sns: SnsEnvelope } };

const forbidden = () => new Response(null, { status: 403 });

/** SES bounce/complaint events delivered by SNS (spec 11, MAIL-4). */
export function createSesRoutes(depsFor: (env: Env) => SesRoutesDeps) {
  // MAIL-4.1: parse the SNS envelope, check the topic, verify the signature.
  const snsSignature = () =>
    createMiddleware<SesEnv>(async (c, next) => {
      const deps = depsFor(c.env);
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        return forbidden();
      }
      const envelope = SnsEnvelopeSchema.safeParse(body);
      if (!envelope.success || !deps.topicArn || envelope.data.TopicArn !== deps.topicArn) return forbidden();
      if (!(await verifySnsSignature(envelope.data, deps.fetch))) {
        Logger.root.warn('SNS signature rejected', { messageId: envelope.data.MessageId });
        return forbidden();
      }
      c.set('sns', envelope.data);
      await next();
    });

  return new Hono<SesEnv>().use('/events', snsSignature()).post('/events', async (c) => {
    const deps = depsFor(c.env);
    const message = c.get('sns');
    const logger = Logger.root.child({ route: 'ses-events', messageId: message.MessageId });

    if (message.Type === 'SubscriptionConfirmation') {
      if (!isSnsUrl(message.SubscribeURL)) return forbidden();
      const response = await (deps.fetch ?? fetch)(message.SubscribeURL as string);
      logger.info('SNS subscription confirmed', { status: response.status });
      return c.body(null, response.ok ? 200 : 502);
    }
    if (message.Type === 'Notification') {
      let event: unknown;
      try {
        event = JSON.parse(message.Message);
      } catch {
        event = null;
      }
      await applySesEvent(deps.db, event, deps.clock.now(), logger);
    }
    return c.body(null, 200);
  });
}

export const sesRoutes = createSesRoutes((env) => {
  const platform = createPlatform(env);
  return { db: platform.db, clock: platform.clock, topicArn: env.SES_EVENTS_TOPIC_ARN || undefined };
});
