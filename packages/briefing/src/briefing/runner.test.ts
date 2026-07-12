import { describe, expect, it } from 'bun:test';
import type { Briefing } from './compose.js';
import { buildBriefingNotification, dayNodeLink } from './runner.js';

function sampleBriefing(over: Partial<Briefing> = {}): Briefing {
  return {
    dateIso: '2026-07-10',
    headline: '1 to join · 1 overdue · 2 email needs attention',
    calendar: { events: [], alerting: [], error: null },
    commitments: { overdue: [], dueToday: [], upcomingCount: 0, error: null },
    email: {
      needsAttention: [],
      otherHuman: [],
      otherHumanCount: 0,
      otherTopSenders: [],
      untriagedCount: 0,
      error: null,
    },
    captures: { awaitingReview: 0, awaitingExecutor: 0, error: null },
    coverage: { pipelines: [], staleCount: 0, error: null },
    ledger: { totalCount: 0, groups: [], error: null },
    links: [],
    ...over,
  };
}

describe('dayNodeLink', () => {
  it('builds a Tana deep link from a node id', () => {
    expect(dayNodeLink('abc123')).toBe('https://app.tana.inc/?nodeid=abc123');
  });
  it('is undefined without a node id', () => {
    expect(dayNodeLink(null)).toBeUndefined();
  });
});

describe('buildBriefingNotification', () => {
  it('is a notice with the headline title and a body line', () => {
    const n = buildBriefingNotification(sampleBriefing(), 'day1', null);
    expect(n.priority).toBe('notice');
    expect(n.title).toBe('Briefing · 1 to join · 1 overdue · 2 email needs attention');
    expect(n.body).toContain('.');
  });

  it('links the Tana day node in the tappable slot when rendered', () => {
    const n = buildBriefingNotification(sampleBriefing(), 'day1', 'https://assist.example');
    expect(n.url).toBe('https://app.tana.inc/?nodeid=day1');
    expect(n.urlTitle).toBe('Open briefing');
  });

  it('falls back to the page base url when Tana did not render', () => {
    const n = buildBriefingNotification(sampleBriefing(), null, 'https://assist.example');
    expect(n.url).toBe('https://assist.example');
    expect(n.urlTitle).toBe('Open briefing');
  });

  it('omits the link and its label when neither source is available', () => {
    const n = buildBriefingNotification(sampleBriefing(), null, null);
    expect(n.url).toBeUndefined();
    expect(n.urlTitle).toBeUndefined();
  });

  it('mentions yesterday\'s ledger actions in the body when there are any', () => {
    const n = buildBriefingNotification(
      sampleBriefing({ ledger: { totalCount: 7, groups: [], error: null } }),
      null,
      null
    );
    expect(n.body).toContain('7 external actions yesterday');
  });

  it('omits the ledger mention from the body on a quiet day', () => {
    const n = buildBriefingNotification(sampleBriefing(), null, null);
    expect(n.body).not.toContain('external action');
  });
});
