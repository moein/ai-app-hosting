import { z } from 'zod';

export const SnsEnvelopeSchema = z.object({
  Type: z.enum(['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation']),
  MessageId: z.string(),
  TopicArn: z.string(),
  Message: z.string(),
  Timestamp: z.string(),
  SignatureVersion: z.string(),
  Signature: z.string(),
  SigningCertURL: z.string(),
  Subject: z.string().optional(),
  SubscribeURL: z.string().optional(),
  Token: z.string().optional(),
});
export type SnsEnvelope = z.infer<typeof SnsEnvelopeSchema>;

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

/** True for https URLs on an SNS regional host (certificate and SubscribeURL, MAIL-4.1/4.2). */
export function isSnsUrl(value: string | undefined, options: { pem?: boolean } = {}): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && SNS_HOST.test(url.hostname) && (!options.pem || url.pathname.endsWith('.pem'));
  } catch {
    return false;
  }
}

/** The canonical string SNS signs, per message type. */
export function stringToSign(message: SnsEnvelope): string {
  const keys: (keyof SnsEnvelope)[] =
    message.Type === 'Notification'
      ? [
          'Message',
          'MessageId',
          ...(message.Subject === undefined ? [] : (['Subject'] as const)),
          'Timestamp',
          'TopicArn',
          'Type',
        ]
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.map((key) => `${key}\n${message[key] ?? ''}\n`).join('');
}

type Tlv = { tag: number; start: number; contentStart: number; end: number };

function readTlv(der: Uint8Array, offset: number): Tlv {
  const tag = der[offset] as number;
  let length = der[offset + 1] as number;
  let p = offset + 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    length = 0;
    for (let i = 0; i < bytes; i++) length = length * 256 + (der[p++] as number);
  }
  if (p + length > der.length) throw new Error('truncated DER');
  return { tag, start: offset, contentStart: p, end: p + length };
}

function childrenOf(der: Uint8Array, parent: Tlv): Tlv[] {
  const children: Tlv[] = [];
  for (let p = parent.contentStart; p < parent.end; ) {
    const child = readTlv(der, p);
    children.push(child);
    p = child.end;
  }
  return children;
}

/** SubjectPublicKeyInfo of an X.509 certificate (DER): tbsCertificate's 7th field (6th without [0] version). */
export function spkiFromCertificate(der: Uint8Array): Uint8Array {
  const certificate = readTlv(der, 0);
  const [tbs] = childrenOf(der, certificate);
  if (!tbs) throw new Error('certificate has no tbsCertificate');
  const fields = childrenOf(der, tbs);
  const spki = fields[(fields[0]?.tag === 0xa0 ? 1 : 0) + 5];
  if (spki?.tag !== 0x30) throw new Error('certificate has no subjectPublicKeyInfo');
  return der.slice(spki.start, spki.end);
}

export const pemToDer = (pem: string) =>
  Uint8Array.from(atob(pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '')), (c) =>
    c.charCodeAt(0),
  );

const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * MAIL-4.1: SignatureVersion 2 (SHA256withRSA) with the certificate from an SNS host. The TopicArn check
 * is the caller's. Certificates are cached per isolate by URL.
 */
export async function verifySnsSignature(message: SnsEnvelope, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (message.SignatureVersion !== '2' || !isSnsUrl(message.SigningCertURL, { pem: true })) return false;
  let key = keyCache.get(message.SigningCertURL);
  if (!key) {
    key = (async () => {
      const response = await fetchImpl(message.SigningCertURL);
      if (!response.ok) throw new Error(`certificate fetch failed: ${response.status}`);
      const spki = spkiFromCertificate(pemToDer(await response.text()));
      return crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    })();
    keyCache.set(message.SigningCertURL, key);
    key.catch(() => keyCache.delete(message.SigningCertURL));
  }
  try {
    const signature = Uint8Array.from(atob(message.Signature), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      await key,
      signature,
      new TextEncoder().encode(stringToSign(message)),
    );
  } catch {
    return false;
  }
}
