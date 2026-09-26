// Worker secrets (set with `wrangler secret put`); `wrangler types` can't see them, so they're declared here.
interface Env {
  E2E_INBOX_TOKEN: string;
}

declare namespace Cloudflare {
  interface Env {
    E2E_INBOX_TOKEN: string;
  }
}
