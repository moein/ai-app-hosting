/** Resource names derived from an app slug (spec 01 design "Where slugs are used"). */
export const appResourceNames = (slug: string, environment: 'dev' | 'prod') => ({
  scriptName: slug,
  repoName: environment === 'dev' ? `dev-${slug}` : slug,
  d1DatabaseName: `app-${slug}-${environment}`,
});

export const dispatchNamespaceFor = (environment: 'dev' | 'prod') => `apps-${environment}`;

export const appUrl = (slug: string, appsDomain: string) => `https://${slug}.${appsDomain}`;
