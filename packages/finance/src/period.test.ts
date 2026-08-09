import { describe, expect, test } from 'bun:test';
import { daysInMonth, periodFromKey, periodToReview, priorPeriodKey } from './period.js';

describe('period', () => {
  test('builds inclusive month bounds', () => {
    expect(periodFromKey('2026-02')).toMatchObject({
      key: '2026-02',
      startDate: '2026-02-01',
      endDate: '2026-02-28',
      label: 'February 2026',
    });
  });

  test('handles a leap February', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(periodFromKey('2024-02').endDate).toBe('2024-02-29');
  });

  test('rejects a malformed key', () => {
    expect(() => periodFromKey('2026-13')).toThrow(/month out of range/);
    expect(() => periodFromKey('202606')).toThrow(/Invalid period key/);
  });

  test('walks back across a year boundary', () => {
    expect(priorPeriodKey('2026-01')).toBe('2025-12');
    expect(priorPeriodKey('2026-11')).toBe('2026-10');
  });

  test('reviews the most recently closed month', () => {
    const now = new Date('2026-04-03T13:00:00Z');
    expect(periodToReview('America/New_York', now).key).toBe('2026-03');
  });

  /**
   * The whole reason the boundary is computed in the owner's zone: at 01:00 UTC
   * on the 1st it is still the previous month in New York, so the period to
   * review is the month before the one a UTC read would pick.
   */
  test('resolves the period in the owner zone, not UTC', () => {
    const justAfterUtcMonthStart = new Date('2026-04-01T01:00:00Z');
    expect(periodToReview('UTC', justAfterUtcMonthStart).key).toBe('2026-03');
    expect(periodToReview('America/New_York', justAfterUtcMonthStart).key).toBe('2026-02');
  });
});
