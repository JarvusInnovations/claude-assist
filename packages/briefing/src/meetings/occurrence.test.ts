import { describe, expect, it } from 'bun:test';
import type { CalendarEvent } from '../types.js';
import {
  decodeOriginalStart,
  occurrenceIdentity,
  occurrenceEndMs,
  nextOccurrence,
} from './occurrence.js';

function ev(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'abc_20260710T190000Z',
    seriesId: 'abc',
    summary: 'Weekly sync',
    start: '2026-07-10T15:00:00-04:00',
    end: '2026-07-10T15:30:00-04:00',
    allDay: false,
    startMs: Date.parse('2026-07-10T15:00:00-04:00'),
    myResponse: 'accepted',
    attendeeCount: 3,
    location: '',
    hangoutLink: 'https://meet.google.com/x',
    description: '',
    status: 'confirmed',
    ...over,
  };
}

describe('decodeOriginalStart', () => {
  it('decodes a datetime suffix', () => {
    expect(decodeOriginalStart('abc_20260710T190000Z')).toBe('2026-07-10T19:00:00Z');
  });
  it('decodes a date-only suffix', () => {
    expect(decodeOriginalStart('abc_20260710')).toBe('2026-07-10');
  });
  it('returns null for a one-off id with no suffix', () => {
    expect(decodeOriginalStart('oneoff123')).toBeNull();
  });
});

describe('occurrenceIdentity', () => {
  it('keys on the instance id and carries the actual start', () => {
    const id = occurrenceIdentity(ev());
    expect(id.seriesKey).toBe('abc');
    expect(id.occurrenceKey).toBe('abc_20260710T190000Z');
    expect(id.occurrenceStart).toBe('2026-07-10T15:00:00-04:00');
    expect(id.originalStart).toBe('2026-07-10T19:00:00Z');
  });

  it('is reschedule-stable: a moved occurrence keeps its occurrenceKey while the start changes', () => {
    // Same recurrence-id suffix (original start), but the meeting was moved 2h later.
    const original = occurrenceIdentity(ev());
    const rescheduled = occurrenceIdentity(
      ev({ start: '2026-07-10T17:00:00-04:00', end: '2026-07-10T17:30:00-04:00', startMs: Date.parse('2026-07-10T17:00:00-04:00') })
    );
    expect(rescheduled.occurrenceKey).toBe(original.occurrenceKey); // same key → same prep row
    expect(rescheduled.occurrenceStart).not.toBe(original.occurrenceStart); // moved start tracked
  });

  it('treats a one-off (no suffix) as its own series', () => {
    const id = occurrenceIdentity(ev({ id: 'solo1', seriesId: 'solo1' }));
    expect(id.seriesKey).toBe('solo1');
    expect(id.occurrenceKey).toBe('solo1');
    expect(id.originalStart).toBeNull();
  });
});

describe('occurrenceEndMs', () => {
  it('parses a timed end', () => {
    expect(occurrenceEndMs(ev())).toBe(Date.parse('2026-07-10T15:30:00-04:00'));
  });
  it('returns null for an empty end', () => {
    expect(occurrenceEndMs(ev({ end: '' }))).toBeNull();
  });
});

describe('nextOccurrence', () => {
  const afterMs = Date.parse('2026-07-10T15:00:00-04:00');
  const events = [
    ev({ id: 'abc_20260703', startMs: afterMs - 7 * 86_400_000 }), // prior week
    ev({ id: 'abc_20260717', startMs: afterMs + 7 * 86_400_000 }), // next week
    ev({ id: 'abc_20260724', startMs: afterMs + 14 * 86_400_000 }), // two weeks
    ev({ id: 'other_20260711', seriesId: 'other', startMs: afterMs + 86_400_000 }), // different series
  ];

  it('picks the earliest occurrence of the series strictly after afterMs', () => {
    const next = nextOccurrence(events, 'abc', afterMs);
    expect(next?.id).toBe('abc_20260717');
  });

  it('ignores other series and past occurrences', () => {
    const next = nextOccurrence(events, 'abc', afterMs + 8 * 86_400_000);
    expect(next?.id).toBe('abc_20260724');
  });

  it('returns null when the window holds no future occurrence', () => {
    expect(nextOccurrence(events, 'abc', afterMs + 100 * 86_400_000)).toBeNull();
  });
});
