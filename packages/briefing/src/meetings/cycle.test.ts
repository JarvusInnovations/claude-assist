import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import type postgres from 'postgres';
import type { CalendarEvent } from '../types.js';
import type { CalendarReadResult } from '../calendar/gws-axi.js';
import { PlanProvider } from '../alerts/plan-provider.js';
import { MemoryOverrideStore } from '../alerts/overrides.js';
import { MemoryMeetingPrepStore } from './prep-store.js';
import type { MeetingPrep } from './types.js';
import type { MeetingPrepRenderer, PrepRenderResult } from './render.js';
import { runMeetingCycle, type MeetingCycleDeps } from './cycle.js';

const NOW = Date.parse('2026-07-15T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as unknown as FastifyBaseLogger;

interface EvOpts {
  id?: string;
  seriesId?: string;
  startMs?: number;
  endMs?: number;
  summary?: string;
}

/** A join-required event: has a video link, ≥2 attendees, accepted, benign summary. */
function ev(opts: EvOpts = {}): CalendarEvent {
  const start = opts.startMs ?? NOW;
  const end = opts.endMs ?? start + 30 * MIN;
  return {
    id: opts.id ?? 'abc_20260715',
    seriesId: opts.seriesId ?? 'abc',
    summary: opts.summary ?? 'Weekly sync',
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    allDay: false,
    startMs: start,
    myResponse: 'accepted',
    attendeeCount: 3,
    location: '',
    hangoutLink: 'https://meet.google.com/x',
    description: '',
    status: 'confirmed',
  };
}

/** Real PlanProvider driven by fixed window events (no model → deterministic classify). */
function planProviderReturning(events: CalendarEvent[]): PlanProvider {
  const fetcher = async (): Promise<CalendarReadResult> => ({ events, error: null });
  return new PlanProvider({
    overrides: new MemoryOverrideStore(),
    model: null,
    log,
    timeZone: 'UTC',
    fetcher,
  });
}

function recordingRenderer() {
  const calls: Array<{ key: string; replaceExisting: boolean }> = [];
  const renderer = {
    async render(prep: MeetingPrep, opts: { replaceExisting?: boolean } = {}): Promise<PrepRenderResult> {
      calls.push({ key: prep.occurrenceKey, replaceExisting: !!opts.replaceExisting });
      return { dayNodeId: 'day1', imported: true, replaced: !!opts.replaceExisting };
    },
  } as unknown as MeetingPrepRenderer;
  return { renderer, calls };
}

/** Fake postgres tag that resolves capture rows (or rejects to simulate an absent schema). */
function fakeSql(rows: unknown[] | Error): postgres.Sql {
  return (() => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows))) as unknown as postgres.Sql;
}

function baseDeps(over: Partial<MeetingCycleDeps>): MeetingCycleDeps {
  return {
    prepStore: new MemoryMeetingPrepStore(),
    planProvider: planProviderReturning([]),
    sql: fakeSql([]),
    composer: null,
    renderer: null,
    log,
    nowMs: NOW,
    fetcher: async () => ({ events: [], error: null }),
    ...over,
  };
}

describe('runMeetingCycle — trigger (a): seed N+1 when an occurrence just ended', () => {
  it('generates and delivers the next occurrence prep', async () => {
    const ended = ev({ id: 'abc_20260715', startMs: NOW - 35 * MIN, endMs: NOW - 5 * MIN });
    const next = ev({ id: 'abc_20260720', startMs: NOW + 5 * DAY, endMs: NOW + 5 * DAY + 30 * MIN });
    const prepStore = new MemoryMeetingPrepStore();
    const { renderer, calls } = recordingRenderer();

    const result = await runMeetingCycle(
      baseDeps({
        prepStore,
        renderer,
        planProvider: planProviderReturning([ended]), // window sees only the ended occurrence
        fetcher: async () => ({ events: [ended, next], error: null }), // forward + history reads
      })
    );

    const prep = await prepStore.get('abc_20260720');
    expect(prep).not.toBeNull();
    expect(prep!.status).toBe('delivered');
    expect(result.generated).toBe(1);
    expect(result.delivered).toBe(1);
    expect(calls).toEqual([{ key: 'abc_20260720', replaceExisting: false }]);
  });
});

describe('runMeetingCycle — trigger (b)+(c): refresh folds newly-routed captures', () => {
  it('recomposes with the capture and marks the prep refreshed', async () => {
    const upcoming = ev({ id: 'abc_20260716', startMs: NOW + 2 * HOUR, endMs: NOW + 2 * HOUR + 30 * MIN });
    const prepStore = new MemoryMeetingPrepStore([
      {
        occurrenceKey: 'abc_20260716',
        seriesKey: 'abc',
        occurrenceStart: upcoming.start,
        summary: 'Weekly sync',
        status: 'delivered', // already delivered earlier
        prepContent: '- old',
        inputsDigest: 'stale', // differs from what this pass computes
        model: 'deterministic',
        deliveredNodeId: 'day1',
        generatedAt: null,
        refreshedAt: null,
        deliveredAt: null,
      },
    ]);
    const { renderer, calls } = recordingRenderer();

    const result = await runMeetingCycle(
      baseDeps({
        prepStore,
        renderer,
        planProvider: planProviderReturning([upcoming]),
        sql: fakeSql([{ ulid: '01CAP', text: 'raise the budget question', captured_at: new Date(NOW - HOUR), tags: [] }]),
      })
    );

    const prep = await prepStore.get('abc_20260716');
    expect(prep!.status).toBe('refreshed');
    expect(prep!.prepContent).toContain('raise the budget question');
    expect(result.refreshed).toBe(1);
    expect(calls).toEqual([{ key: 'abc_20260716', replaceExisting: true }]);
  });
});

describe('runMeetingCycle — idempotency', () => {
  it('skips recompose + re-render when inputs are unchanged', async () => {
    const upcoming = ev({ id: 'abc_20260716', startMs: NOW + 2 * HOUR, endMs: NOW + 2 * HOUR + 30 * MIN });
    const prepStore = new MemoryMeetingPrepStore();
    const { renderer, calls } = recordingRenderer();
    const deps = baseDeps({ prepStore, renderer, planProvider: planProviderReturning([upcoming]) });

    const first = await runMeetingCycle({ ...deps, nowMs: NOW });
    const second = await runMeetingCycle({ ...deps, nowMs: NOW });

    expect(first.delivered).toBe(1);
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    expect(second.generated).toBe(0);
    expect(calls.length).toBe(1); // rendered exactly once across both passes
  });
});

describe('runMeetingCycle — graceful degradation', () => {
  it('composes deterministically and flags an absent capture source; skips render with no Tana', async () => {
    const upcoming = ev({ id: 'abc_20260716', startMs: NOW + 2 * HOUR, endMs: NOW + 2 * HOUR + 30 * MIN });
    const prepStore = new MemoryMeetingPrepStore();

    const result = await runMeetingCycle(
      baseDeps({
        prepStore,
        renderer: null, // no Tana configured
        composer: null, // no model → deterministic
        planProvider: planProviderReturning([upcoming]),
        sql: fakeSql(new Error('relation "capture.captures" does not exist')),
      })
    );

    const prep = await prepStore.get('abc_20260716');
    expect(prep!.status).toBe('draft'); // composed, not rendered
    expect(prep!.model).toBe('deterministic');
    expect(prep!.prepContent).toContain('Not available');
    expect(result.generated).toBe(1);
    expect(result.delivered).toBe(0);
  });
});
