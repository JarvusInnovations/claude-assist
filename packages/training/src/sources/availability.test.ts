import { describe, expect, it } from 'bun:test';
import type { CalendarEvent } from '@jarvus/claude-assist-briefing';
import { fetchAvailability, summarizeAvailability } from './availability.js';

const WEEK_START = '2026-08-10';
const TZ = 'America/New_York';

function event(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'e1',
    seriesId: 'e1',
    summary: 'Standup',
    start: '2026-08-10T13:00:00Z', // 09:00 ET
    end: '2026-08-10T13:30:00Z',
    allDay: false,
    startMs: Date.parse('2026-08-10T13:00:00Z'),
    myResponse: 'accepted',
    attendeeCount: 3,
    location: '',
    joinUrl: '',
    hangoutLink: '',
    description: '',
    status: 'confirmed',
    ...overrides,
  };
}

describe('summarizeAvailability', () => {
  it('produces one entry per day of the week, even when nothing is scheduled', () => {
    const days = summarizeAvailability([], WEEK_START, TZ);
    expect(days).toHaveLength(7);
    expect(days[0]!.date).toBe('2026-08-10');
    expect(days[6]!.date).toBe('2026-08-16');
    expect(days.every((d) => d.meetingCount === 0 && d.busyMinutes === 0)).toBe(true);
  });

  it('buckets a timed event into its LOCAL day and hour', () => {
    // 00:30 UTC on the 11th is 20:30 ET on the 10th — bucketing by the UTC day
    // would put an evening meeting on the wrong day and hide the real evening.
    const days = summarizeAvailability(
      [event({ start: '2026-08-11T00:30:00Z', end: '2026-08-11T01:30:00Z' })],
      WEEK_START,
      TZ
    );
    const monday = days.find((d) => d.date === '2026-08-10')!;
    expect(monday.meetingCount).toBe(1);
    expect(monday.firstMeetingHour).toBe(20);
    expect(monday.busyMinutes).toBe(60);
  });

  it('accumulates busy minutes and tracks the first and last meeting hours', () => {
    const days = summarizeAvailability(
      [
        event({ id: 'a', start: '2026-08-10T13:00:00Z', end: '2026-08-10T13:30:00Z' }),
        event({ id: 'b', start: '2026-08-10T18:00:00Z', end: '2026-08-10T19:15:00Z' }),
      ],
      WEEK_START,
      TZ
    );
    const monday = days.find((d) => d.date === '2026-08-10')!;
    expect(monday.meetingCount).toBe(2);
    expect(monday.busyMinutes).toBe(105);
    expect(monday.firstMeetingHour).toBe(9);
    expect(monday.lastMeetingEndHour).toBe(16); // 15:15 ET rounds up to 16:00
  });

  it('attaches all-day markers to every day they span, exclusive end included', () => {
    const days = summarizeAvailability(
      [event({ allDay: true, summary: 'PTO', start: '2026-08-12', end: '2026-08-14' })],
      WEEK_START,
      TZ
    );
    expect(days.find((d) => d.date === '2026-08-12')!.allDayNotes).toEqual(['PTO']);
    expect(days.find((d) => d.date === '2026-08-13')!.allDayNotes).toEqual(['PTO']);
    expect(days.find((d) => d.date === '2026-08-14')!.allDayNotes).toEqual([]);
  });

  it('ignores cancelled events — they occupy nothing', () => {
    const days = summarizeAvailability([event({ status: 'cancelled' })], WEEK_START, TZ);
    expect(days.find((d) => d.date === '2026-08-10')!.meetingCount).toBe(0);
  });

  it('ignores events outside the plan week', () => {
    const days = summarizeAvailability(
      [event({ start: '2026-09-01T13:00:00Z', end: '2026-09-01T14:00:00Z' })],
      WEEK_START,
      TZ
    );
    expect(days.every((d) => d.meetingCount === 0)).toBe(true);
  });

  it('caps one absurdly long timed block at a day', () => {
    // Some calendars emit multi-day timed blocks; uncapped, one would swamp the
    // rollup and make every other signal for that day unreadable.
    const days = summarizeAvailability(
      [event({ start: '2026-08-10T13:00:00Z', end: '2026-08-14T13:00:00Z' })],
      WEEK_START,
      TZ
    );
    expect(days.find((d) => d.date === '2026-08-10')!.busyMinutes).toBe(1440);
  });
});

describe('fetchAvailability', () => {
  it('asks the calendar for the local week window', async () => {
    let asked: { fromIso: string; toIso: string } | null = null;
    const result = await fetchAvailability({ weekStart: WEEK_START, timeZone: TZ }, async (opts) => {
      asked = { fromIso: opts.fromIso, toIso: opts.toIso };
      return { events: [event({})], error: null };
    });
    expect(asked!.fromIso).toBe('2026-08-10T04:00:00.000Z');
    expect(asked!.toIso).toBe('2026-08-17T04:00:00.000Z');
    expect(result.error).toBeNull();
    expect(result.days).toHaveLength(7);
  });

  it('carries the reader\'s error through instead of throwing', async () => {
    const result = await fetchAvailability({ weekStart: WEEK_START, timeZone: TZ }, async () => ({
      events: [],
      error: 'gws-axi calendar read failed: ENOENT',
    }));
    expect(result.error).toContain('ENOENT');
    // Still seven empty days: the synthesis is told the calendar is unavailable,
    // not handed a shorter week.
    expect(result.days).toHaveLength(7);
  });
});
