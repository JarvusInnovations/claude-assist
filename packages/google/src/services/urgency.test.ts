import { describe, expect, it } from 'bun:test';
import {
  classifyEmailDeterministic,
  senderStanding,
  isKnownSender,
  isAutomatedSender,
  isDirectedToOwner,
  hasTimeSensitivitySignal,
  hasEmergencySignal,
  isQuietHour,
  isQuietHours,
  type UrgencyInput,
} from './urgency.js';

const OWNER = new Set(['owner@own.test']);
const WHITELIST = new Set(['nate@client.org', 'friend@example.net']);
const CONTACTS = new Set(['ap@client.org']);
const TEAM = ['team.test'];

function input(overrides: Partial<UrgencyInput> = {}): UrgencyInput {
  return {
    ownerAddresses: OWNER,
    senderAddress: 'nate@client.org',
    senderType: 'human',
    subject: 'Contract question',
    bodyText: 'Wanted to share an update on the project.',
    snippet: null,
    toAddresses: ['owner@own.test'],
    ccAddresses: [],
    actionItems: [],
    whitelist: WHITELIST,
    clientContacts: CONTACTS,
    teamDomains: TEAM,
    ...overrides,
  };
}

describe('classifyEmailDeterministic — the two-tier bar', () => {
  it('INTERRUPTs a known human, directed (To), with a deadline phrase — no model', () => {
    const r = classifyEmailDeterministic(
      input({ bodyText: 'I need the SOW by end of day, we are blocked on it.' })
    );
    expect(r.tier).toBe('interrupt');
    expect(r.needsModel).toBe(false);
  });

  it('hands a directed known human with NO keyword to the model (residue)', () => {
    const r = classifyEmailDeterministic(
      input({ bodyText: 'Can you take a look at the draft when you can?' })
    );
    expect(r.tier).toBe('neither');
    expect(r.needsModel).toBe(true);
  });

  it('self-sent mail is never a tier', () => {
    const r = classifyEmailDeterministic(input({ senderAddress: 'owner@own.test' }));
    expect(r.tier).toBe('neither');
    expect(r.needsModel).toBe(false);
    expect(r.reason).toContain('self');
  });

  it('automated mail never earns a tier even from a team domain with a deadline', () => {
    const r = classifyEmailDeterministic(
      input({
        senderAddress: 'noreply@team.test',
        senderType: 'automated',
        bodyText: 'Your report is due by tomorrow.',
      })
    );
    expect(r.tier).toBe('neither');
    expect(r.automated).toBe(true);
  });

  it('overrides sender_type=human when the local-part looks automated (Chewy class)', () => {
    const r = classifyEmailDeterministic(
      input({ senderAddress: 'notifications@shop.test', senderType: 'human', whitelist: new Set() })
    );
    expect(r.automated).toBe(true);
    expect(r.tier).toBe('neither');
  });

  it('a stranger (no standing) never reaches a tier even with urgent phrasing', () => {
    const r = classifyEmailDeterministic(
      input({
        senderAddress: 'stranger@nowhere.test',
        whitelist: new Set(),
        clientContacts: new Set(),
        bodyText: 'URGENT: respond by end of day!',
      })
    );
    expect(r.tier).toBe('neither');
    expect(r.needsModel).toBe(false);
    expect(r.reason).toContain('no standing');
  });

  it('a team-domain sender never bypasses the directed gate (CC-only FYI → calm, no model)', () => {
    const r = classifyEmailDeterministic(
      input({
        senderAddress: 'teammate@team.test',
        toAddresses: ['external@somewhere.test'],
        ccAddresses: ['owner@own.test'],
        bodyText: 'FYI, sent the deck to the client.',
      })
    );
    expect(r.tier).toBe('neither');
    expect(r.needsModel).toBe(false);
    expect(r.directedTo).toBe(false);
  });

  it('a client contact goes to the model to judge substantiveness (CC-only, no keyword)', () => {
    const r = classifyEmailDeterministic(
      input({
        senderAddress: 'ap@client.org',
        toAddresses: ['external@somewhere.test'],
        ccAddresses: ['owner@own.test'],
        bodyText: 'Circulating the payment schedule for the quarter.',
      })
    );
    expect(r.standing).toBe('client-contact');
    expect(r.needsModel).toBe(true);
  });

  it('promotes an external reply on a thread the owner is on to ATTENTION', () => {
    const r = classifyEmailDeterministic(
      input({
        senderAddress: 'vendor@stranger.test',
        whitelist: new Set(),
        clientContacts: new Set(),
        toAddresses: ['teammate@team.test'],
        ccAddresses: ['owner@own.test'],
        threadHasOwnerParticipation: true,
      })
    );
    expect(r.tier).toBe('attention');
    expect(r.reason).toContain('thread');
  });
});

