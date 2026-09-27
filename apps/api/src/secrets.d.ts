// Worker secrets (set with `pnpm secrets:<env>`); `wrangler types` can't see them, so they're declared here.
interface PlatformSecrets {
  LOGIN_CODE_PEPPER: string;
  CF_API_TOKEN: string;
  GITHUB_APP_ID: string;
  GITHUB_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
}

interface Env extends PlatformSecrets {}

declare namespace Cloudflare {
  interface Env extends PlatformSecrets {}
}
