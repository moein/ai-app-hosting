import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import {
  type Clock,
  LOGIN_CODES_PER_SIGN_IN,
  type Logger,
  type Metrics,
  OAUTH_PENDING_TTL_S,
  type PlatformError,
  type PlatformMailRpc,
  toPlatformError,
} from '@repo/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { issueLoginCode, type LoginDeps, verifyLoginCode } from '../../auth/login-codes';
import { codePage, emailPage, errorPage, type SignInView } from '../../oauth/pages';
import { createPlatform } from '../../platform';
import type { AppEnv } from '../env';

export type AuthorizeDeps = {
  login: LoginDeps;
  oauth: OAuthHelpers;
  kv: KVNamespace;
  /** Per-IP limit on sign-in posts (AUTH-1.6). */
  limiter: { limit(options: { key: string }): Promise<{ success: boolean }> };
  origin: string;
  clock: Clock;
  metrics: Metrics;
  logger: Logger;
};

type Pending = { oauthReq: AuthRequest; clientName: string; redirectHost: string; email?: string; codesSent: number };

/**
 * No `form-action` (would otherwise restrict form posts to same-origin): some browsers' CSP matching for it
 * is unreliable in ways that block a legitimate same-origin submission (seen with a Thorium build, even
 * naming the exact origin explicitly instead of `'self'`). It would only be defense-in-depth here anyway —
 * `default-src 'none'` with no `script-src` already makes script execution impossible on these pages, so
 * there's no XSS vector for it to guard against; the real CSRF defense is `guardPost` below (AUTH-4.8).
 */
const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
const html = (body: string, status = 200) => new Response(body, { status, headers: HEADERS });
const EXPIRED = () =>
  html(errorPage('This sign-in has expired', 'Go back to your AI app and connect again to start a new sign-in.'), 400);

const Email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const randomId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};
const minutes = (error: PlatformError) => Math.max(1, Math.ceil(Number(error.details?.retry_after_seconds ?? 60) / 60));

