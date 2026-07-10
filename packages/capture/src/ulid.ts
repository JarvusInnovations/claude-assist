/**
 * ULID helpers (no dependency — 26-char Crockford base32, 48-bit time +
 * 80-bit randomness).
 *
 * Clients generate the ULID; it is the idempotency key for offline-queue
 * replays. `ulidFromSeed` derives a *deterministic* ULID from a stable
 * external identity (e.g. a Slack channel+ts), so at-least-once event
 * delivery collapses to exactly-one capture row.
 */

import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** First char is constrained to 0-7 (48-bit ms timestamps) */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isValidUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

function encodeTime(timeMs: number): string {
  if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > 2 ** 48 - 1) {
    throw new Error(`ULID timestamp out of range: ${timeMs}`);
  }
  let ms = Math.floor(timeMs);
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

/** Encode 10 bytes (80 bits) as 16 base32 chars */
function encodeBytes(bytes: Uint8Array): string {
  if (bytes.length < 10) throw new Error('Need at least 10 bytes of entropy');
  let bits = 0;
  let acc = 0;
  let out = '';
  for (let i = 0; i < 10; i++) {
    acc = (acc << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // 80 bits / 5 = exactly 16 chars, no remainder
  return out;
}

/** Generate a fresh random ULID */
export function generateUlid(timeMs = Date.now()): string {
  return encodeTime(timeMs) + encodeBytes(randomBytes(10));
}

/**
 * Derive a deterministic ULID from a timestamp + stable seed string.
 * Same (timeMs, seed) always yields the same ULID.
 */
export function ulidFromSeed(timeMs: number, seed: string): string {
  const digest = createHash('sha256').update(seed).digest();
  return encodeTime(timeMs) + encodeBytes(digest.subarray(0, 10));
}
