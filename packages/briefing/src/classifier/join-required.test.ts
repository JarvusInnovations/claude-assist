import { describe, expect, it } from 'bun:test';
import type { CalendarEvent, SeriesOverride } from '../types.js';
import {
  DEFAULT_PHYSICAL_LEAD_MINUTES,
  DEFAULT_VIDEO_LEAD_MINUTES,
  classifyEvent,
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

  it('declined by Chris', () => {
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
  it('video default 3 min, physical default 15 min', () => {
    expect(leadMinutesFor(classifyEvent(mkEvent()))).toBe(DEFAULT_VIDEO_LEAD_MINUTES);
    const physical = classifyEvent(mkEvent({ hangoutLink: '', location: '100 Main St' }));
    expect(leadMinutesFor(physical)).toBe(DEFAULT_PHYSICAL_LEAD_MINUTES);
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
