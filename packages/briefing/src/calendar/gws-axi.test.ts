import { describe, expect, it } from 'bun:test';
import {
  isDateOnly,
  parseAttendeeCount,
  parseEventsToon,
  stripInstanceSuffix,
} from './gws-axi.js';

// A verbatim-shaped gws-axi `calendar events --fields status,attendees,location,
// description,hangoutLink` frame (columns reordered as the CLI emits them).
const SAMPLE = [
  'account: user@example.com',
  'count: 3',
  'range: "2026-07-10T04:00:00.000Z → 2026-07-11T03:59:00.000Z"',
  'events[3]{id,summary,start,end,my_response,attendees,location,description,hangoutLink}:',
  '  km00c10hl9rtbdnu4bke8qsh48_20260710,Office,2026-07-10,2026-07-11,"","","","",""',
  '  41d7gfneagfltatb86310ivlmb_20260710T120000Z,IC Focus Time,"2026-07-10T08:00:00-04:00","2026-07-10T18:00:00-04:00","","","","",""',
  '  1rh0p1f8dcma9tf8cs4heeamlf_20260710T190000Z,Strategic Partnership Touchpoint,"2026-07-10T15:00:00-04:00","2026-07-10T15:25:00-04:00",needsAction,"5 (1 accepted, 3 needsAction, 1 declined)","","","https://meet.google.com/npe-svhu-zjp"',
  'help[1]:',
  '  Run `gws-axi calendar get <id>`',
].join('\n');

describe('parseEventsToon', () => {
  const events = parseEventsToon(SAMPLE);

  it('parses every event row', () => {
    expect(events).toHaveLength(3);
  });

  it('flags all-day (date-only) events and parses times', () => {
    expect(events[0]!.allDay).toBe(true);
    expect(events[1]!.allDay).toBe(false);
    expect(events[1]!.startMs).not.toBeNull();
  });

  it('parses the attendee count out of the summary field, commas and all', () => {
    expect(events[2]!.attendeeCount).toBe(5);
    expect(events[2]!.myResponse).toBe('needsAction');
    expect(events[2]!.hangoutLink).toBe('https://meet.google.com/npe-svhu-zjp');
  });

  it('derives the series id by stripping the instance suffix', () => {
    expect(events[2]!.seriesId).toBe('1rh0p1f8dcma9tf8cs4heeamlf');
  });

  it('returns [] when no events frame is present', () => {
    expect(parseEventsToon('account: x\ncount: 0')).toEqual([]);
  });
});

describe('helpers', () => {
  it('parseAttendeeCount', () => {
    expect(parseAttendeeCount('')).toBe(0);
    expect(parseAttendeeCount('5 (1 accepted, 3 needsAction)')).toBe(5);
    expect(parseAttendeeCount('1')).toBe(1);
  });

  it('stripInstanceSuffix handles date and datetime suffixes', () => {
    expect(stripInstanceSuffix('abc_20260710')).toBe('abc');
    expect(stripInstanceSuffix('abc_20260710T190000Z')).toBe('abc');
    expect(stripInstanceSuffix('plain-id')).toBe('plain-id');
  });

  it('isDateOnly', () => {
    expect(isDateOnly('2026-07-10')).toBe(true);
    expect(isDateOnly('2026-07-10T15:00:00-04:00')).toBe(false);
  });
});
