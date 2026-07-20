import { describe, expect, it } from 'bun:test';
import {
  isDateOnly,
  parseAttendeeCount,
  parseEventsToon,
  stripInstanceSuffix,
} from './gws-axi.js';
import { classifyEvent, conferencingUrl, detectVenue } from '../classifier/join-required.js';

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

describe('parseEventsToon — TOON escaping regression', () => {
  // A meeting whose description carries an HTML anchor (embedded `\"`) followed
  // by a populated `hangoutLink` column. The old hand-rolled CSV splitter
  // truncated the row at the first `\"` and dropped every column after it —
  // losing the hangoutLink, so the event silently fell out of alerts/briefings.
  const LINKED = [
    'account: user@example.com',
    'count: 1',
    'events[1]{id,summary,start,end,my_response,attendees,location,description,hangoutLink}:',
    '  abc_20260720T190000Z,Partner Review,"2026-07-20T15:00:00-04:00","2026-07-20T15:30:00-04:00",' +
      'accepted,"3 (2 accepted, 1 needsAction)","",' +
      '"Agenda: <a href=\\"https://docs.example/x\\">doc</a>","https://meet.google.com/abc-defg-hij"',
    'help[1]:',
    '  Run `gws-axi calendar get <id>`',
  ].join('\n');

  it('keeps the hangoutLink column intact past an embedded-quote description', () => {
    const [event] = parseEventsToon(LINKED);
    expect(event!.description).toBe('Agenda: <a href="https://docs.example/x">doc</a>');
    expect(event!.hangoutLink).toBe('https://meet.google.com/abc-defg-hij');
    expect(event!.attendeeCount).toBe(3);
  });

  it('classifies the recovered event as join-required', () => {
    const [event] = parseEventsToon(LINKED);
    const classification = classifyEvent(event!);
    expect(classification.joinRequired).toBe(true);
    expect(classification.venue).toBe('video');
  });

  it('decodes an escaped newline in a description to a real newline', () => {
    const withNewline = [
      'count: 1',
      'events[1]{id,summary,start,end,my_response,attendees,location,description,hangoutLink}:',
      '  d1,Focus,2026-07-20,2026-07-21,"","","","Line one\\nLine two",""',
    ].join('\n');
    const [event] = parseEventsToon(withNewline);
    expect(event!.description).toBe('Line one\nLine two');
  });
});

describe('parseEventsToon — join_url (gws-axi 0.17.0)', () => {
  // Externally-organized Teams/Zoom/Webex meetings carry no hangoutLink and no
  // usable link in location/description — the bug this fixture regression-tests
  // (issue #115). gws-axi 0.17.0's structured `join_url` column is the fix: it
  // resolves the link from conferenceData even when hangoutLink is empty.
  const TEAMS = [
    'account: user@example.com',
    'count: 1',
    'events[1]{id,summary,start,end,my_response,attendees,location,description,hangoutLink,join_url}:',
    '  teams1_20260721T190000Z,Vendor sync,"2026-07-21T15:00:00-04:00","2026-07-21T15:30:00-04:00",' +
      'accepted,"2 (1 accepted, 1 needsAction)","Microsoft Teams Meeting","",' +
      '"","https://teams.microsoft.com/l/meetup-join/example-conference-id"',
    'help[1]:',
    '  Run `gws-axi calendar get <id>`',
  ].join('\n');

  // A Meet meeting: hangoutLink is populated, join_url comes back empty (Meet
  // meetings resolve their link via hangoutLink rather than conferenceData).
  const MEET = [
    'account: user@example.com',
    'count: 1',
    'events[1]{id,summary,start,end,my_response,attendees,location,description,hangoutLink,join_url}:',
    '  meet1_20260721T190000Z,Design review,"2026-07-21T15:00:00-04:00","2026-07-21T15:30:00-04:00",' +
      'accepted,"2 (1 accepted, 1 needsAction)","","",' +
      '"https://meet.google.com/abc-defg-hij",""',
    'help[1]:',
    '  Run `gws-axi calendar get <id>`',
  ].join('\n');

  // A physical, no-conferencing meeting: join_url and hangoutLink both empty.
  const PHYSICAL = [
    'account: user@example.com',
    'count: 1',
    'events[1]{id,summary,start,end,my_response,attendees,location,description,hangoutLink,join_url}:',
    '  room1_20260721T190000Z,Onsite kickoff,"2026-07-21T15:00:00-04:00","2026-07-21T15:30:00-04:00",' +
      'accepted,"2 (1 accepted, 1 needsAction)","100 Main St, 5th Floor","",' +
      '"",""',
    'help[1]:',
    '  Run `gws-axi calendar get <id>`',
  ].join('\n');

  it('parses join_url onto the event, ahead of an empty hangoutLink', () => {
    const [event] = parseEventsToon(TEAMS);
    expect(event!.joinUrl).toBe('https://teams.microsoft.com/l/meetup-join/example-conference-id');
    expect(event!.hangoutLink).toBe('');
  });

  it('a Teams-shaped fixture (no hangoutLink, name-only location, join_url present) yields a Join link and classifies join-required with a video venue', () => {
    const [event] = parseEventsToon(TEAMS);
    expect(conferencingUrl(event!)).toBe(
      'https://teams.microsoft.com/l/meetup-join/example-conference-id'
    );
    expect(detectVenue(event!)).toBe('video');
    const classification = classifyEvent(event!);
    expect(classification.joinRequired).toBe(true);
    expect(classification.venue).toBe('video');
  });

  it('a Meet fixture (hangoutLink present, join_url empty) still resolves a Join link via the hangoutLink fallback', () => {
    const [event] = parseEventsToon(MEET);
    expect(event!.joinUrl).toBe('');
    expect(event!.hangoutLink).toBe('https://meet.google.com/abc-defg-hij');
    expect(conferencingUrl(event!)).toBe('https://meet.google.com/abc-defg-hij');
    const classification = classifyEvent(event!);
    expect(classification.joinRequired).toBe(true);
    expect(classification.venue).toBe('video');
  });

  it('a physical/no-link fixture still yields no join link', () => {
    const [event] = parseEventsToon(PHYSICAL);
    expect(event!.joinUrl).toBe('');
    expect(event!.hangoutLink).toBe('');
    expect(conferencingUrl(event!)).toBeNull();
    expect(detectVenue(event!)).toBe('physical');
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
