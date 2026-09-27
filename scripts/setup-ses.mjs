#!/usr/bin/env node
// SES setup for customer-app email (spec 11 design, "Setup"). Idempotent; safe to re-run.
// Usage: node scripts/setup-ses.mjs <dev|prod>
// The AWS account is shared with other projects: this only touches resources it names. Secrets are never printed.
import { appendFileSync, readFileSync } from 'node:fs';
import { AwsClient } from 'aws4fetch';
import { parseJsonc } from '../packages/app-contract/src/jsonc.ts';
import { envFilePath, readEnvFile } from './env-file.mjs';

const env = process.argv[2];
if (env !== 'dev' && env !== 'prod') {
  process.stderr.write('usage: node scripts/setup-ses.mjs <dev|prod>\n');
  process.exit(2);
}
const say = (line) => process.stdout.write(`${line}\n`);
const wranglerVars = (worker) => parseJsonc(readFileSync(`apps/${worker}/wrangler.jsonc`, 'utf8')).env[env].vars;

const secrets = readEnvFile(env);
const { APPS_MAIL_DOMAIN: domain, AWS_REGION: region, SES_CONFIGURATION_SET: configSet } = wranglerVars('email');
const { PLATFORM_API_ORIGIN: apiOrigin } = wranglerVars('api');
for (const key of ['AWS_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY', 'CF_API_TOKEN']) {
  if (!secrets[key]) throw new Error(`${key} is missing from ${envFilePath(env)}`);
}

const aws = new AwsClient({
  accessKeyId: secrets.AWS_ACCESS_KEY,
  secretAccessKey: secrets.AWS_SECRET_ACCESS_KEY,
  region,
});
const SES = `https://email.${region}.amazonaws.com/v2/email`;

async function ses(method, path, body, { allow = [] } = {}) {
  const res = await aws.fetch(`${SES}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (res.ok) return text ? JSON.parse(text) : {};
  const type = (res.headers.get('x-amzn-errortype') ?? '').split(':')[0];
  if (allow.includes(type) || allow.includes(res.status)) return { __error: type || res.status };
  throw new Error(`SES ${method} ${path} → ${res.status} ${type} ${text.slice(0, 300)}`);
}

async function snsCall(params) {
  const res = await aws.fetch(`https://sns.${region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, Version: '2010-03-31' }).toString(),
  });
  return { status: res.status, text: await res.text() };
}