/** The OAuth sign-in pages (spec 02, AUTH-1, AUTH-2, AUTH-4.4, AUTH-4.8). */
export function createAuthorizeRoutes(depsFor: (env: Env) => AuthorizeDeps) {
  const view = (id: string, pending: Pending, extra: Partial<SignInView> = {}): SignInView => ({
    pendingId: id,
    clientName: pending.clientName,
    redirectHost: pending.redirectHost,
    ...(pending.email ? { email: pending.email } : {}),
    ...extra,
  });

  const load = async (deps: AuthorizeDeps, id: string) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    return deps.kv.get<Pending>(`pending:${id}`, 'json');
  };
  const save = (deps: AuthorizeDeps, id: string, pending: Pending) =>
    deps.kv.put(`pending:${id}`, JSON.stringify(pending), { expirationTtl: OAUTH_PENDING_TTL_S });

  /**
   * AUTH-4.8 and the per-IP limit, for every form post. `Sec-Fetch-Site` is a Fetch Metadata header the
   * browser computes and the page can't override (unlike `Origin`/`Referer`), so it's checked first when
   * present (OWASP's current recommendation). Some browsers send a same-origin post with `Origin: null` and
   * no `Referer` at all (seen with a Thorium build) but still set `Sec-Fetch-Site: same-origin` correctly, so
   * this is also what unblocks them. Falls back to `Origin` (ignoring the opaque literal `"null"`), then
   * `Referer`, for the rare client without Fetch Metadata support. Returns a response to send instead, or the
   * form.
   */
  const guardPost = async (deps: AuthorizeDeps, request: Request) => {
    const secFetchSite = request.headers.get('sec-fetch-site');
    const sameOrigin =
      secFetchSite !== null
        ? secFetchSite === 'same-origin'
        : (() => {
            const expected = new URL(deps.origin).origin;
            const origin = request.headers.get('origin');
            const referer = request.headers.get('referer');
            const refererOrigin = referer ? URL.parse(referer)?.origin : null;
            return (origin && origin !== 'null' ? origin : refererOrigin) === expected;
          })();
    if (!sameOrigin) {
      return {
        stop: html(errorPage('Not allowed', 'This form can only be sent from the sign-in page.'), 403),
      };
    }
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (!(await deps.limiter.limit({ key: `sign-in:${ip}` })).success) {
      return { stop: html(errorPage('Too many attempts', 'Please wait a minute and try again.'), 429) };
    }
    const form = await request.formData();
    return { form: (name: string) => String(form.get(name) ?? '') };
  };

  async function sendCode(deps: AuthorizeDeps, id: string, pending: Pending, email: string): Promise<Response> {
    if (pending.codesSent >= LOGIN_CODES_PER_SIGN_IN) {
      return html(
        emailPage(
          view(id, pending, {
            email,
            error: 'Too many codes for this sign-in. Wait a few minutes, then connect again from your AI app.',
          }),
        ),
        429,
      );
    }
    try {
      await issueLoginCode(deps.login, email, deps.clock.now());
    } catch (raw) {
      const error = toPlatformError(raw);
      const message =
        error.code === 'RATE_LIMITED'
          ? `Too many codes for this email. Try again in ${minutes(error)} minutes.`
          : error.code === 'EMAIL_UNDELIVERABLE'
            ? "We can't deliver email to this address. Please use a different email."
            : "We couldn't send the email. Please try again.";
      if (error.code === 'INTERNAL') deps.logger.error('login code send failed', { error: raw });
      return html(
        emailPage(view(id, { ...pending, email }, { error: message })),
        error.code === 'RATE_LIMITED' ? 429 : 400,
      );
    }
    const updated = { ...pending, email, codesSent: pending.codesSent + 1 };
    await save(deps, id, updated);
    deps.metrics.write('login_code_requested', { sub: pending.clientName });
    return html(codePage({ ...view(id, updated), email }));
  }

  return new Hono<AppEnv>()
    .get('/', async (c) => {
      const deps = depsFor(c.env);
      let oauthReq: AuthRequest;
      try {
        oauthReq = await deps.oauth.parseAuthRequest(c.req.raw);
      } catch (error) {
        deps.logger.warn('invalid authorization request', { error });
        return html(
          errorPage('Something is wrong with this link', 'Go back to your AI app and try connecting again.'),
          400,
        );
      }
      const client = await deps.oauth.lookupClient(oauthReq.clientId);
      if (!client) return html(errorPage('Unknown app', 'Go back to your AI app and try connecting again.'), 400);
      const id = randomId();
      const pending: Pending = {
        oauthReq,
        clientName: client.clientName?.trim() || new URL(oauthReq.redirectUri).host,
        redirectHost: new URL(oauthReq.redirectUri).host,
        codesSent: 0,
      };
      await save(deps, id, pending);
      return html(emailPage(view(id, pending)));
    })
    .post('/email', async (c) => {
      const deps = depsFor(c.env);
      const post = await guardPost(deps, c.req.raw);
      if ('stop' in post) return post.stop;
      const id = post.form('pending');
      const pending = await load(deps, id);
      if (!pending) return EXPIRED();
      const email = Email.safeParse(post.form('email'));
      if (!email.success) {
        return html(
          emailPage(view(id, pending, { email: post.form('email'), error: 'Please enter a valid email address.' })),
          400,
        );
      }
      return sendCode(deps, id, pending, email.data);
    })
    .post('/resend', async (c) => {
      const deps = depsFor(c.env);
      const post = await guardPost(deps, c.req.raw);
      if ('stop' in post) return post.stop;
      const id = post.form('pending');
      const pending = await load(deps, id);
      if (!pending?.email) return EXPIRED();
      return sendCode(deps, id, pending, pending.email);
    })
    .post('/restart', async (c) => {
      const deps = depsFor(c.env);
      const post = await guardPost(deps, c.req.raw);
      if ('stop' in post) return post.stop;
      const id = post.form('pending');
      const pending = await load(deps, id);
      if (!pending) return EXPIRED();
      const { email: _previous, ...rest } = pending;
      return html(emailPage(view(id, rest)));
    })
    .post('/code', async (c) => {
      const deps = depsFor(c.env);
      const post = await guardPost(deps, c.req.raw);
      if ('stop' in post) return post.stop;
      const id = post.form('pending');
      const pending = await load(deps, id);
      if (!pending?.email) return EXPIRED();
      const email = pending.email;
      let identity: Awaited<ReturnType<typeof verifyLoginCode>>;
      try {
        identity = await verifyLoginCode(deps.login, email, post.form('code'), deps.clock.now());
      } catch (raw) {
        const error = toPlatformError(raw);
        deps.metrics.write('login_failed', { sub: error.code, outcome: 'error', errorCode: error.code });
        if (error.code === 'ACCOUNT_BLOCKED') {
          return html(errorPage('This account is blocked', 'Please contact support.'), 403);
        }
        const left = Number(error.details?.attempts_remaining ?? 0);
        const message =
          error.code === 'CODE_EXPIRED'
            ? 'This code has expired. Send a new one below.'
            : error.code === 'CODE_INVALID' && left > 0
              ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
              : error.code === 'CODE_INVALID' || error.code === 'CODE_ATTEMPTS_EXCEEDED'
                ? 'That code no longer works. Send a new one below.'
                : 'Something went wrong. Please try again.';
        if (error.code === 'INTERNAL') deps.logger.error('login code verify failed', { error: raw });
        return html(codePage({ ...view(id, pending, { error: message }), email }), 400);
      }
      const { redirectTo } = await deps.oauth.completeAuthorization({
        request: pending.oauthReq,
        userId: identity.userId,
        metadata: { label: email, client: pending.clientName },
        scope: pending.oauthReq.scope,
        props: { userId: identity.userId, orgId: identity.orgId, email },
      });
      await deps.kv.delete(`pending:${id}`);
      deps.metrics.write('login_succeeded', {
        orgId: identity.orgId,
        userId: identity.userId,
        sub: identity.isNewUser ? 'signup' : 'signin',
        clientName: pending.clientName,
      });
      return c.redirect(redirectTo, 302);
    });
}

export const authorizeRoutes = createAuthorizeRoutes((env) => {
  const platform = createPlatform(env);
  return {
    login: {
      db: platform.db,
      random: platform.random,
      pepper: env.LOGIN_CODE_PEPPER,
      mailer: env.MAIL as unknown as PlatformMailRpc,
      emailJobs: env.EMAIL_JOBS,
    },
    oauth: env.OAUTH_PROVIDER,
    kv: env.OAUTH_KV,
    limiter: env.LOGIN_RATE_LIMITER,
    origin: env.PLATFORM_API_ORIGIN,
    clock: platform.clock,
    metrics: platform.metrics,
    logger: platform.logger.child({ route: 'authorize' }),
  };
});
