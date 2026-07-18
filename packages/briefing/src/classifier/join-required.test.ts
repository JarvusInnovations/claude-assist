import { describe, expect, it } from 'bun:test';
import type { CalendarEvent, SeriesOverride } from '../types.js';
import {
  DEFAULT_PHYSICAL_LEAD_MINUTES,
  DEFAULT_VIDEO_LEAD_MINUTES,
  classifyEvent,
  conferencingUrl,
  detectVenue,
  isAmbiguous,
  leadMinutesFor,
} from './join-required.js';
import { parseJoin } from './llm.js';

function mkEvent(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt_20260710T190000Z',
    seriesId: 'evt',
    summary: 'Project sync',
    start: '2026-07-10T15:00:00-04:00',
    end: '2026-07-10T15:30:00-04:00',
    allDay: false,
    startMs: Date.parse('2026-07-10T15:00:00-04:00'),
    myResponse: 'accepted',
    attendeeCount: 3,
    location: '',
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    description: '',
    status: 'confirmed',
    ...over,
  };
}

describe('deterministic noise classes fire nothing', () => {
  it('all-day event', () => {
    const c = classifyEvent(mkEvent({ allDay: true, start: '2026-07-10' }));
    expect(c.joinRequired).toBe(false);
    expect(c.reason).toBe('all-day');
  });

  it('declined by the owner', () => {
    const c = classifyEvent(mkEvent({ myResponse: 'declined' }));
    expect(c.joinRequired).toBe(false);
    expect(c.reason).toBe('declined');
  });

  it.each([
    ['IC Focus Time'],
    ['Hold for review'],
    ['Deep work block'],
    ['Lunch'],
    ['OOO — vacation'],
    ['Commute'],
    ['DND'],
    ['No meetings'],
    ['WFH'],
  ])('hold/focus pattern: %s', (summary) => {
    const c = classifyEvent(mkEvent({ summary }));
    expect(c.joinRequired).toBe(false);
    expect(c.reason).toStartWith('noise-pattern:');
  });

  it('no other attendees (solo block)', () => {
    const c = classifyEvent(mkEvent({ attendeeCount: 1 }));
    expect(c.joinRequired).toBe(false);
    expect(c.reason).toBe('no-other-attendees');
  });

  it('has attendees but no venue', () => {
    const c = classifyEvent(mkEvent({ hangoutLink: '', location: '', description: '' }));
    expect(c.joinRequired).toBe(false);
    expect(c.reason).toBe('no-venue');
  });
});

describe('join-required cases fire', () => {
  it('video call with other attendees', () => {
    const c = classifyEvent(mkEvent());
    expect(c.joinRequired).toBe(true);
    expect(c.reason).toBe('conferencing+attendees');
    expect(c.venue).toBe('video');
  });

  it('in-person meeting with a physical location', () => {
    const c = classifyEvent(
      mkEvent({ hangoutLink: '', location: '1234 Market St, 5th Floor', description: '' })
    );
    expect(c.joinRequired).toBe(true);
    expect(c.reason).toBe('location+attendees');
    expect(c.venue).toBe('physical');
  });

  it('detects a conferencing link buried in the description', () => {
    const c = classifyEvent(
      mkEvent({ hangoutLink: '', location: '', description: 'Join: https://zoom.us/j/123' })
    );
    expect(c.joinRequired).toBe(true);
    expect(c.venue).toBe('video');
  });
});

describe('ambiguous residue routes to the model', () => {
  it('optional in the summary', () => {
    const c = classifyEvent(mkEvent({ summary: 'Team sync (optional)' }));
    expect(isAmbiguous(c)).toBe(true);
    expect(c.joinRequired).toBe(false); // conservative until the model rules
  });

  it('a tentative RSVP', () => {
    const c = classifyEvent(mkEvent({ myResponse: 'tentative' }));
    expect(isAmbiguous(c)).toBe(true);
  });
});

describe('override precedence', () => {
  const suppress: SeriesOverride = { seriesId: 'evt', action: 'suppress', leadMinutes: null, note: null };
  const force: SeriesOverride = { seriesId: 'evt', action: 'force', leadMinutes: null, note: null };

  it('suppress beats a clean join-required event', () => {
    const c = classifyEvent(mkEvent(), suppress);
    expect(c.joinRequired).toBe(false);
    expect(c.reason).toBe('override:suppress');
    expect(c.source).toBe('override');
  });

  it('force beats a hard-noise pattern', () => {
    const c = classifyEvent(mkEvent({ summary: 'Standing hold' }), force);
    expect(c.joinRequired).toBe(true);
    expect(c.reason).toBe('override:force');
  });
});