// --- Cloudflare DNS ---------------------------------------------------------------------------------------
const CF = 'https://api.cloudflare.com/client/v4';
async function cf(method, path, body) {
  const res = await fetch(`${CF}${path}`, {
    method,
    headers: { authorization: `Bearer ${secrets.CF_API_TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`Cloudflare ${method} ${path} → ${JSON.stringify(json.errors)}`);
  return json.result;
}

async function zoneFor(name) {
  const labels = name.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    const [zone] = await cf('GET', `/zones?name=${candidate}`);
    if (zone) return zone;
  }
  throw new Error(`no Cloudflare zone contains ${name}`);
}

const unquote = (value) => value.replace(/^"(.*)"$/, '$1');
async function upsertRecord(zoneId, record) {
  const existing = await cf('GET', `/zones/${zoneId}/dns_records?type=${record.type}&name=${record.name}`);
  const wanted = { ...record, ttl: 1, proxied: false };
  const same = existing.find(
    (r) => unquote(r.content) === unquote(record.content) && (r.priority ?? null) === (record.priority ?? null),
  );
  if (same) return say(`  = ${record.type} ${record.name}`);
  // Only records of this exact name and type that we own are replaced (one value per name for these records).
  if (existing[0]) {
    await cf('PATCH', `/zones/${zoneId}/dns_records/${existing[0].id}`, wanted);
    return say(`  ~ ${record.type} ${record.name}`);
  }
  await cf('POST', `/zones/${zoneId}/dns_records`, wanted);
  say(`  + ${record.type} ${record.name}`);
}

// --- Steps ------------------------------------------------------------------------------------------------
say(`SES setup for ${env}: ${domain} in ${region}, configuration set ${configSet}`);

const created = await ses(
  'POST',
  '/configuration-sets',
  {
    ConfigurationSetName: configSet,
    ReputationOptions: { ReputationMetricsEnabled: true },
    SendingOptions: { SendingEnabled: true },
  },
  { allow: ['AlreadyExistsException'] },
);
say(`configuration set: ${created.__error ? 'exists' : 'created'}`);

const identityCreate = await ses(
  'POST',
  '/identities',
  {
    EmailIdentity: domain,
    ConfigurationSetName: configSet,
    DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
  },
  { allow: ['AlreadyExistsException'] },
);
say(`identity: ${identityCreate.__error ? 'exists' : 'created'}`);
await ses('PUT', `/identities/${domain}/mail-from`, {
  MailFromDomain: `bounce.${domain}`,
  BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
});
const identity = await ses('GET', `/identities/${domain}`);
const tokens = identity.DkimAttributes?.Tokens ?? [];
if (tokens.length === 0) throw new Error('SES returned no DKIM tokens');

const zone = await zoneFor(domain);
say(`DNS records in zone ${zone.name}:`);
for (const token of tokens) {
  await upsertRecord(zone.id, {
    type: 'CNAME',
    name: `${token}._domainkey.${domain}`,
    content: `${token}.dkim.amazonses.com`,
  });
}
await upsertRecord(zone.id, {
  type: 'MX',
  name: `bounce.${domain}`,
  content: `feedback-smtp.${region}.amazonses.com`,
  priority: 10,
});
await upsertRecord(zone.id, { type: 'TXT', name: `bounce.${domain}`, content: '"v=spf1 include:amazonses.com ~all"' });
await upsertRecord(zone.id, { type: 'TXT', name: `_dmarc.${domain}`, content: '"v=DMARC1; p=none;"' });

// SNS: bounces and complaints → api webhook (MAIL-4).
const topic = await snsCall({ Action: 'CreateTopic', Name: `ses-events-${env}` });
if (topic.status === 403) {
  say('SNS: skipped — the AWS key lacks sns:CreateTopic/Subscribe/GetTopicAttributes/SetTopicAttributes.');
} else if (topic.status !== 200) {
  throw new Error(`SNS CreateTopic → ${topic.status} ${topic.text.slice(0, 300)}`);
} else {
  const topicArn = /<TopicArn>(.+?)<\/TopicArn>/.exec(topic.text)?.[1];
  const account = topicArn.split(':')[4];
  const attributes = {
    SignatureVersion: '2', // SHA256withRSA — the only version /v1/ses/events accepts
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'ses-publish',
          Effect: 'Allow',
          Principal: { Service: 'ses.amazonaws.com' },
          Action: 'SNS:Publish',
          Resource: topicArn,
          Condition: { StringEquals: { 'AWS:SourceAccount': account } },
        },
      ],
    }),
  };
  for (const [AttributeName, AttributeValue] of Object.entries(attributes)) {
    const set = await snsCall({ Action: 'SetTopicAttributes', TopicArn: topicArn, AttributeName, AttributeValue });
    if (set.status !== 200)
      throw new Error(`SNS SetTopicAttributes ${AttributeName} → ${set.status} ${set.text.slice(0, 300)}`);
  }
  const destination = {
    Enabled: true,
    MatchingEventTypes: ['BOUNCE', 'COMPLAINT'],
    SnsDestination: { TopicArn: topicArn },
  };
  const put = await ses(
    'POST',
    `/configuration-sets/${configSet}/event-destinations`,
    { EventDestinationName: 'bounces-complaints', EventDestination: destination },
    { allow: ['AlreadyExistsException'] },
  );
  if (put.__error) {
    await ses('PUT', `/configuration-sets/${configSet}/event-destinations/bounces-complaints`, {
      EventDestination: destination,
    });
  }
  const sub = await snsCall({
    Action: 'Subscribe',
    TopicArn: topicArn,
    Protocol: 'https',
    Endpoint: `${apiOrigin}/v1/ses/events`,
  });
  if (sub.status !== 200) throw new Error(`SNS Subscribe → ${sub.status} ${sub.text.slice(0, 300)}`);
  say('SNS: topic, event destination and subscription in place (the api confirms the subscription).');
  if (secrets.SES_EVENTS_TOPIC_ARN !== topicArn) {
    appendFileSync(envFilePath(env), `\nSES_EVENTS_TOPIC_ARN=${topicArn}\n`);
    say(`SES_EVENTS_TOPIC_ARN written to .env.${env} — run pnpm secrets:${env}.`);
  }
}

const refreshed = await ses('GET', `/identities/${domain}`);
const account = await ses('GET', '/account');
say(
  `identity verification: ${refreshed.VerificationStatus}, DKIM: ${refreshed.DkimAttributes?.Status}, MAIL FROM: ${refreshed.MailFromAttributes?.MailFromDomainStatus}`,
);
say(
  `account: production access ${account.ProductionAccessEnabled ? 'enabled' : 'NOT enabled (sandbox)'}, sending ${account.SendingEnabled ? 'enabled' : 'disabled'}`,
);
