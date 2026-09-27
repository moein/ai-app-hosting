import { type SnsEnvelope, stringToSign } from '../../src/mail/sns';

// Minimal DER encoder, enough to wrap a public key in an X.509-shaped certificate (the verifier only reads the SPKI).
const len = (n: number) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
const tlv = (tag: number, content: Uint8Array) => new Uint8Array([tag, ...len(content.length), ...content]);
const cat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((p) => [...p]));
const seq = (...parts: Uint8Array[]) => tlv(0x30, cat(...parts));
const OID_SHA256_RSA = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

export type TestSigner = { certPem: string; sign(message: Omit<SnsEnvelope, 'Signature'>): Promise<SnsEnvelope> };

export async function testSigner(): Promise<TestSigner> {
  const keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const spki = new Uint8Array((await crypto.subtle.exportKey('spki', keys.publicKey)) as ArrayBuffer);
  const name = seq(); // empty issuer/subject are fine for the verifier
  const tbs = seq(
    tlv(0xa0, tlv(0x02, new Uint8Array([2]))), // [0] version v3
    tlv(0x02, new Uint8Array([1])), // serial
    seq(OID_SHA256_RSA),
    name,
    seq(tlv(0x17, new TextEncoder().encode('260101000000Z')), tlv(0x17, new TextEncoder().encode('360101000000Z'))),
    name,
    spki,
  );
  const cert = seq(tbs, seq(OID_SHA256_RSA), tlv(0x03, new Uint8Array([0, 1, 2, 3])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64(cert).replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
  return {
    certPem,
    async sign(message) {
      const unsigned = { ...message, Signature: '' } as SnsEnvelope;
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        keys.privateKey,
        new TextEncoder().encode(stringToSign(unsigned)),
      );
      return { ...unsigned, Signature: b64(new Uint8Array(signature)) };
    },
  };
}