describe('lead times', () => {
  it('video default 1 min, physical default 15 min', () => {
    expect(DEFAULT_VIDEO_LEAD_MINUTES).toBe(1);
    expect(DEFAULT_PHYSICAL_LEAD_MINUTES).toBe(15);
    expect(leadMinutesFor(classifyEvent(mkEvent()))).toBe(1);
    const physical = classifyEvent(mkEvent({ hangoutLink: '', location: '100 Main St' }));
    expect(leadMinutesFor(physical)).toBe(15);
  });

  it('a name-only conferencing location gets the video lead, not the physical one', () => {
    const c = classifyEvent(mkEvent({ hangoutLink: '', location: 'Microsoft Teams Meeting' }));
    expect(leadMinutesFor(c)).toBe(DEFAULT_VIDEO_LEAD_MINUTES);
  });

  it('override custom lead wins', () => {
    const override: SeriesOverride = { seriesId: 'evt', action: 'force', leadMinutes: 30, note: null };
    expect(leadMinutesFor(classifyEvent(mkEvent(), override), override)).toBe(30);
  });
});

describe('detectVenue', () => {
  it('classifies a bare URL location as video, not physical', () => {
    expect(detectVenue(mkEvent({ hangoutLink: '', location: 'https://zoom.us/j/1' }))).toBe('video');
  });

  // The Outlook-invite shape: location holds the conferencing service NAME and
  // no URL anywhere on the event. Still a video meeting.
  it.each([
    ['Microsoft Teams Meeting'],
    ['Teams Meeting'],
    ['Zoom Meeting'],
    ['Zoom'],
    ['Google Meet'],
    ['meet.google.com/abc-defg-hij'],
    ['Webex'],
    ['GoToMeeting'],
    ['Hangout'],
    ['Hangouts'],
    ['Microsoft Teams Meeting; conference ID 123 456 789#'],
  ])('name-only conferencing location → video: %s', (location) => {
    const event = mkEvent({ hangoutLink: '', location, description: '' });
    expect(detectVenue(event)).toBe('video');
    const c = classifyEvent(event);
    expect(c.venue).toBe('video');
    expect(c.joinRequired).toBe(true);
    expect(c.reason).toBe('conferencing+attendees');
  });

  it('a street address stays physical', () => {
    const event = mkEvent({ hangoutLink: '', location: '1234 Market St, 5th Floor', description: '' });
    expect(detectVenue(event)).toBe('physical');
  });

  it('an explicit conferencing URL in the location is still video', () => {
    expect(
      detectVenue(mkEvent({ hangoutLink: '', location: 'https://teams.microsoft.com/l/meetup-join/xyz' }))
    ).toBe('video');
  });

  it('a conferencing URL still wins even alongside a physical-looking location', () => {
    expect(detectVenue(mkEvent({ location: '1234 Market St, 5th Floor' }))).toBe('video');
  });
});

describe('conferencingUrl', () => {
  it('prefers hangoutLink when present', () => {
    expect(conferencingUrl(mkEvent())).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('falls back to an http(s) URL in the location', () => {
    expect(
      conferencingUrl(mkEvent({ hangoutLink: '', location: 'https://zoom.us/j/1' }))
    ).toBe('https://zoom.us/j/1');
  });

  it('falls back to an http(s) URL buried in the description', () => {
    expect(
      conferencingUrl(
        mkEvent({ hangoutLink: '', location: '', description: 'Join: https://zoom.us/j/123.' })
      )
    ).toBe('https://zoom.us/j/123');
  });

  it('returns null for a bare domain with no scheme (not trivially safe to link)', () => {
    expect(
      conferencingUrl(mkEvent({ hangoutLink: '', location: 'meet.google.com/abc', description: '' }))
    ).toBeNull();
  });

  it('returns null for a physical location with no conferencing link', () => {
    expect(
      conferencingUrl(mkEvent({ hangoutLink: '', location: '1234 Market St, 5th Floor', description: '' }))
    ).toBeNull();
  });

  it('returns null for a name-only conferencing location (video venue, but no link to join)', () => {
    expect(
      conferencingUrl(mkEvent({ hangoutLink: '', location: 'Microsoft Teams Meeting', description: '' }))
    ).toBeNull();
  });
});

describe('parseJoin (model output)', () => {
  it('parses a valid join verdict', () => {
    expect(parseJoin('<join>{"join_required": true, "confidence": 0.9}</join>')).toEqual({
      joinRequired: true,
      confidence: 0.9,
    });
  });

  it('throws without tags', () => {
    expect(() => parseJoin('no tags here')).toThrow();
  });

  it('throws on a non-boolean verdict', () => {
    expect(() => parseJoin('<join>{"join_required":"yes"}</join>')).toThrow();
  });
});
