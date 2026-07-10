import { describe, expect, it } from 'bun:test';
import { todayIsoInTz, zonedDayStartMs, zonedDayWindow } from './time.js';

describe('todayIsoInTz', () => {
  it('rolls the date back for a late-UTC instant that is still "yesterday" in ET', () => {
    // 2026-07-11T02:00:00Z == 2026-07-10 22:00 EDT
    const now = new Date('2026-07-11T02:00:00Z');
    expect(todayIsoInTz('America/New_York', now)).toBe('2026-07-10');
    expect(todayIsoInTz('UTC', now)).toBe('2026-07-11');
  });
});

describe('zonedDayWindow (America/New_York)', () => {
  it('spans a full local day as UTC-Z instants', () => {
    // EDT (UTC-4): 2026-07-10 00:00 ET == 2026-07-10T04:00:00Z
    const { fromIso, toIso } = zonedDayWindow('2026-07-10', 'America/New_York');
    expect(fromIso).toBe('2026-07-10T04:00:00.000Z');
    expect(toIso).toBe('2026-07-11T04:00:00.000Z');
  });

  it('start ms matches the ET midnight instant', () => {
    expect(zonedDayStartMs('2026-07-10', 'America/New_York')).toBe(Date.parse('2026-07-10T04:00:00Z'));
  });

  it('handles a standard-time (EST, UTC-5) date', () => {
    const { fromIso } = zonedDayWindow('2026-01-15', 'America/New_York');
    expect(fromIso).toBe('2026-01-15T05:00:00.000Z');
  });
});
