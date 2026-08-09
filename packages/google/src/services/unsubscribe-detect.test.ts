import { describe, expect, it } from 'bun:test';
import {
  checkRateLimit,
  detectUnsubscribeMethod,
  gateSender,
  isOneClickPost,
  parseListUnsubscribe,
  senderDomain,
} from './unsubscribe-detect.js';

describe('parseListUnsubscribe', () => {
  it('splits bracketed URI entries into https and mailto targets', () => {
    const { https, mailtos } = parseListUnsubscribe(
      '<https://lists.example.com/u/abc>, <mailto:unsub@lists.example.com?subject=off>'
    );
    expect(https).toEqual(['https://lists.example.com/u/abc']);
    expect(mailtos).toEqual(['mailto:unsub@lists.example.com?subject=off']);
  });

  it('tolerates a sender that omitted the angle brackets', () => {
    const { https } = parseListUnsubscribe('https://example.com/unsub?id=9');
    expect(https).toEqual(['https://example.com/unsub?id=9']);
  });

  it('drops URI schemes it will not act on', () => {
    const { https, mailtos } = parseListUnsubscribe('<ftp://example.com/x>, <tel:+15551234>');
    expect(https).toEqual([]);
    expect(mailtos).toEqual([]);
  });

  it('returns empty lists for a missing header', () => {
    expect(parseListUnsubscribe(null)).toEqual({ https: [], mailtos: [] });
  });
});

describe('isOneClickPost', () => {
  it('recognizes the RFC 8058 value, with or without spacing', () => {
    expect(isOneClickPost('List-Unsubscribe=One-Click')).toBe(true);
    expect(isOneClickPost('list-unsubscribe = one-click')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isOneClickPost(null)).toBe(false);
    expect(isOneClickPost('List-Unsubscribe=Two-Click')).toBe(false);
  });
});

describe('detectUnsubscribeMethod', () => {
  it('tier 1 needs BOTH the one-click post header and an https target', () => {
    const detected = detectUnsubscribeMethod({
      listUnsubscribe: '<https://lists.example.com/u/abc>, <mailto:u@lists.example.com>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
    });
    expect(detected.tier).toBe(1);
    expect(detected.method).toBe('one_click');
    expect(detected.url).toBe('https://lists.example.com/u/abc');
    expect(detected.mailto).toBe('mailto:u@lists.example.com');
  });

  it('falls to tier 2 when one-click is advertised but only a mailto is offered', () => {
    const detected = detectUnsubscribeMethod(
      {
        listUnsubscribe: '<mailto:u@lists.example.com>',
        listUnsubscribePost: 'List-Unsubscribe=One-Click',
      },
      'https://example.com/manage'
    );
    expect(detected.tier).toBe(2);
    expect(detected.url).toBe('https://example.com/manage');
  });

  it('tier 2 for a link-only List-Unsubscribe header', () => {
    const detected = detectUnsubscribeMethod({
      listUnsubscribe: '<https://example.com/unsub/9>',
    });
    expect(detected.tier).toBe(2);
    expect(detected.method).toBe('browser_form');
    expect(detected.url).toBe('https://example.com/unsub/9');
  });

  it('tier 2 from the triage-extracted body link when no headers exist', () => {
    const detected = detectUnsubscribeMethod({}, 'https://news.example.com/opt-out');
    expect(detected.tier).toBe(2);
    expect(detected.url).toBe('https://news.example.com/opt-out');
    expect(detected.reason).toBe('body unsubscribe link');
  });

  it('tier 3 for a mailto-only offer — sending mail is its own outbound action', () => {
    const detected = detectUnsubscribeMethod({ listUnsubscribe: '<mailto:u@lists.example.com>' });
    expect(detected.tier).toBe(3);
    expect(detected.method).toBe('review');
    expect(detected.url).toBeNull();
    expect(detected.mailto).toBe('mailto:u@lists.example.com');
  });

  it('tier 3 when nothing usable is on offer, including a junk body link', () => {
    expect(detectUnsubscribeMethod({}, 'click here to unsubscribe').tier).toBe(3);
    expect(detectUnsubscribeMethod({}, null).tier).toBe(3);
  });
});

describe('senderDomain', () => {
  it('lowercases the part after the last @', () => {
    expect(senderDomain('News@Lists.Example.COM')).toBe('lists.example.com');
  });
  it('is empty for an unparseable address', () => {
    expect(senderDomain('not-an-address')).toBe('');
  });
});

// ── The two invariants ──────────────────────────────────────────────────────

