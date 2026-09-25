import { describe, expect, it } from 'bun:test';
import { computeReadWindow } from './chunk-backfill.js';

describe('computeReadWindow', () => {
  it('caps at the session budget when plenty remains', () => {
    expect(computeReadWindow(0, 10_000, 1_000)).toBe(1_000);
  });

  it('returns exactly what remains when less than the budget is left', () => {
    expect(computeReadWindow(9_500, 10_000, 1_000)).toBe(500);
  });

  it('returns 0 once fromByte reaches the total (fully covered)', () => {
    expect(computeReadWindow(10_000, 10_000, 1_000)).toBe(0);
  });

  it('never goes negative if fromByte somehow overshoots the total', () => {
    expect(computeReadWindow(10_500, 10_000, 1_000)).toBe(0);
  });

  it('handles a zero-length transcript', () => {
    expect(computeReadWindow(0, 0, 1_000)).toBe(0);
  });

  it('handles a budget of exactly the remaining size', () => {
    expect(computeReadWindow(0, 1_000, 1_000)).toBe(1_000);
  });
});