describe('senderStanding', () => {
  it('client contact beats team-domain and whitelist', () => {
    expect(senderStanding('ap@client.org', WHITELIST, CONTACTS, TEAM)).toBe('client-contact');
  });
  it('whitelist match', () => {
    expect(senderStanding('nate@client.org', WHITELIST, CONTACTS, TEAM)).toBe('whitelist');
  });
  it('team-domain match but not a lookalike', () => {
    expect(senderStanding('x@team.test', WHITELIST, CONTACTS, TEAM)).toBe('team-domain');
    expect(senderStanding('x@not-team.test', WHITELIST, CONTACTS, TEAM)).toBe('none');
  });
  it('isKnownSender back-compat wraps standing', () => {
    expect(isKnownSender('nate@client.org', WHITELIST, TEAM)).toBe(true);
    expect(isKnownSender('x@nowhere.test', WHITELIST, TEAM)).toBe(false);
  });
});

describe('isAutomatedSender', () => {
  it('list-unsubscribe presence marks automated regardless of sender_type', () => {
    expect(isAutomatedSender({ senderAddress: 'ceo@corp.test', senderType: 'human', listUnsubscribe: true })).toBe(true);
  });
  it('CATEGORY_PROMOTIONS label marks automated', () => {
    expect(
      isAutomatedSender({ senderAddress: 'x@corp.test', senderType: 'human', gmailLabels: ['CATEGORY_PROMOTIONS'] })
    ).toBe(true);
  });
  it('a plain human sender is not automated', () => {
    expect(isAutomatedSender({ senderAddress: 'nate@client.org', senderType: 'human' })).toBe(false);
  });
});

describe('isDirectedToOwner', () => {
  it('true when an owner address is in To', () => {
    expect(isDirectedToOwner(['Owner@Own.test', 'x@y.test'], OWNER)).toBe(true);
  });
  it('false when owner is only in CC (caller passes cc separately)', () => {
    expect(isDirectedToOwner(['x@y.test'], OWNER)).toBe(false);
  });
});

describe('phrase detectors', () => {
  it('time-sensitivity phrases, case-insensitive; ignores generic CTAs', () => {
    expect(hasTimeSensitivitySignal('Re: ASAP please', null, null)).toBe(true);
    expect(hasTimeSensitivitySignal('Check this out', 'let me know what you think', null)).toBe(false);
  });
  it('emergency phrases pierce quiet hours', () => {
    expect(hasEmergencySignal(null, 'production down, need you now', null)).toBe(true);
    expect(hasEmergencySignal('lunch?', 'no rush', null)).toBe(false);
  });
});

describe('quiet hours', () => {
  it('wrapping window 22→7 is quiet at 23 and 6, awake at 12', () => {
    expect(isQuietHour(23, 22, 7)).toBe(true);
    expect(isQuietHour(6, 22, 7)).toBe(true);
    expect(isQuietHour(12, 22, 7)).toBe(false);
  });
  it('boundary is half-open: start is quiet, end is not', () => {
    expect(isQuietHour(22, 22, 7)).toBe(true);
    expect(isQuietHour(7, 22, 7)).toBe(false);
  });
  it('isQuietHours resolves the owner TZ hour', () => {
    // 03:30 UTC = 22:30 previous day in America/New_York (EDT, -05/-04) → quiet.
    const at = new Date('2026-07-11T03:30:00Z');
    expect(isQuietHours(at, { timeZone: 'America/New_York', startHour: 22, endHour: 7 })).toBe(true);
  });
});
