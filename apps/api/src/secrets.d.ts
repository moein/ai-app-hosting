// Worker secrets (set with `pnpm secrets:<env>`); `wrangler types` can't see them, so they're declared here.
interface Env {
  LOGIN_CODE_PEPPER: string;
}

declare namespace Cloudflare {
  interface Env {
    LOGIN_CODE_PEPPER: string;
  }
}
