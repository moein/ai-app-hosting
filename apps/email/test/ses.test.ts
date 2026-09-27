import { describe, expect, it, vi } from 'vitest';
import { createSesClient, SesError } from '../src/integrations/ses';

function client(respond: (req: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(req.clone());
    return respond(req);
  });
  const ses = createSesClient({
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
    region: 'eu-central-1',
    fetch: fetchImpl as typeof fetch,
  });
  return { ses, requests };
}
const awsError = (status: number, type: string, message = 'boom') =>
  new Response(JSON.stringify({ message }), {
    status,
    headers: { 'x-amzn-errortype': `${type}:http://internal.amazon.com/coral/com.amazonaws.sesv2/` },
  });

describe('SesClient (spec 11 task 2)', () => {
  it('signs SendEmail with SigV4 for ses in the region and sends the SES v2 body', async () => {
    const { ses, requests } = client(() => Response.json({ MessageId: 'm-1' }));
    const result = await ses.sendEmail({
      from: '"Todo" <todo@mail.dev.motad.app>',
      to: ['a@example.com'],
      replyTo: 'r@example.com',
      subject: 'Hi',
      text: 'Hello',
      configurationSet: 'apps-dev',
      tenant: 'dev-org_1',
      tags: { env: 'dev', org_id: 'org_1', app_id: 'app_1' },
    });
    expect(result).toEqual({ messageId: 'm-1' });
    const req = requests[0] as Request;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails');
    expect(req.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/ses\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
    expect(req.headers.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/);
    expect(await req.json()).toEqual({
      FromEmailAddress: '"Todo" <todo@mail.dev.motad.app>',
      Destination: { ToAddresses: ['a@example.com'] },
      ReplyToAddresses: ['r@example.com'],
      Content: {
        Simple: { Subject: { Data: 'Hi', Charset: 'UTF-8' }, Body: { Text: { Data: 'Hello', Charset: 'UTF-8' } } },
      },
      ConfigurationSetName: 'apps-dev',
      TenantName: 'dev-org_1',
      EmailTags: [
        { Name: 'env', Value: 'dev' },
        { Name: 'org_id', Value: 'org_1' },
        { Name: 'app_id', Value: 'app_1' },
      ],
    });
  });

  it('treats AlreadyExists as success for tenants and associations', async () => {
    let calls = 0;
    const { ses, requests } = client(() =>
      ++calls === 1 ? Response.json({}) : awsError(400, 'AlreadyExistsException'),
    );
    expect(await ses.createTenant('dev-org_1', { org_id: 'org_1', env: 'dev' })).toBe('created');
    expect(await ses.createTenant('dev-org_1', {})).toBe('exists');
    expect(await ses.associateTenantResource('dev-org_1', 'arn:x')).toBe('exists');
    expect(requests[0]?.url).toMatch(/\/v2\/email\/tenants$/);
    expect(await requests[0]?.json()).toEqual({
      TenantName: 'dev-org_1',
      Tags: [
        { Key: 'org_id', Value: 'org_1' },
        { Key: 'env', Value: 'dev' },
      ],
    });
    expect(requests[2]?.url).toMatch(/\/v2\/email\/tenants\/resources$/);
  });

  it.each([
    [awsError(400, 'SendingPausedException'), 'SendingPausedException', false],
    [awsError(404, 'NotFoundException'), 'NotFoundException', false],
    [awsError(429, 'TooManyRequestsException'), 'TooManyRequestsException', true],
    [awsError(503, 'InternalFailure'), 'InternalFailure', true],
    [
      new Response('<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>', { status: 403 }),
      'AccessDenied',
      false,
    ],
  ])('maps errors to SesError (%#)', async (response, type, retryable) => {
    const { ses } = client(() => response);
    const error = await ses
      .sendEmail({ from: 'f', to: ['t@x.co'], subject: 's', text: 't', configurationSet: 'c', tenant: 't', tags: {} })
      .catch((e) => e);
    expect(error).toBeInstanceOf(SesError);
    expect(error).toMatchObject({ type, retryable });
  });

  it('maps network failures to a retryable SesError', async () => {
    const { ses } = client(() => {
      throw new TypeError('network down');
    });
    const error = await ses.createTenant('t', {}).catch((e) => e);
    expect(error).toMatchObject({ type: 'NetworkError', retryable: true });
  });

  it('resolves and caches the account id via STS, but not failures', async () => {
    let fail = true;
    const { ses, requests } = client((req) => {
      if (fail) {
        fail = false;
        return new Response('nope', { status: 500 });
      }
      expect(req.url).toBe('https://sts.eu-central-1.amazonaws.com/');
      return new Response(
        '<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>',
      );
    });
    await expect(ses.accountId()).rejects.toBeInstanceOf(SesError);
    expect(await ses.accountId()).toBe('123456789012');
    expect(await ses.accountId()).toBe('123456789012');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers.get('authorization')).toContain('/eu-central-1/sts/aws4_request');
  });
});
