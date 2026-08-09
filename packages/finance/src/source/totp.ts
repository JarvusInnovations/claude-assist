/**
 * RFC 6238 TOTP, so an MFA-protected provider login can run unattended.
 *
 * Written out rather than pulled in: it is thirty lines of well-specified
 * arithmetic, and a dependency that computes one-time codes from a stored
 * secret is a dependency worth not having.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decode a base32 secret (RFC 4648, padding and spacing tolerated). */
export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export interface TotpOptions {
  /** Step length in seconds (default 30). */
  periodSeconds?: number;
  /** Code length (default 6). */
  digits?: number;
  /** Unix seconds; defaults to now. Injected by tests. */
  atSeconds?: number;
}

/** Generate the current TOTP code for a base32 secret. */
export async function totpCode(secret: string, options: TotpOptions = {}): Promise<string> {
  const period = options.periodSeconds ?? 30;
  const digits = options.digits ?? 6;
  const now = options.atSeconds ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(now / period);

  const message = new Uint8Array(8);
  // Counter is well under 2^53, so the split into two 32-bit halves is exact.
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  new DataView(message.buffer).setUint32(0, high);
  new DataView(message.buffer).setUint32(4, low);

  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(secret) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, message as unknown as ArrayBuffer),
  );

  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}
