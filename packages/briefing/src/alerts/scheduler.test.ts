import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import type { NotifyDispatcher, NotifyInput, NotifyResult } from '@jarvus/claude-assist-core';
import type { AlertPlanItem, CalendarEvent } from '../types.js';
import { FIRE_GRACE_MS, isDue, runAlertCycle } from './scheduler.js';
import { MemoryDispatchLedger } from './dispatch-ledger.js';

const NOW = Date.parse('2026-07-10T14:58:00-04:00'); // 2 min before a 15:00 start
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

function mkItem(over: Partial<CalendarEvent> = {}, fireAtMs = START - 3 * 60_000): AlertPlanItem {
  const event = mkEvent(over);
  return {
    event,
    classification: { joinRequired: true, reason: 'conferencing+attendees', venue: 'video', source: 'deterministic' },
    leadMinutes: 3,
    fireAtMs,
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
    expect(isDue(mkItem(), NOW)).toBe(true); // fireAt=14:57, now=14:58, start=15:00
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
});
