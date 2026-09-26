/** Source of randomness, injectable so slug/code generation is testable. */
export interface Random {
  bytes(length: number): Uint8Array;
}

export const cryptoRandom: Random = {
  bytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
};

/** Uniformly picks `length` characters from `alphabet` using rejection sampling (no modulo bias). */
export function randomString(random: Random, alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of random.bytes(length * 2)) {
      if (byte < limit) out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}
