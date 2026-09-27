// Worker secrets (set with `pnpm secrets:<env>`); `wrangler types` can't see them, so they're declared here.
interface Env {
  RESEND_API_KEY: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  CF_API_TOKEN: string;
}

declare namespace Cloudflare {
  interface Env {
    RESEND_API_KEY: string;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    CF_API_TOKEN: string;
  }
}
