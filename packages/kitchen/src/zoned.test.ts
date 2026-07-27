import { describe, expect, it } from 'bun:test';
import {
  resolveOwnerTz,
  OwnerTzConfigError,
  offsetMinutes,
  localDay,
  localDisplay,
  localToday,
  formatOffset,
} from './zoned.js';

/**
 * Owner-timezone resolver + local-day helpers (specs/modules/kitchen.md
 * § Timezone & local-day bucketing). All assertions are TZ-pinned to explicit
 * IANA zones, never the host clock — deterministic anywhere.
 */
describe('owner timezone resolver (§ Timezone & local-day bucketing)', () => {
  it('resolves a configured IANA zone with no fallback', () => {
    const tz = resolveOwnerTz('America/New_York');
    expect(tz.zone).toBe('America/New_York');
    expect(tz.fallback).toBe(false);
    expect(tz.note).toBe('America/New_York');
  });

  it('unset ⇒ UTC fallback that STATES itself (never a silent guess)', () => {
    for (const empty of [undefined, '', '   ', null]) {
      const tz = resolveOwnerTz(empty as string | undefined);
      expect(tz.zone).toBe('UTC');
      expect(tz.fallback).toBe(true);
      expect(tz.note).toBe('UTC (KITCHEN_OWNER_TZ unset)');
    }
  });

  it('a present-but-invalid zone fails loudly (fail-loud config, never a UTC guess)', () => {
    expect(() => resolveOwnerTz('Not/AZone')).toThrow(OwnerTzConfigError);
    expect(() => resolveOwnerTz('Europe/Nowhere')).toThrow(/not a valid IANA timezone/);
  });
});

describe('localDay — owner-local calendar date of a UTC instant', () => {
  it('an instant just after UTC midnight reports the PREVIOUS local day in a US zone', () => {
    // 2026-07-26T00:47Z is 2026-07-25 20:47 in America/New_York (EDT, −04:00).
    const inst = new Date('2026-07-26T00:47:00Z');
    expect(localDay(inst, 'America/New_York')).toBe('2026-07-25');
    // Under UTC the same instant is the 26th — the exact mis-bucket this retires.
    expect(localDay(inst, 'UTC')).toBe('2026-07-26');
  });

  it('DST spring-forward (EST→EDT) buckets correctly', () => {
    // 2026-03-08 02:00 local springs to 03:00. 06:30Z = 01:30 EST (−05:00) → the 8th.
    expect(localDay(new Date('2026-03-08T06:30:00Z'), 'America/New_York')).toBe('2026-03-08');
    // 07:30Z = 03:30 EDT (−04:00) → still the 8th.
    expect(localDay(new Date('2026-03-08T07:30:00Z'), 'America/New_York')).toBe('2026-03-08');
    expect(offsetMinutes(new Date('2026-03-08T06:30:00Z'), 'America/New_York')).toBe(-300);
    expect(offsetMinutes(new Date('2026-03-08T07:30:00Z'), 'America/New_York')).toBe(-240);
  });

  it('DST fall-back (EDT→EST) buckets correctly around the ambiguous hour', () => {
    // 2026-11-01 02:00 EDT falls back to 01:00 EST. 05:30Z = 01:30 EDT (−04:00) → the 1st.
    expect(localDay(new Date('2026-11-01T05:30:00Z'), 'America/New_York')).toBe('2026-11-01');
    // 06:30Z = 01:30 EST (−05:00) → still the 1st.
    expect(localDay(new Date('2026-11-01T06:30:00Z'), 'America/New_York')).toBe('2026-11-01');
    expect(offsetMinutes(new Date('2026-11-01T05:30:00Z'), 'America/New_York')).toBe(-240);
    expect(offsetMinutes(new Date('2026-11-01T06:30:00Z'), 'America/New_York')).toBe(-300);
  });

  it('handles a half-hour zone east of UTC', () => {
    const inst = new Date('2026-07-26T00:47:00Z');
    // +05:30 → 06:17 the same day.
    expect(localDay(inst, 'Asia/Kolkata')).toBe('2026-07-26');
    expect(offsetMinutes(inst, 'Asia/Kolkata')).toBe(330);
  });
});

describe('localDisplay — instant rendered in the owner zone (never a bare Z)', () => {
  it('carries the explicit local offset, DST-correct', () => {
    expect(localDisplay(new Date('2026-07-26T00:47:00Z'), 'America/New_York')).toBe('2026-07-25T20:47:00-04:00');
    expect(localDisplay(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe('2026-01-15T07:00:00-05:00');
    expect(localDisplay(new Date('2026-07-26T00:47:00Z'), 'Asia/Kolkata')).toBe('2026-07-26T06:17:00+05:30');
  });

  it('UTC renders a Z designator', () => {
    expect(localDisplay(new Date('2026-07-26T00:47:00Z'), 'UTC')).toBe('2026-07-26T00:47:00Z');
  });
});

describe('formatOffset + localToday', () => {
  it('formats offsets as Z / ±HH:MM', () => {
    expect(formatOffset(0)).toBe('Z');
    expect(formatOffset(-240)).toBe('-04:00');
    expect(formatOffset(330)).toBe('+05:30');
  });

  it('localToday returns the owner-local date at a pinned instant', () => {
    // At 2026-07-26T00:47Z, "today" in New York is still the 25th.
    expect(localToday('America/New_York', new Date('2026-07-26T00:47:00Z'))).toBe('2026-07-25');
    expect(localToday('UTC', new Date('2026-07-26T00:47:00Z'))).toBe('2026-07-26');
  });
});
