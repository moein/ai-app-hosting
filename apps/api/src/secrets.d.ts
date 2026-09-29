// Worker secrets (set with `pnpm secrets:<env>`); `wrangler types` can't see them, so they're declared here.
interface PlatformSecrets {
  LOGIN_CODE_PEPPER: string;
  CF_API_TOKEN: string;
  /** R2's S3-compatible API for object-level operations (spec 15): CF_API_TOKEN only reaches bucket lifecycle. */
  R2_ACCESS_KEY: string;
  R2_SECRET_ACCESS_KEY: string;
  GITHUB_APP_ID: string;
  GITHUB_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  /** Optional until SNS is set up (scripts/setup-ses.mjs); /v1/ses/events rejects everything while unset. */
  SES_EVENTS_TOPIC_ARN?: string;
}

interface Env extends PlatformSecrets {}

declare namespace Cloudflare {
  interface Env extends PlatformSecrets {}
}
