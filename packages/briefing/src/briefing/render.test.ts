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
        { slug: 'a', title: 'Send quote', dueDate: '2026-07-01', assignee: 'the owner', madeTo: 'Acme Transit', firmness: 'soft', overdue: true, dueToday: false },
      ],
      dueToday: [],
      upcomingCount: 2,
      error: null,
    },
    email: {
      needsAttention: [
        { subject: 'Re: contract', fromName: 'Nate', fromAddress: 'nate@example.com', overview: 'Wants sign-off before the 3pm call' },
      ],
      otherHuman: [],
      otherHumanCount: 6,
      otherTopSenders: [
        { name: 'Dana', count: 2 },
        { name: 'Sam', count: 1 },
      ],
      untriagedCount: 4,
      error: null,
    },
    captures: { awaitingReview: 2, awaitingExecutor: 1, error: null },
    coverage: { pipelines: [{ name: 'email-sync', ageHours: 30, thresholdHours: 12, ratio: 2.5, stale: true }], staleCount: 1, error: null },
    ledger: { totalCount: 0, groups: [], error: null },
    kitchen: { calories: 1450, proteinG: 95, satFatG: 12.5, pendingCount: 1, eatFirst: [], suggestions: [], error: null },
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
    for (const section of [
      'Today',
      'Open commitments',
      'Email',
      'Captures awaiting review',
      'Kitchen today',
      'Pipeline health',
    ]) {
      expect(paste).toContain(section);
    }
  });

  it('renders kitchen totals and the pending-estimate count', () => {
    expect(paste).toContain('1450 cal · 95g protein · 12.5g sat fat');
    expect(paste).toContain('1 entry still estimating');
  });

  it('renders an eat-first line and stock-aware meal ideas when present', () => {
    const paste2 = renderTanaPaste(
      sampleBriefing({
        kitchen: {
          calories: 500,
          proteinG: 30,
          satFatG: 5,
          pendingCount: 0,
          eatFirst: [
            { label: 'Feta', state: 'open', eatBy: '2026-07-11', daysUntil: 1, fraction: 0.5 },
            { label: 'Berries', state: 'stocked', eatBy: '2026-07-09', daysUntil: -1, fraction: 1 },
          ],
          suggestions: [{ name: 'Greek bowl', have: 2, total: 3 }],
          error: null,
        },
      })
    );
    expect(paste2).toContain('Eat first');
    expect(paste2).toContain('Feta (open) — eat by 1d');
    expect(paste2).toContain('Berries — eat by 1d overdue');
    expect(paste2).toContain('Meal ideas from stock');
    expect(paste2).toContain('Greek bowl (2/3 components on hand)');
  });

  it('omits eat-first and meal-idea lines when the inventory is empty', () => {
    expect(paste).not.toContain('Eat first');
    expect(paste).not.toContain('Meal ideas from stock');
  });

  it('shows "nothing logged yet" on a quiet kitchen day', () => {
    const quiet = renderTanaPaste(
      sampleBriefing({ kitchen: { calories: 0, proteinG: 0, satFatG: 0, pendingCount: 0, eatFirst: [], suggestions: [], error: null } })
    );
    expect(quiet).toContain('Nothing logged yet');
  });

  it('shows a not-available line when the kitchen read fails', () => {
    const paste2 = renderTanaPaste(
      sampleBriefing({ kitchen: { calories: 0, proteinG: 0, satFatG: 0, pendingCount: 0, eatFirst: [], suggestions: [], error: 'kitchen schema missing' } })
    );
    expect(paste2).toContain('Kitchen summary not available: kitchen schema missing');
  });

  it('lists needs-attention email with sender + overview, and rolls up the rest', () => {
    expect(paste).toContain('Needs attention (1)');
    expect(paste).toContain('Nate: Re: contract — Wants sign-off before the 3pm call');
    expect(paste).toContain('Other human mail (6)');
    expect(paste).toContain('Top senders: Dana (2), Sam');
  });

  it('lists other human mail individually when the bucket is small', () => {
    const paste2 = renderTanaPaste(
      sampleBriefing({
        email: {
          needsAttention: [],
          otherHuman: [
            { subject: 'lunch?', fromName: 'Pat', fromAddress: 'pat@example.com', overview: 'Asking about lunch Thursday' },
          ],
          otherHumanCount: 1,
          otherTopSenders: [{ name: 'Pat', count: 1 }],
          untriagedCount: 0,
          error: null,
        },
      })
    );
    expect(paste2).toContain('Needs attention: none');
    expect(paste2).toContain('Other human mail (1)');
    expect(paste2).toContain('Pat: lunch? — Asking about lunch Thursday');
  });

  it('truncates an oversized email overview', () => {
    const long = 'x'.repeat(400);
    const paste2 = renderTanaPaste(
      sampleBriefing({
        email: {
          needsAttention: [
            { subject: 'big', fromName: 'Lee', fromAddress: 'lee@example.com', overview: long },
          ],
          otherHuman: [],
          otherHumanCount: 0,
          otherTopSenders: [],
          untriagedCount: 0,
          error: null,
        },
      })
    );
    const emailLine = paste2.split('\n').find((l) => l.includes('Lee: big'))!;
    expect(emailLine.length).toBeLessThan(200);
    expect(emailLine).toContain('…');
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

  it("omits Yesterday's actions entirely on a quiet day", () => {
    expect(paste).not.toContain("Yesterday's actions");
  });

  it("renders Yesterday's actions with a headline count and per-group lines", () => {
    const paste2 = renderTanaPaste(
      sampleBriefing({
        ledger: {
          totalCount: 12,
          groups: [
            {
              actionType: 'repo-write',
              targetSystem: 'github',
              count: 5,
              summaries: ['merged PR #67', 'opened PR #70'],
            },
            {
              actionType: 'team-record-write',
              targetSystem: 'hq',
              count: 3,
              summaries: ['logged meeting'],
            },
          ],
          error: null,
        },
      })
    );
    expect(paste2).toContain("Yesterday's actions");
    expect(paste2).toContain('12 external actions');
    expect(paste2).toContain('repo-write:github ×5 — merged PR #67, opened PR #70');
    expect(paste2).toContain('team-record-write:hq ×3 — logged meeting');
  });

  it("shows a not-available line when the ledger read fails", () => {
    const paste2 = renderTanaPaste(
      sampleBriefing({ ledger: { totalCount: 0, groups: [], error: 'ledger schema missing' } })
    );
    expect(paste2).toContain('Ledger not available: ledger schema missing');
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
