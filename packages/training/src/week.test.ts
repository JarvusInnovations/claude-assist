import { describe, expect, it } from 'bun:test';
import {
  addDays,
  daysBetween,
  isoWeekday,
  nextWeekStart,
  todayIsoInTz,
  tzOffsetMinutes,
  weekDates,
  weekEndOf,
  weekStartOf,
  weekWindowIso,
  weekdayName,
} from './week.js';

describe('week arithmetic', () => {
  it('treats Monday as the start of the week', () => {
    // 2026-08-08 is a Saturday.
    expect(isoWeekday('2026-08-08')).toBe(6);
    expect(weekStartOf('2026-08-08')).toBe('2026-08-03');
    expect(weekStartOf('2026-08-03')).toBe('2026-08-03');
    // Sunday belongs to the week that started six days earlier, not the next one.
    expect(weekStartOf('2026-08-09')).toBe('2026-08-03');
  });

  it('advances to the following Monday', () => {
    expect(nextWeekStart('2026-08-08')).toBe('2026-08-10');
    expect(nextWeekStart('2026-08-09')).toBe('2026-08-10');
    expect(nextWeekStart('2026-08-10')).toBe('2026-08-17');
  });

  it('enumerates seven dates Monday through Sunday', () => {
    const dates = weekDates('2026-08-10');
    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe('2026-08-10');
    expect(dates[6]).toBe('2026-08-16');
    expect(weekEndOf('2026-08-10')).toBe('2026-08-16');
    expect(weekdayName('2026-08-10')).toBe('Mon');
    expect(weekdayName('2026-08-16')).toBe('Sun');
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(daysBetween('2026-12-28', '2027-01-04')).toBe(7);
  });

  it('is unaffected by DST, because the arithmetic is on date strings', () => {
    // US DST ends 2026-11-01; a naive local-Date + 24h lands on the same day.
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(weekStartOf('2026-11-01')).toBe('2026-10-26');
  });
});

describe('zone handling', () => {
  it('measures a zone offset behind UTC as negative', () => {
    // 2026-08-10 is inside US daylight time: New York is UTC-4.
    expect(tzOffsetMinutes(new Date('2026-08-10T12:00:00Z'), 'America/New_York')).toBe(-240);
    expect(tzOffsetMinutes(new Date('2026-01-10T12:00:00Z'), 'America/New_York')).toBe(-300);
    expect(tzOffsetMinutes(new Date('2026-08-10T12:00:00Z'), 'UTC')).toBe(0);
  });

  it('bounds the plan week at local midnight, not UTC midnight', () => {
    const { fromIso, toIso } = weekWindowIso('2026-08-10', 'America/New_York');
    expect(fromIso).toBe('2026-08-10T04:00:00.000Z');
    expect(toIso).toBe('2026-08-17T04:00:00.000Z');
  });

  it('resolves today in a zone that has already rolled over', () => {
    // 23:30 in New York on the 9th is already the 10th in UTC.
    const at = new Date('2026-08-10T03:30:00Z');
    expect(todayIsoInTz('America/New_York', at)).toBe('2026-08-09');
    expect(todayIsoInTz('UTC', at)).toBe('2026-08-10');
  });

  it('falls back rather than throwing on an unknown zone', () => {
    const at = new Date('2026-08-10T12:00:00Z');
    expect(todayIsoInTz('Not/AZone', at)).toBe('2026-08-10');
    expect(tzOffsetMinutes(at, 'Not/AZone')).toBe(0);
  });
});
