// Set on the env by the OAuth provider for the default handler (spec 02, AUTH-4); `wrangler types` can't see it.
interface OAuthEnv {
  OAUTH_PROVIDER: import('@cloudflare/workers-oauth-provider').OAuthHelpers;
}

interface Env extends OAuthEnv {}

declare namespace Cloudflare {
  interface Env extends OAuthEnv {}
}
