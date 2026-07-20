import { randomBytes } from 'node:crypto';

/**
 * Minimal ULID generator for spawn ids. A spawn id is an opaque correlation
 * handle (logs ↔ request); it needs to be unique and sortable-ish, not
 * cryptographically strict, so a timestamp prefix + random suffix in Crockford
 * base32 is plenty. Kept dependency-free (no cross-package import).
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

function encodeTime(now: number, len: number): string {
  let out = '';
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % 32;
    out = ENCODING[mod] + out;
    now = (now - mod) / 32;
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ENCODING[bytes[i]! % 32];
  }
  return out;
}

/** A 26-char Crockford-base32 ULID (10 time chars + 16 random chars). */
export function generateSpawnId(): string {
  return encodeTime(Date.now(), 10) + encodeRandom(16);
}
