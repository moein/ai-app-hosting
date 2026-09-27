import { AwsClient } from 'aws4fetch';

export type SesSendInput = {
  from: string;
  to: string[];
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  configurationSet: string;
  tenant: string;
  tags: Record<string, string>;
};

/** An SES/STS failure. `type` is the AWS error type (e.g. `SendingPausedException`), or `NetworkError`. */
export class SesError extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SesError';
  }

  /** Worth retrying later (throttling, AWS-side failures, network). */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.type === 'TooManyRequestsException' || this.status === 0;
  }
}

/** SES v2 operations the email worker needs (spec 11). A fake backs tests. */
export interface SesClient {
  sendEmail(input: SesSendInput): Promise<{ messageId: string }>;
  createTenant(name: string, tags: Record<string, string>): Promise<'created' | 'exists'>;
  associateTenantResource(tenant: string, resourceArn: string): Promise<'created' | 'exists'>;
  /** Domain identity with Easy DKIM (RSA 2048), sending through the configuration set. */
  createEmailIdentity(
    domain: string,
    options: { configurationSet: string; tags: Record<string, string> },
  ): Promise<'created' | 'exists'>;
  getEmailIdentity(domain: string): Promise<{ verified: boolean; dkimTokens: string[] } | null>;
  deleteEmailIdentity(domain: string): Promise<'deleted' | 'not_found'>;
  deleteTenant(name: string): Promise<'deleted' | 'not_found'>;
  /** The AWS account id of the credentials (STS GetCallerIdentity), for building resource ARNs. */
  accountId(): Promise<string>;
}

export type SesClientOptions = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  fetch?: typeof fetch;
};

const tagList = (tags: Record<string, string>) => Object.entries(tags).map(([Name, Value]) => ({ Name, Value }));

/** SES v2 REST client, SigV4-signed with aws4fetch. */
export function createSesClient(options: SesClientOptions): SesClient {
  const aws = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    region: options.region,
    retries: 0,
  });
  const fetchImpl = options.fetch ?? fetch;
  const base = `https://email.${options.region}.amazonaws.com/v2/email`;
  let accountId: Promise<string> | undefined;

  async function call<T>(service: 'ses' | 'sts', url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      const signed = await aws.sign(url, { ...init, aws: { service, region: options.region } });
      response = await fetchImpl(signed);
    } catch (error) {
      throw new SesError('NetworkError', 0, error instanceof Error ? error.message : String(error));
    }
    const text = await response.text();
    if (response.ok) return (service === 'sts' ? text : text ? JSON.parse(text) : {}) as T;
    const type =
      (response.headers.get('x-amzn-errortype') ?? '').split(':')[0] ||
      /<Code>(.+?)<\/Code>/.exec(text)?.[1] ||
      `Http${response.status}`;
    let message = text.slice(0, 500);
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {}
    throw new SesError(type, response.status, message);
  }

  const post = <T>(path: string, body: unknown) =>
    call<T>('ses', `${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const deletedOrMissing = async (request: Promise<unknown>) => {
    try {
      await request;
      return 'deleted' as const;
    } catch (error) {
      if (error instanceof SesError && error.type === 'NotFoundException') return 'not_found' as const;
      throw error;
    }
  };

  const createdOrExists = async (request: Promise<unknown>) => {
    try {
      await request;
      return 'created' as const;
    } catch (error) {
      if (error instanceof SesError && error.type === 'AlreadyExistsException') return 'exists' as const;
      throw error;
    }
  };

  return {
    async sendEmail(input) {
      const body = {
        FromEmailAddress: input.from,
        Destination: { ToAddresses: input.to },
        ...(input.replyTo ? { ReplyToAddresses: [input.replyTo] } : {}),
        Content: {
          Simple: {
            Subject: { Data: input.subject, Charset: 'UTF-8' },
            Body: {
              ...(input.text === undefined ? {} : { Text: { Data: input.text, Charset: 'UTF-8' } }),
              ...(input.html === undefined ? {} : { Html: { Data: input.html, Charset: 'UTF-8' } }),
            },
          },
        },
        ConfigurationSetName: input.configurationSet,
        TenantName: input.tenant,
        EmailTags: tagList(input.tags),
      };
      const result = await post<{ MessageId: string }>('/outbound-emails', body);
      return { messageId: result.MessageId };
    },
    createTenant(name, tags) {
      return createdOrExists(
        post('/tenants', { TenantName: name, Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) }),
      );
    },
    associateTenantResource(tenant, resourceArn) {
      return createdOrExists(post('/tenants/resources', { TenantName: tenant, ResourceArn: resourceArn }));
    },
    createEmailIdentity(domain, { configurationSet, tags }) {
      return createdOrExists(
        post('/identities', {
          EmailIdentity: domain,
          ConfigurationSetName: configurationSet,
          DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        }),
      );
    },
    async getEmailIdentity(domain) {
      try {
        const identity = await call<{ VerificationStatus?: string; DkimAttributes?: { Tokens?: string[] } }>(
          'ses',
          `${base}/identities/${encodeURIComponent(domain)}`,
          { method: 'GET' },
        );
        return {
          verified: identity.VerificationStatus === 'SUCCESS',
          dkimTokens: identity.DkimAttributes?.Tokens ?? [],
        };
      } catch (error) {
        if (error instanceof SesError && error.type === 'NotFoundException') return null;
        throw error;
      }
    },
    deleteEmailIdentity(domain) {
      return deletedOrMissing(call('ses', `${base}/identities/${encodeURIComponent(domain)}`, { method: 'DELETE' }));
    },
    deleteTenant(name) {
      return deletedOrMissing(post('/tenants/delete', { TenantName: name }));
    },
    accountId() {
      accountId ??= call<string>('sts', `https://sts.${options.region}.amazonaws.com/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'Action=GetCallerIdentity&Version=2011-06-15',
      })
        .then((xml) => {
          const id = /<Account>(\d{12})<\/Account>/.exec(xml)?.[1];
          if (!id) throw new SesError('InvalidResponse', 200, 'STS returned no account id');
          return id;
        })
        .catch((error: unknown) => {
          accountId = undefined; // don't cache failures
          throw error;
        });
      return accountId;
    },
  };
}
