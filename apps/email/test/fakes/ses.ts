import { type SesClient, SesError, type SesSendInput } from '../../src/integrations/ses';

/** In-memory SES: records sends, tenants and associations; failures can be injected per method. */
export function fakeSes() {
  const sent: SesSendInput[] = [];
  const tenants = new Map<string, Set<string>>();
  const identities = new Map<string, { verified: boolean; configurationSet: string; tags: Record<string, string> }>();
  const failures = new Map<keyof SesClient, SesError>();
  const check = (method: keyof SesClient) => {
    const failure = failures.get(method);
    if (failure) throw failure;
  };
  const client: SesClient = {
    async sendEmail(input) {
      check('sendEmail');
      sent.push(input);
      return { messageId: `msg-${sent.length}` };
    },
    async createTenant(name) {
      check('createTenant');
      if (tenants.has(name)) return 'exists';
      tenants.set(name, new Set());
      return 'created';
    },
    async associateTenantResource(tenant, arn) {
      check('associateTenantResource');
      const resources = tenants.get(tenant);
      if (!resources) throw new SesError('NotFoundException', 404, `tenant ${tenant} not found`);
      if (resources.has(arn)) return 'exists';
      resources.add(arn);
      return 'created';
    },
    async createEmailIdentity(domain, { configurationSet, tags }) {
      check('createEmailIdentity');
      if (identities.has(domain)) return 'exists';
      identities.set(domain, { verified: false, configurationSet, tags });
      return 'created';
    },
    async getEmailIdentity(domain) {
      check('getEmailIdentity');
      const identity = identities.get(domain);
      if (!identity) return null;
      return { verified: identity.verified, dkimTokens: ['tok1', 'tok2', 'tok3'].map((t) => `${t}-${domain.length}`) };
    },
    async accountId() {
      check('accountId');
      return '123456789012';
    },
  };
  return {
    client,
    sent,
    tenants,
    identities,
    /** Simulates SES finishing DKIM verification. */
    verify: (domain: string) => {
      const identity = identities.get(domain);
      if (identity) identity.verified = true;
    },
    fail: (method: keyof SesClient, error: SesError) => failures.set(method, error),
    clear: () => failures.clear(),
  };
}
