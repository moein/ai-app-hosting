/** Resource names derived from an app slug (spec 01 design "Where slugs are used"). */
export const appResourceNames = (slug: string, environment: 'dev' | 'prod') => ({
  scriptName: slug,
  repoName: environment === 'dev' ? `dev-${slug}` : slug,
  d1DatabaseName: `app-${slug}-${environment}`,
});

/**
 * The app's own R2 bucket name (spec 15, FILE-1.1). Unlike `d1DatabaseName`, this is computed by the `r2`
 * provisioning step itself rather than spread into the row at insert time: R2 has no separate opaque id the
 * way D1 does, so `apps.r2_bucket_name` staying null is what makes that step's idempotency check work.
 */
export const r2BucketNameFor = (slug: string, environment: 'dev' | 'prod') => `app-${slug}-${environment}`;

export const dispatchNamespaceFor = (environment: 'dev' | 'prod') => `apps-${environment}`;

export const appUrl = (slug: string, appsDomain: string) => `https://${slug}.${appsDomain}`;