describe('gateSender — the whitelist hard-gates every tier', () => {
  it('blocks a whitelisted address even when the owner also flagged it', () => {
    const decision = gateSender({
      senderEmail: 'partner@vendor.test',
      standing: 'unsubscribe_queue',
      whitelist: new Set(['partner@vendor.test']),
    });
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ reason: 'whitelisted-address' });
  });

  it('matches the whitelist case-insensitively', () => {
    const decision = gateSender({
      senderEmail: '  Partner@Vendor.Test ',
      standing: 'unsubscribe_queue',
      whitelist: new Set(['partner@vendor.test']),
    });
    expect(decision.allowed).toBe(false);
  });

  it('blocks a team domain, including subdomains', () => {
    for (const email of ['someone@team.test', 'bot@mail.team.test']) {
      const decision = gateSender({
        senderEmail: email,
        standing: 'unsubscribe_queue',
        whitelist: new Set(),
        teamDomains: ['team.test'],
      });
      expect(decision.allowed).toBe(false);
      expect(decision).toMatchObject({ reason: 'whitelisted-domain' });
    }
  });

  it('does not blanket-block a domain that merely ends with the same letters', () => {
    const decision = gateSender({
      senderEmail: 'news@notteam.test',
      standing: 'unsubscribe_queue',
      whitelist: new Set(),
      teamDomains: ['team.test'],
    });
    expect(decision.allowed).toBe(true);
  });

  it('checks the whitelist BEFORE the queue flag, so the safe answer wins a tie', () => {
    const decision = gateSender({
      senderEmail: 'partner@vendor.test',
      standing: null,
      whitelist: new Set(['partner@vendor.test']),
    });
    // Not "not-queued" — the whitelist reason is the one reported, which is
    // what routes the case to review rather than silently dropping it.
    expect(decision).toMatchObject({ allowed: false, reason: 'whitelisted-address' });
  });
});

describe('gateSender — execution draws only from the owner-flagged queue', () => {
  it('allows a queued, non-whitelisted sender', () => {
    expect(
      gateSender({
        senderEmail: 'news@bulk.test',
        standing: 'unsubscribe_queue',
        whitelist: new Set(),
      })
    ).toEqual({ allowed: true });
  });

  it('blocks a sender with no standing at all', () => {
    const decision = gateSender({
      senderEmail: 'news@bulk.test',
      standing: null,
      whitelist: new Set(),
    });
    expect(decision).toMatchObject({ allowed: false, reason: 'not-queued' });
  });

  it('blocks a sender whose standing is whitelist', () => {
    const decision = gateSender({
      senderEmail: 'news@bulk.test',
      standing: 'whitelist',
      whitelist: new Set(),
    });
    expect(decision.allowed).toBe(false);
  });
});

describe('checkRateLimit', () => {
  const now = new Date('2026-08-08T12:00:00Z');
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  it('allows while under the cap', () => {
    const decision = checkRateLimit(
      [minutesAgo(10), minutesAgo(20)],
      { windowMinutes: 60, maxPerDomain: 3 },
      now
    );
    expect(decision.allowed).toBe(true);
  });

  it('blocks at the cap and reports when the window frees a slot', () => {
    const decision = checkRateLimit(
      [minutesAgo(50), minutesAgo(20), minutesAgo(5)],
      { windowMinutes: 60, maxPerDomain: 3 },
      now
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.recent).toBe(3);
    // The oldest in-window action was 50m ago, so a slot opens 10m from now.
    expect(decision.retryAfter.toISOString()).toBe('2026-08-08T12:10:00.000Z');
  });

  it('ignores actions that have aged out of the window', () => {
    const decision = checkRateLimit(
      [minutesAgo(120), minutesAgo(90), minutesAgo(61)],
      { windowMinutes: 60, maxPerDomain: 1 },
      now
    );
    expect(decision.allowed).toBe(true);
  });

  it('honours a configured window and cap', () => {
    const tight = checkRateLimit([minutesAgo(3)], { windowMinutes: 5, maxPerDomain: 1 }, now);
    expect(tight.allowed).toBe(false);
    const loose = checkRateLimit([minutesAgo(3)], { windowMinutes: 1, maxPerDomain: 1 }, now);
    expect(loose.allowed).toBe(true);
  });

  it('accepts timestamps as strings (what postgres hands back)', () => {
    const decision = checkRateLimit(
      [minutesAgo(1).toISOString()],
      { windowMinutes: 60, maxPerDomain: 1 },
      now
    );
    expect(decision.allowed).toBe(false);
  });
});
