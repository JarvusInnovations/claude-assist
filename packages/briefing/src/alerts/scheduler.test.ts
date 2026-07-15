import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import type { NotifyDispatcher, NotifyInput, NotifyResult } from '@jarvus/claude-assist-core';
import type { AlertPlanItem, CalendarEvent } from '../types.js';
import type { MeetingPrep } from '../meetings/types.js';
import { MemoryMeetingPrepStore } from '../meetings/prep-store.js';
import { FIRE_GRACE_MS, alertUrl, buildAlertPayload, isDue, prepNodeLink, runAlertCycle } from './scheduler.js';
import { MemoryDispatchLedger } from './dispatch-ledger.js';

const NOW = Date.parse('2026-07-10T14:59:30-04:00'); // 30s before a 15:00 start (inside the 1-min video lead)
const START = Date.parse('2026-07-10T15:00:00-04:00');

function mkEvent(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt_20260710T190000Z',
    seriesId: 'evt',
    summary: 'Project sync',
    start: '2026-07-10T15:00:00-04:00',
    end: '2026-07-10T15:30:00-04:00',
    allDay: false,
    startMs: START,
    myResponse: 'accepted',
    attendeeCount: 3,
    location: '',
    hangoutLink: 'https://meet.google.com/abc',
    description: '',
    status: 'confirmed',
    ...over,
  };
}

function mkItem(over: Partial<CalendarEvent> = {}, fireAtMs = START - 60_000): AlertPlanItem {
  const event = mkEvent(over);
  return {
    event,
    classification: { joinRequired: true, reason: 'conferencing+attendees', venue: 'video', source: 'deterministic' },
    leadMinutes: 1,
    fireAtMs,
  };
}

function mkPrep(over: Partial<MeetingPrep> = {}): MeetingPrep {
  return {
    occurrenceKey: 'evt_20260710T190000Z',
    seriesKey: 'evt',
    occurrenceStart: '2026-07-10T15:00:00-04:00',
    summary: 'Project sync',
    status: 'delivered',
    prepContent: '- agenda point',
    inputsDigest: 'digest',
    model: 'deterministic',
    deliveredNodeId: 'prepNode123',
    generatedAt: '2026-07-10T08:00:00-04:00',
    refreshedAt: null,
    deliveredAt: '2026-07-10T08:00:00-04:00',
    ...over,
  };
}

/** Recording fake dispatcher. */
function fakeNotify(): { dispatcher: NotifyDispatcher; sent: NotifyInput[] } {
  const sent: NotifyInput[] = [];
  let id = 0;
  const dispatcher: NotifyDispatcher = {
    async notify(input: NotifyInput): Promise<NotifyResult> {
      sent.push(input);
      return { id: ++id, priority: input.priority, deliveredVia: ['pushover'], status: 'sent' };
    },
  };
  return { dispatcher, sent };
}

const log = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;

describe('isDue', () => {
  it('is due once fire-at passes and before start', () => {
    expect(isDue(mkItem(), NOW)).toBe(true); // fireAt=14:59, now=14:59:30, start=15:00
  });
  it('is not due before fire-at', () => {
    expect(isDue(mkItem({}, START - 10 * 60_000), Date.parse('2026-07-10T14:49:00-04:00'))).toBe(false);
  });
  it('is not due once the meeting has started', () => {
    expect(isDue(mkItem(), START + 60_000)).toBe(false);
  });
  it('is not due once past the grace window', () => {
    const fireAt = START - 3 * 60_000;
    expect(isDue(mkItem({}, fireAt), fireAt + FIRE_GRACE_MS + 1)).toBe(false);
  });
});

