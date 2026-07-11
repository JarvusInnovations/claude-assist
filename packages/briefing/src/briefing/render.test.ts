import { describe, expect, it } from 'bun:test';
import type { Briefing } from './compose.js';
import { BRIEFING_MARKER, briefingHeading, extractNodeId, renderTanaPaste } from './render.js';

function sampleBriefing(over: Partial<Briefing> = {}): Briefing {
  return {
    dateIso: '2026-07-10',
    headline: '1 to join · 1 overdue · 1 urgent email',
    calendar: {
      events: [
        {
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
        },
      ],
      alerting: [
        {
          event: {
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
          },
          classification: { joinRequired: true, reason: 'conferencing+attendees', venue: 'video', source: 'deterministic' },
          leadMinutes: 3,
          fireAtMs: Date.parse('2026-07-10T14:57:00-04:00'),
        },
      ],
      error: null,
    },
    commitments: {
      overdue: [
        { slug: 'a', title: 'Send quote', dueDate: '2026-07-01', assignee: 'Chris', madeTo: 'SEPTA', firmness: 'soft', overdue: true, dueToday: false },
      ],
      dueToday: [],
      upcomingCount: 2,
      error: null,
    },
    email: { urgent: [{ subject: 'Re: contract', fromName: 'Nate', overview: 'x' }], urgentCount: 1, untriagedCount: 4, error: null },
    captures: { awaitingReview: 2, awaitingExecutor: 1, error: null },
    coverage: { pipelines: [{ name: 'email-sync', ageHours: 30, thresholdHours: 12, ratio: 2.5, stale: true }], staleCount: 1, error: null },
    links: [{ label: 'Inbox', url: 'https://assist.example/inbox' }],
    ...over,
  };
}

describe('renderTanaPaste', () => {
  const paste = renderTanaPaste(sampleBriefing());

  it('opens with the dated briefing heading node', () => {
    expect(paste.split('\n')[0]).toBe(`- ${briefingHeading('2026-07-10')}`);
    expect(paste).toContain(BRIEFING_MARKER);
  });

  it('marks the will-alert event and lists a Join alerts section', () => {
    expect(paste).toContain('Client call [will alert]');
    expect(paste).toContain('Join alerts today');
    expect(paste).toContain('3m lead');
  });

  it('renders every contract section', () => {
    for (const section of ['Today', 'Open commitments', 'Urgent email', 'Captures awaiting review', 'Pipeline health']) {
      expect(paste).toContain(section);
    }
  });

  it('shows a not-available line when a source errored', () => {
    const paste2 = renderTanaPaste(
      sampleBriefing({ commitments: { overdue: [], dueToday: [], upcomingCount: 0, error: 'commitments source missing' } })
    );
    expect(paste2).toContain('Commitments not available: commitments source missing');
  });

  it('uses only bullets (no supertags, no numbered lists)', () => {
    for (const line of paste.split('\n')) {
      expect(line.trimStart().startsWith('- ')).toBe(true);
      expect(line).not.toContain('#');
    }
  });
});

describe('extractNodeId', () => {
  it('reads a bare id', () => {
    expect(extractNodeId('  aBc123  ')).toBe('aBc123');
  });
  it('reads {nodeId}', () => {
    expect(extractNodeId('{"nodeId":"xyz"}')).toBe('xyz');
  });
  it('reads {id}', () => {
    expect(extractNodeId('{"id":"qqq","other":1}')).toBe('qqq');
  });
  it('reads a quoted json string', () => {
    expect(extractNodeId('"nodeZ"')).toBe('nodeZ');
  });
  it('empty in, empty out', () => {
    expect(extractNodeId('   ')).toBe('');
  });
});
