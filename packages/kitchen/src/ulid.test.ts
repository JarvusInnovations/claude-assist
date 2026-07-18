import { describe, expect, it } from 'bun:test';
import { generateUlid, isValidUlid, ulidFromSeed, ULID_PATTERN } from './ulid.js';

describe('generateUlid', () => {
  it('produces valid 26-char ULIDs', () => {
    for (let i = 0; i < 100; i++) {
      const ulid = generateUlid();
      expect(ulid).toHaveLength(26);
      expect(isValidUlid(ulid)).toBe(true);
    }
  });

  it('encodes the timestamp so ULIDs sort chronologically', () => {
    const earlier = generateUlid(1_000_000_000_000);
    const later = generateUlid(2_000_000_000_000);
    expect(earlier < later).toBe(true);
  });
});

describe('ulidFromSeed', () => {
  it('is deterministic for the same time + seed', () => {
    const a = ulidFromSeed(1720000000123, 'mealbank:Oatmeal');
    const b = ulidFromSeed(1720000000123, 'mealbank:Oatmeal');
    expect(a).toBe(b);
    expect(isValidUlid(a)).toBe(true);
  });

  it('differs when the seed differs', () => {
    const a = ulidFromSeed(1720000000123, 'mealbank:Oatmeal');
    const b = ulidFromSeed(1720000000123, 'mealbank:Chili');
    expect(a).not.toBe(b);
  });
});

describe('isValidUlid', () => {
  it('rejects malformed values', () => {
    expect(isValidUlid('')).toBe(false);
    expect(isValidUlid('not-a-ulid')).toBe(false);
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false); // 25 chars
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAVX')).toBe(false); // 27 chars
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false); // I not in alphabet
    expect(isValidUlid('81ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false); // first char > 7
    expect(isValidUlid('01arz3ndektsv4rrffq69g5fav')).toBe(false); // lowercase
  });

  it('accepts canonical ULIDs', () => {
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    expect(ULID_PATTERN.test(generateUlid())).toBe(true);
  });
});
