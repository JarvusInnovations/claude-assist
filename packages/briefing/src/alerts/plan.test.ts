import { describe, expect, it } from 'bun:test';
import type { CalendarEvent, JoinClassification, SeriesOverride, VenueKind } from '../types.js';
import type { JoinRequiredModel } from '../classifier/llm.js';
import { alertingItems, computeFireAtMs, resolveAlertPlan } from './plan.js';

function mkEvent(over: Partial<CalendarEvent> = {}): CalendarEvent {
  const startMs = Date.parse('2026-07-10T15:00:00-04:00');
  return {
    id: 'evt_20260710T190000Z',
    seriesId: 'evt',
    summary: 'Project sync',
    start: '2026-07-10T15:00:00-04:00',
    end: '2026-07-10T15:30:00-04:00',
    allDay: false,
    startMs,
    myResponse: 'accepted',
    attendeeCount: 3,
    location: '',
    joinUrl: '',
    hangoutLink: 'https://meet.google.com/abc',
    description: '',
    status: 'confirmed',
    ...over,
  };
}

/** A fake model returning a fixed verdict for the ambiguous residue. */
function fakeModel(verdict: boolean): JoinRequiredModel {
  return {
    async classify(_event: CalendarEvent, venue: VenueKind): Promise<JoinClassification> {
      return {
        joinRequired: verdict,
        reason: `model:${verdict ? 'join' : 'noise'}`,
        venue,
        source: 'model',
        confidence: 0.8,
      };
    },
  } as unknown as JoinRequiredModel;
}

describe('computeFireAtMs', () => {
  it('subtracts the lead time', () => {
    expect(computeFireAtMs(1_000_000, 3)).toBe(1_000_000 - 3 * 60_000);
  });
  it('is null without a start', () => {
    expect(computeFireAtMs(null, 3)).toBeNull();
  });
});

describe('resolveAlertPlan', () => {
  it('fires a clean video meeting with a 1-min lead', async () => {
    const plan = await resolveAlertPlan({ events: [mkEvent()], overrides: new Map() });
    expect(plan[0]!.classification.joinRequired).toBe(true);
    expect(plan[0]!.leadMinutes).toBe(1);
    expect(plan[0]!.fireAtMs).toBe(mkEvent().startMs! - 1 * 60_000);
  });

  it('resolves ambiguous events via the model when present', async () => {
    // Not-yet-accepted so soft-ambiguity routes to the model (an accept fires).
    const events = [mkEvent({ summary: 'Team sync (optional)', myResponse: 'needsAction' })];
    const joined = await resolveAlertPlan({ events, overrides: new Map(), model: fakeModel(true) });
    expect(joined[0]!.classification.source).toBe('model');
    expect(joined[0]!.classification.joinRequired).toBe(true);

    const withoutModel = await resolveAlertPlan({ events, overrides: new Map() });
    expect(withoutModel[0]!.classification.joinRequired).toBe(false);
  });

  it('honors a suppress override across the plan', async () => {
    const overrides = new Map<string, SeriesOverride>([
      ['evt', { seriesId: 'evt', action: 'suppress', leadMinutes: null, note: null }],
    ]);
    const plan = await resolveAlertPlan({ events: [mkEvent()], overrides });
    expect(plan[0]!.classification.joinRequired).toBe(false);
    expect(plan[0]!.fireAtMs).toBeNull();
  });

  it('applies an override custom lead time', async () => {
    const overrides = new Map<string, SeriesOverride>([
      ['evt', { seriesId: 'evt', action: 'force', leadMinutes: 20, note: null }],
    ]);
    const plan = await resolveAlertPlan({ events: [mkEvent({ hangoutLink: '', location: '' })], overrides });
    expect(plan[0]!.leadMinutes).toBe(20);
  });
});

describe('alertingItems', () => {
  it('keeps only join-required schedulable items, in fire order', async () => {
    const early = mkEvent({ id: 'e1', seriesId: 'e1', startMs: 2_000_000, start: '2026-07-10T10:00:00-04:00' });
    const late = mkEvent({ id: 'e2', seriesId: 'e2', startMs: 5_000_000, start: '2026-07-10T12:00:00-04:00' });
    // A solo PHYSICAL block still doesn't fire (the attendee heuristic applies
    // to physical venues); a solo *video* call would now fire.
    const noise = mkEvent({ id: 'e3', seriesId: 'e3', attendeeCount: 1, hangoutLink: '', location: '100 Main St' });
    const plan = await resolveAlertPlan({ events: [late, early, noise], overrides: new Map() });
    const alerting = alertingItems(plan);
    expect(alerting.map((i) => i.event.id)).toEqual(['e1', 'e2']);
  });
});
