import { describe, expect, it } from 'bun:test';
import type { AlertPlanItem, CalendarEvent } from '../types.js';
import { buildHeadline, composeBriefing, type BriefingInputs } from './compose.js';
import type { OpenCommitment } from './sources/commitments.js';

function mkEvent(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    seriesId: 'e1',
    summary: 'Client call',
    start: '2026-07-10T15:00:00-04:00',
    end: '2026-07-10T15:30:00-04:00',
    allDay: false,
    startMs: Date.parse('2026-07-10T15:00:00-04:00'),
    myResponse: 'accepted',
    attendeeCount: 3,
    location: '',
    hangoutLink: 'https://meet.google.com/abc',
    description: '',
    status: 'confirmed',
    ...over,
  };
}

function mkCommitment(over: Partial<OpenCommitment>): OpenCommitment {
  return {
    slug: 's',
    title: 'Do a thing',
    dueDate: null,
    assignee: 'Chris',
    madeTo: 'Client',
    firmness: 'soft',
    overdue: false,
    dueToday: false,
    ...over,
  };
}

function baseInputs(over: Partial<BriefingInputs> = {}): BriefingInputs {
  const event = mkEvent();
  const alertItem: AlertPlanItem = {
    event,
    classification: { joinRequired: true, reason: 'conferencing+attendees', venue: 'video', source: 'deterministic' },
    leadMinutes: 3,
    fireAtMs: event.startMs! - 3 * 60_000,
  };
  return {
    dateIso: '2026-07-10',
    calendar: { events: [event], error: null },
    alertPlan: [alertItem],
    commitments: {
      commitments: [
        mkCommitment({ slug: 'a', overdue: true, dueDate: '2026-07-01' }),
        mkCommitment({ slug: 'b', dueToday: true, dueDate: '2026-07-10' }),
        mkCommitment({ slug: 'c', dueDate: '2026-08-01' }),
      ],
      error: null,
    },
    email: {
      needsAttention: [
        { subject: 'Re: contract', fromName: 'Nate', fromAddress: 'nate@example.com', overview: 'needs sign-off' },
      ],
      otherHuman: [],
      otherHumanCount: 6,
      otherTopSenders: [{ name: 'Dana', count: 2 }],
      untriagedCount: 4,
      error: null,
    },
    captures: { awaitingReview: 2, awaitingExecutor: 0, error: null },
    coverage: {
      pipelines: [
        { name: 'triage', ageHours: 1, thresholdHours: 6, ratio: 0.2, stale: false },
        { name: 'email-sync', ageHours: 30, thresholdHours: 12, ratio: 2.5, stale: true },
      ],
      staleCount: 1,
      error: null,
    },
    pageBaseUrl: 'https://assist.example',
    ...over,
  };
}

describe('composeBriefing', () => {
  it('splits commitments into overdue / due-today / upcoming', () => {
    const b = composeBriefing(baseInputs());
    expect(b.commitments.overdue.map((c) => c.slug)).toEqual(['a']);
    expect(b.commitments.dueToday.map((c) => c.slug)).toEqual(['b']);
    expect(b.commitments.upcomingCount).toBe(1);
  });

  it('surfaces the will-alert-today subset', () => {
    const b = composeBriefing(baseInputs());
    expect(b.calendar.alerting).toHaveLength(1);
    expect(b.calendar.alerting[0]!.event.id).toBe('e1');
  });

  it('builds a headline from the salient counts', () => {
    const b = composeBriefing(baseInputs());
    expect(b.headline).toContain('1 to join');
    expect(b.headline).toContain('1 overdue');
    expect(b.headline).toContain('1 email needs attention');
  });

  it('emits links only when a base url is given', () => {
    expect(composeBriefing(baseInputs()).links.length).toBeGreaterThan(0);
    expect(composeBriefing(baseInputs({ pageBaseUrl: null })).links).toHaveLength(0);
  });

  it('passes through source errors without throwing', () => {
    const b = composeBriefing(
      baseInputs({
        commitments: { commitments: [], error: 'commitments source missing' },
        calendar: { events: [], error: 'gws-axi missing' },
      })
    );
    expect(b.commitments.error).toBe('commitments source missing');
    expect(b.calendar.error).toBe('gws-axi missing');
    expect(b.headline).toContain('email needs attention');
  });
});

describe('buildHeadline', () => {
  it('falls back to a clear-day message', () => {
    expect(
      buildHeadline({ timedMeetings: 0, alertingCount: 0, overdueCount: 0, dueTodayCount: 0, needsAttentionCount: 0 })
    ).toContain('Clear day');
  });
  it('caps at three parts', () => {
    const h = buildHeadline({ timedMeetings: 5, alertingCount: 2, overdueCount: 3, dueTodayCount: 1, needsAttentionCount: 4 });
    expect(h.split(' · ').length).toBeLessThanOrEqual(3);
  });
});