describe('runAlertCycle dedup', () => {
  it('fires exactly one interrupt for a due join-required meeting', async () => {
    const ledger = new MemoryDispatchLedger();
    const { dispatcher, sent } = fakeNotify();
    const result = await runAlertCycle({
      events: [mkEvent()],
      overrides: new Map(),
      ledger,
      notify: dispatcher,
      log,
      nowMs: NOW,
    });
    expect(result.fired).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.priority).toBe('interrupt');
    expect(sent[0]!.title).toContain('Project sync');
  });

  it('does not double-fire on a second cycle (restart-safe)', async () => {
    const ledger = new MemoryDispatchLedger();
    const { dispatcher, sent } = fakeNotify();
    const args = {
      events: [mkEvent()],
      overrides: new Map(),
      ledger,
      notify: dispatcher,
      log,
      nowMs: NOW,
    };
    await runAlertCycle(args);
    const second = await runAlertCycle(args);
    expect(second.fired).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('treats a pre-claimed occurrence (restart) as already fired', async () => {
    const ledger = new MemoryDispatchLedger(['evt_20260710T190000Z']);
    const { dispatcher, sent } = fakeNotify();
    const result = await runAlertCycle({
      events: [mkEvent()],
      overrides: new Map(),
      ledger,
      notify: dispatcher,
      log,
      nowMs: NOW,
    });
    expect(result.fired).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('fires nothing for calendar noise', async () => {
    const ledger = new MemoryDispatchLedger();
    const { dispatcher, sent } = fakeNotify();
    const result = await runAlertCycle({
      events: [mkEvent({ summary: 'Focus time', attendeeCount: 1 })],
      overrides: new Map(),
      ledger,
      notify: dispatcher,
      log,
      nowMs: NOW,
    });
    expect(result.fired).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('carries the conferencing link as a "Join" action on the dispatch', async () => {
    const ledger = new MemoryDispatchLedger();
    const { dispatcher, sent } = fakeNotify();
    await runAlertCycle({
      events: [mkEvent()], // hangoutLink: https://meet.google.com/abc
      overrides: new Map(),
      ledger,
      notify: dispatcher,
      log,
      nowMs: NOW,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://meet.google.com/abc');
    expect(sent[0]!.urlTitle).toBe('Join');
  });

  it('carries a maps link as a "Map" action for a physical meeting with no conferencing link', async () => {
    const ledger = new MemoryDispatchLedger();
    const { dispatcher, sent } = fakeNotify();
    // Physical venue defaults to a 15-min lead, so fire-at is START-15min here.
    const physicalNow = START - 14 * 60_000;
    await runAlertCycle({
      events: [mkEvent({ hangoutLink: '', location: '1234 Market St, 5th Floor' })],
      overrides: new Map(),
      ledger,
      notify: dispatcher,
      log,
      nowMs: physicalNow,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://maps.google.com/?q=1234%20Market%20St%2C%205th%20Floor');
    expect(sent[0]!.urlTitle).toBe('Map');
  });
});

describe('alertUrl', () => {
  it('prefers the conferencing link and labels it "Join"', () => {
    expect(alertUrl(mkItem())).toEqual({
      url: 'https://meet.google.com/abc',
      urlTitle: 'Join',
    });
  });

  it('falls back to a maps link for a physical venue with no conferencing link', () => {
    const item = mkItem({ hangoutLink: '', location: '1234 Market St, 5th Floor' });
    item.classification = { ...item.classification, venue: 'physical' };
    expect(alertUrl(item)).toEqual({
      url: 'https://maps.google.com/?q=1234%20Market%20St%2C%205th%20Floor',
      urlTitle: 'Map',
    });
  });

  it('returns no url for a physical venue with no location text', () => {
    const item = mkItem({ hangoutLink: '', location: '' });
    item.classification = { ...item.classification, venue: 'physical' };
    expect(alertUrl(item)).toEqual({});
  });

  it('returns no url when there is no venue at all', () => {
    const item = mkItem({ hangoutLink: '', location: '' });
    item.classification = { ...item.classification, venue: 'none' };
    expect(alertUrl(item)).toEqual({});
  });
});

describe('buildAlertPayload prep links', () => {
  it('with no action link, a delivered prep takes the URL slot (labeled "Prep")', () => {
    // The name-only conferencing shape: video venue but no extractable join link.
    const item = mkItem({ hangoutLink: '', location: 'Microsoft Teams Meeting' });
    const payload = buildAlertPayload(item, mkPrep());
    expect(payload.url).toBe(prepNodeLink('prepNode123'));
    expect(payload.urlTitle).toBe('Prep');
    expect(payload.body).not.toContain('Prep:');
  });

  it('a join link keeps the URL slot; the prep link rides in the body', () => {
    const payload = buildAlertPayload(mkItem(), mkPrep());
    expect(payload.url).toBe('https://meet.google.com/abc');
    expect(payload.urlTitle).toBe('Join');
    expect(payload.body).toContain(`Prep: ${prepNodeLink('prepNode123')}`);
  });

  it('no prep → payload unchanged', () => {
    const payload = buildAlertPayload(mkItem(), null);
    expect(payload.url).toBe('https://meet.google.com/abc');
    expect(payload.body).not.toContain('Prep');
  });

  it('a prep never rendered to Tana (no node id) → payload unchanged', () => {
    const payload = buildAlertPayload(mkItem(), mkPrep({ deliveredNodeId: null, status: 'draft' }));
    expect(payload.url).toBe('https://meet.google.com/abc');
    expect(payload.body).not.toContain('Prep');
  });
});

describe('runAlertCycle prep links', () => {
  it('attaches the delivered prep node to the dispatch (join link still wins the URL slot)', async () => {
    const ledger = new MemoryDispatchLedger();
    const { dispatcher, sent } = fakeNotify();
    const prepStore = new MemoryMeetingPrepStore([mkPrep()]); // keyed by the event's instance id
    await runAlertCycle({
      events: [mkEvent()],
      overrides: new Map(),
      ledger,
      notify: dispatcher,
      log,
      nowMs: NOW,
      prepStore,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://meet.google.com/abc');
    expect(sent[0]!.urlTitle).toBe('Join');
    expect(sent[0]!.body).toContain(prepNodeLink('prepNode123'));
  });

  it('puts the prep link in the URL slot when the alert has no action link', async () => {
    const ledger = new MemoryDispatchLedger();
    const { dispatcher, sent } = fakeNotify();
    const prepStore = new MemoryMeetingPrepStore([mkPrep()]);
    await runAlertCycle({
      events: [mkEvent({ hangoutLink: '', location: 'Microsoft Teams Meeting' })],
      overrides: new Map(),
      ledger,
      notify: dispatcher,
      log,
      nowMs: NOW,
      prepStore,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(prepNodeLink('prepNode123'));
    expect(sent[0]!.urlTitle).toBe('Prep');
  });

  it('fires unchanged when the store has no prep for the occurrence', async () => {
    const ledger = new MemoryDispatchLedger();
    const { dispatcher, sent } = fakeNotify();
    const prepStore = new MemoryMeetingPrepStore(); // empty
    await runAlertCycle({
      events: [mkEvent()],
      overrides: new Map(),
      ledger,
      notify: dispatcher,
      log,
      nowMs: NOW,
      prepStore,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://meet.google.com/abc');
    expect(sent[0]!.body).not.toContain('Prep');
  });

  it('fires unchanged when the prep lookup throws (fail-soft)', async () => {
    const ledger = new MemoryDispatchLedger();
    const { dispatcher, sent } = fakeNotify();
    const prepStore = {
      async get(): Promise<MeetingPrep | null> {
        throw new Error('db down');
      },
    } as unknown as MemoryMeetingPrepStore;
    await runAlertCycle({
      events: [mkEvent()],
      overrides: new Map(),
      ledger,
      notify: dispatcher,
      log,
      nowMs: NOW,
      prepStore,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://meet.google.com/abc');
    expect(sent[0]!.body).not.toContain('Prep');
  });
});
