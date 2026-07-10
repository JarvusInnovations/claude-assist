import { describe, expect, it } from 'bun:test';
import { classifyUrgency, isKnownSender, hasTimeSensitivitySignal } from './urgency.js';

const WHITELIST = new Set(['nate@client.org', 'user@example.com']);
const TEAM = ['example.com'];

function input(overrides: Partial<Parameters<typeof classifyUrgency>[0]> = {}) {
  return {
    senderAddress: 'nate@client.org',
    senderType: 'human' as const,
    subject: 'Contract question',
    bodyText: 'Can you send the SOW when you get a chance?',
    snippet: null,
    actionItems: [] as string[],
    whitelist: WHITELIST,
    teamDomains: TEAM,
    ...overrides,
  };
}

describe('classifyUrgency — the interrupt bar', () => {
  it('fires for a known human sender with an explicit deadline phrase', () => {
    const r = classifyUrgency(
      input({ bodyText: 'I need the SOW by end of day, we are blocked on it.' })
    );
    expect(r.urgent).toBe(true);
    expect(r.reason).toContain('deadline/urgency phrase');
  });

  it('fires for a known human sender when analysis surfaced action items', () => {
    const r = classifyUrgency(
      input({ bodyText: 'Following up.', actionItems: ['Send the signed SOW'] })
    );
    expect(r.urgent).toBe(true);
    expect(r.reason).toContain('action item');
  });

  it('does NOT fire for a known human sender with no time-sensitivity signal (digest material)', () => {
    const r = classifyUrgency(
      input({ bodyText: 'Just wanted to say the demo looked great.', actionItems: [] })
    );
    expect(r.urgent).toBe(false);
    expect(r.reason).toContain('no time-sensitivity signal');
  });

  it('does NOT fire for an UNKNOWN sender even with an urgent deadline phrase (boundary)', () => {
    const r = classifyUrgency(
      input({
        senderAddress: 'stranger@random.com',
        bodyText: 'URGENT: respond by end of day or lose this deal!',
      })
    );
    expect(r.urgent).toBe(false);
    expect(r.reason).toContain('not on whitelist');
  });

  it('does NOT fire for automated mail even from a team domain with a deadline', () => {
    const r = classifyUrgency(
      input({
        senderAddress: 'noreply@example.com',
        senderType: 'automated',
        bodyText: 'Your report is due by tomorrow.',
      })
    );
    expect(r.urgent).toBe(false);
    expect(r.reason).toContain('automated');
  });

  it('treats a team-domain human sender as known', () => {
    const r = classifyUrgency(
      input({ senderAddress: 'teammate@example.com', bodyText: 'I am blocked on the deploy, need your key asap.' })
    );
    expect(r.urgent).toBe(true);
  });
});

describe('isKnownSender', () => {
  it('matches whitelist addresses case-insensitively', () => {
    expect(isKnownSender('NATE@Client.org', WHITELIST, TEAM)).toBe(true);
  });
  it('matches team domains but not lookalike domains', () => {
    expect(isKnownSender('x@example.com', WHITELIST, TEAM)).toBe(true);
    expect(isKnownSender('x@not-example.com', WHITELIST, TEAM)).toBe(false);
  });
  it('rejects null / empty addresses', () => {
    expect(isKnownSender(null, WHITELIST, TEAM)).toBe(false);
  });
});

describe('hasTimeSensitivitySignal', () => {
  it('detects phrases across subject and body, case-insensitively', () => {
    expect(hasTimeSensitivitySignal('Re: ASAP please', null, null)).toBe(true);
    expect(hasTimeSensitivitySignal(null, 'we are Blocked On the release', null)).toBe(true);
  });
  it('ignores generic CTAs', () => {
    expect(hasTimeSensitivitySignal('Check this out', 'let me know what you think', null)).toBe(false);
  });
});
