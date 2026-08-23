import { describe, expect, it } from 'bun:test';
import {
  resolveOwnerTz,
  resolveDayStartHour,
  subjectiveDay,
  DayStartHourConfigError,
  OwnerTzConfigError,
  offsetMinutes,
  localDay,
  localDisplay,
  localToday,
  formatOffset,
  ownerLocalDate,
  ownerLocalInstant,
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

/**
 * Owner-local resolution of the `at` an inventory verb carries
 * (claude-assist#184). Every instant below is seeded explicitly — nothing here
 * reads the wall clock, so none of it decays.
 */
describe('ownerLocalDate — the calendar day an inventory DATE stamps', () => {
  it('an evening instant stamps the LOCAL day, not the UTC day it has crossed into', () => {
    // 21:31 in a −04:00 instance is already 01:31Z the next morning: the shape
    // of the reported defect, where a finish at dinner closed on the 4th.
    const evening = new Date('2026-08-04T01:31:00Z');
    expect(ownerLocalDate(undefined, 'America/New_York', evening).toISOString()).toBe('2026-08-03T00:00:00.000Z');
    // The same instant read as UTC is the day the bug produced.
    expect(ownerLocalDate(undefined, 'UTC', evening).toISOString()).toBe('2026-08-04T00:00:00.000Z');
  });

  it('a supplied full local timestamp stamps the day its wall clock reads', () => {
    expect(ownerLocalDate('2026-08-03T21:31:00-04:00', 'America/New_York').toISOString()).toBe(
      '2026-08-03T00:00:00.000Z'
    );
  });

  it('a bare calendar date is taken VERBATIM — no zone math to get wrong', () => {
    // The day survives an east and a west zone unchanged, which a round-trip
    // through a machine-local instant would not guarantee.
    expect(ownerLocalDate('2026-08-03', 'America/New_York').toISOString()).toBe('2026-08-03T00:00:00.000Z');
    expect(ownerLocalDate('2026-08-03', 'Asia/Kolkata').toISOString()).toBe('2026-08-03T00:00:00.000Z');
    expect(ownerLocalDate('  2026-08-03  ', 'Pacific/Auckland').toISOString()).toBe('2026-08-03T00:00:00.000Z');
  });

  it('an eastern instance sees the mirror case (morning, not evening)', () => {
    // 2026-08-02T20:00Z is 01:30 on the 3rd in Kolkata, still the 2nd in UTC.
    expect(ownerLocalDate(undefined, 'Asia/Kolkata', new Date('2026-08-02T20:00:00Z')).toISOString()).toBe(
      '2026-08-03T00:00:00.000Z'
    );
    expect(ownerLocalDate(undefined, 'UTC', new Date('2026-08-02T20:00:00Z')).toISOString()).toBe(
      '2026-08-02T00:00:00.000Z'
    );
  });

  it('holds across both DST transitions', () => {
    // Spring-forward: 2026-03-08T06:30Z = 01:30 EST (−05:00) → the 8th.
    expect(ownerLocalDate(undefined, 'America/New_York', new Date('2026-03-08T06:30:00Z')).toISOString()).toBe(
      '2026-03-08T00:00:00.000Z'
    );
    // Fall-back: 2026-11-01T05:30Z = 01:30 EDT (−04:00) → the 1st.
    expect(ownerLocalDate(undefined, 'America/New_York', new Date('2026-11-01T05:30:00Z')).toISOString()).toBe(
      '2026-11-01T00:00:00.000Z'
    );
  });

  it('an unparseable value falls back to the local day rather than throwing', () => {
    const evening = new Date('2026-08-04T01:31:00Z');
    expect(ownerLocalDate('not-a-date', 'America/New_York', evening).toISOString()).toBe('2026-08-03T00:00:00.000Z');
  });
});

describe('ownerLocalInstant — the timestamptz an inventory verb writes', () => {
  it('a bare date becomes noon in the OWNER zone, not the sending machine’s', () => {
    expect(ownerLocalInstant('2026-08-03', 'America/New_York').toISOString()).toBe('2026-08-03T16:00:00.000Z');
    // Winter: EST is −05:00, so noon local is 17:00Z — the offset tracks the
    // DATED day, not today.
    expect(ownerLocalInstant('2026-01-15', 'America/New_York').toISOString()).toBe('2026-01-15T17:00:00.000Z');
    expect(ownerLocalInstant('2026-08-03', 'Asia/Kolkata').toISOString()).toBe('2026-08-03T06:30:00.000Z');
    expect(ownerLocalInstant('2026-08-03', 'UTC').toISOString()).toBe('2026-08-03T12:00:00.000Z');
  });

  it('noon local always falls on the day it names', () => {
    for (const zone of ['America/New_York', 'Asia/Kolkata', 'Pacific/Auckland', 'Pacific/Honolulu', 'UTC']) {
      expect(localDay(ownerLocalInstant('2026-08-03', zone), zone)).toBe('2026-08-03');
    }
  });

  it('a full timestamp passes through as the instant it names', () => {
    expect(ownerLocalInstant('2026-08-03T21:31:00-04:00', 'America/New_York').toISOString()).toBe(
      '2026-08-04T01:31:00.000Z'
    );
  });

  it('absent ⇒ the seeded now', () => {
    const now = new Date('2026-08-04T01:31:00Z');
    expect(ownerLocalInstant(undefined, 'America/New_York', now).toISOString()).toBe('2026-08-04T01:31:00.000Z');
  });
});

/**
 * Configurable consumption-day boundary (§ Timezone & local-day bucketing).
 *
 * `localDay` answers "what calendar date was it?" and governs facts about FOOD
 * — an eat-by, a purchase date. `subjectiveDay` answers "which day did the
 * eater mean?", which is what a journal rollup is asking. A meal at 00:30
 * belongs to the evening it was part of, not to the date the clock had just
 * turned over to.
 */
describe('consumption day boundary (KITCHEN_DAY_START_HOUR)', () => {
  const NY = 'America/New_York';

  describe('resolveDayStartHour', () => {
    it('absent/blank ⇒ 0, preserving the historical midnight boundary exactly', () => {
      for (const empty of [undefined, null, '', '   ']) {
        expect(resolveDayStartHour(empty as string | undefined)).toBe(0);
      }
    });

    it('accepts an integer hour, as a string or a number', () => {
      expect(resolveDayStartHour('4')).toBe(4);
      expect(resolveDayStartHour(4)).toBe(4);
      expect(resolveDayStartHour('0')).toBe(0);
      expect(resolveDayStartHour('23')).toBe(23);
    });

    it('fails LOUDLY on a non-integer or out-of-range hour (never a silent default)', () => {
      for (const bad of ['4.5', 'four', '-1', '24', '99']) {
        expect(() => resolveDayStartHour(bad)).toThrow(DayStartHourConfigError);
      }
    });

    it('rides on the owner-tz resolver so both are settled once at boot', () => {
      expect(resolveOwnerTz(NY, '4').dayStartHour).toBe(4);
      expect(resolveOwnerTz(NY).dayStartHour).toBe(0);
      // The UTC-fallback branch carries it too — a fallback zone is still a
      // configured boundary.
      expect(resolveOwnerTz('', '4').dayStartHour).toBe(4);
    });
  });

  describe('subjectiveDay', () => {
    it('is IDENTICAL to localDay at the default boundary — nothing moves unless configured', () => {
      const instants = [
        new Date('2026-08-21T03:39:00Z'), // 23:39 EDT
        new Date('2026-08-21T04:30:00Z'), // 00:30 EDT, just past midnight
        new Date('2026-08-21T16:00:00Z'), // midday
      ];
      for (const at of instants) {
        expect(subjectiveDay(at, { zone: NY, dayStartHour: 0 })).toBe(localDay(at, NY));
      }
    });

    it('rolls a post-midnight entry back to the previous day', () => {
      // 2026-08-21T04:30Z == 00:30 EDT on the 21st.
      const lateSnack = new Date('2026-08-21T04:30:00Z');
      expect(localDay(lateSnack, NY)).toBe('2026-08-21');
      expect(subjectiveDay(lateSnack, { zone: NY, dayStartHour: 4 })).toBe('2026-08-20');
    });

    it('leaves an entry just BEFORE midnight on its own day', () => {
      // 23:39 EDT on the 20th — already correct, must not shift.
      const beforeMidnight = new Date('2026-08-21T03:39:00Z');
      expect(subjectiveDay(beforeMidnight, { zone: NY, dayStartHour: 4 })).toBe('2026-08-20');
    });

    it('treats the boundary hour itself as the NEW day (inclusive lower bound)', () => {
      // 04:00 EDT exactly == 08:00Z.
      const atBoundary = new Date('2026-08-21T08:00:00Z');
      expect(subjectiveDay(atBoundary, { zone: NY, dayStartHour: 4 })).toBe('2026-08-21');
      // One minute earlier still belongs to the previous day.
      const justBefore = new Date('2026-08-21T07:59:00Z');
      expect(subjectiveDay(justBefore, { zone: NY, dayStartHour: 4 })).toBe('2026-08-20');
    });

    it('composes with DST rather than fighting it', () => {
      // US DST ends 2026-11-01. 01:30 local on the 1st is ambiguous by wall
      // clock; the zone offset for the instant settles it, and the roll-back
      // still lands on Oct 31 either way.
      const duringFallBack = new Date('2026-11-01T05:30:00Z');
      expect(subjectiveDay(duringFallBack, { zone: NY, dayStartHour: 4 })).toBe('2026-10-31');
    });

    it('works in a zone east of UTC', () => {
      const tokyo = 'Asia/Tokyo'; // UTC+9, no DST
      // 2026-08-20T18:30Z == 03:30 on the 21st in Tokyo.
      const at = new Date('2026-08-20T18:30:00Z');
      expect(localDay(at, tokyo)).toBe('2026-08-21');
      expect(subjectiveDay(at, { zone: tokyo, dayStartHour: 4 })).toBe('2026-08-20');
    });
  });
});
