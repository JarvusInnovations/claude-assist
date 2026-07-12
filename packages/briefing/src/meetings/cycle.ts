/**
 * The meeting-briefing virtuous cycle.
 *
 * One scheduled pass (`runMeetingCycle`) drives all three triggers over a
 * single classified calendar window, reusing the shared join-required
 * classifier for target selection (the same events that earn a join-alert earn
 * a prep — we do NOT re-decide "is this a real meeting"):
 *
 *   (a) occurrence just ENDED  → seed the prep for the series' NEXT occurrence.
 *   (b) occurrence is UPCOMING within the refresh window (~24h) → ensure/refresh
 *       its prep so it reflects the latest inputs.
 *   (c) captures routed to the series fold in at (a)/(b) via the captures source.
 *
 * Everything is idempotent via `inputs_digest`: a pass recomposes + re-renders
 * only when the inputs actually changed, so running every 30 min is cheap and
 * the 24h trigger vs. rolling-capture reconcile cleanly (the final prep always
 * reflects the newest agenda). `runMeetingCycle` takes injected deps so it's
 * testable without Postgres, Tana, a model, or gws-axi.
 */

import type { FastifyBaseLogger } from 'fastify';
import type postgres from 'postgres';
import type { CalendarEvent } from '../types.js';
import type { PlanProvider } from '../alerts/plan-provider.js';
import { fetchEvents, type CalendarReadResult, type FetchEventsOptions } from '../calendar/gws-axi.js';
import { occurrenceIdentity, occurrenceEndMs, nextOccurrence } from './occurrence.js';
import type { MeetingPrepStore } from './prep-store.js';
import type { PrepComposer } from './model.js';
import { deterministicPrep, inputsDigest, type PrepInputs } from './compose.js';
import { fetchMeetingContext } from './context-source.js';
import { fetchMeetingCaptures } from './captures-source.js';
import type { MeetingPrepRenderer } from './render.js';
import type { MeetingPrepStatus } from './types.js';

export type CalendarFetcher = (opts: FetchEventsOptions) => Promise<CalendarReadResult>;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** How far back to fetch so a recently-ended long meeting is still in the window. */
const PAST_FETCH_HOURS = 6;

export interface MeetingCycleDeps {
  prepStore: MeetingPrepStore;
  planProvider: PlanProvider;
  sql: postgres.Sql;
  composer: PrepComposer | null;
  renderer: MeetingPrepRenderer | null;
  log: FastifyBaseLogger;
  nowMs: number;

  /** Raw calendar reads for history + next-occurrence lookups (injectable for tests). */
  fetcher?: CalendarFetcher;
  gwsBin?: string;
  account?: string;

  /** Pluggable prior-occurrence context (transcripts/HQ timelines/Slack). */
  contextBin?: string;
  contextArgs?: string[];

  /** Refresh occurrences starting within this many hours (the ~24h-ahead trigger). Default 26. */
  refreshAheadHours?: number;
  /** Treat an occurrence ended within this many minutes as "just ended". Default 45. */
  endedLookbackMinutes?: number;
  /** How far forward to search for the next occurrence when seeding N+1. Default 21 days. */
  nextLookaheadDays?: number;
  /** Backward window for calendar history. Default 120 days. */
  historyDays?: number;
  /** Capture lookback when no prior occurrence is known. Default 60 days. */
  captureLookbackDays?: number;

  pageBaseUrl?: string | null;
}

export interface MeetingCycleResult {
  evaluated: number;
  joinRequired: number;
  generated: number;
  refreshed: number;
  delivered: number;
  skipped: number;
  calendarError: string | null;
}

export async function runMeetingCycle(deps: MeetingCycleDeps): Promise<MeetingCycleResult> {
  const nowMs = deps.nowMs;
  const refreshAheadHours = deps.refreshAheadHours ?? 26;
  const endedLookbackMs = (deps.endedLookbackMinutes ?? 45) * 60_000;

  const fromIso = new Date(nowMs - PAST_FETCH_HOURS * HOUR_MS).toISOString();
  const toIso = new Date(nowMs + refreshAheadHours * HOUR_MS).toISOString();
  const plan = await deps.planProvider.planForWindow(fromIso, toIso);
  const joinItems = plan.items.filter((i) => i.classification.joinRequired);

  const result: MeetingCycleResult = {
    evaluated: plan.items.length,
    joinRequired: joinItems.length,
    generated: 0,
    refreshed: 0,
    delivered: 0,
    skipped: 0,
    calendarError: plan.calendarError,
  };

  for (const item of joinItems) {
    const ev = item.event;
    const endMs = occurrenceEndMs(ev);
    const startMs = ev.startMs;

    // (a) Just ended → seed the next occurrence's prep.
    if (endMs != null && endMs <= nowMs && endMs >= nowMs - endedLookbackMs) {
      try {
        const outcome = await generateNextPrep(deps, ev);
        tally(result, outcome);
      } catch (err) {
        deps.log.error({ err, eventId: ev.id }, 'generateNextPrep failed');
      }
    }

    // (b) Upcoming within the refresh window → ensure / refresh.
    if (startMs != null && startMs > nowMs && startMs <= nowMs + refreshAheadHours * HOUR_MS) {
      try {
        const outcome = await buildAndStorePrep(deps, ev, { priorEvent: null });
        tally(result, outcome);
      } catch (err) {
        deps.log.error({ err, eventId: ev.id }, 'refresh prep failed');
      }
    }
  }

  return result;
}

type PrepOutcome = 'skipped' | 'delivered' | 'refreshed' | 'composed-not-rendered' | 'none';

function tally(result: MeetingCycleResult, outcome: PrepOutcome): void {
  if (outcome === 'skipped' || outcome === 'none') result.skipped++;
  else if (outcome === 'refreshed') {
    result.refreshed++;
    result.delivered++;
  } else if (outcome === 'delivered') {
    result.generated++;
    result.delivered++;
  } else if (outcome === 'composed-not-rendered') {
    result.generated++;
  }
}

/** Trigger (a): find the series' next occurrence after `endedEvent` and build its prep. */
export async function generateNextPrep(
  deps: MeetingCycleDeps,
  endedEvent: CalendarEvent
): Promise<PrepOutcome> {
  const seriesKey = endedEvent.seriesId;
  const afterMs = endedEvent.startMs;
  if (afterMs == null) return 'none';

  const lookaheadDays = deps.nextLookaheadDays ?? 21;
  const read = await rawFetch(deps, {
    fromIso: new Date(afterMs + 60_000).toISOString(),
    toIso: new Date(afterMs + lookaheadDays * DAY_MS).toISOString(),
  });
  const next = nextOccurrence(read.events, seriesKey, afterMs);
  if (!next) return 'none';

  return buildAndStorePrep(deps, next, { priorEvent: endedEvent });
}

interface BuildOpts {
  priorEvent: CalendarEvent | null;
}

/**
 * Assemble inputs for `targetEvent`, compose (or recompose) its prep when the
 * inputs changed, store it, and render into Tana. Idempotent per inputs digest.
 */
export async function buildAndStorePrep(
  deps: MeetingCycleDeps,
  targetEvent: CalendarEvent,
  opts: BuildOpts
): Promise<PrepOutcome> {
  const occ = occurrenceIdentity(targetEvent);
  const existing = await deps.prepStore.get(occ.occurrenceKey);
  const targetStartMs = occ.occurrenceStartMs;

  // Calendar history: prior occurrences of the series, oldest→newest.
  const historyDays = deps.historyDays ?? 120;
  let history: CalendarEvent[] = [];
  if (targetStartMs != null) {
    const read = await rawFetch(deps, {
      fromIso: new Date(targetStartMs - historyDays * DAY_MS).toISOString(),
      toIso: new Date(targetStartMs).toISOString(),
    });
    history = read.events
      .filter((e) => e.seriesId === occ.seriesKey && e.startMs != null && e.startMs < targetStartMs)
      .sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
  }

  const priorStartMs =
    opts.priorEvent?.startMs ?? (history.length > 0 ? history[history.length - 1]!.startMs : null);
  const captureLookbackMs = (deps.captureLookbackDays ?? 60) * DAY_MS;
  const sinceMs = priorStartMs ?? (targetStartMs != null ? targetStartMs - captureLookbackMs : null);

  const priorOccurrenceStart =
    opts.priorEvent?.start ?? (history.length > 0 ? history[history.length - 1]!.start : null);

  const [context, captures] = await Promise.all([
    fetchMeetingContext({
      bin: deps.contextBin,
      args: deps.contextArgs,
      request: {
        seriesKey: occ.seriesKey,
        occurrenceKey: occ.occurrenceKey,
        occurrenceStart: occ.occurrenceStart,
        summary: occ.summary,
        priorOccurrenceStart,
      },
    }),
    fetchMeetingCaptures(deps.sql, { seriesKey: occ.seriesKey, sinceMs }),
  ]);

  const inputs: PrepInputs = {
    occurrence: occ,
    targetEvent,
    history,
    priorContext: context.context,
    captures: captures.captures,
    contextError: context.error,
    capturesError: captures.error,
  };

  const digest = inputsDigest(inputs);

  // Already composed AND rendered with these exact inputs → nothing to do.
  if (existing && existing.inputsDigest === digest && existing.status !== 'draft') {
    return 'skipped';
  }

  const content = deps.composer ? await deps.composer.compose(inputs) : deterministicPrep(inputs);
  const model = deps.composer?.modelId ?? 'deterministic';
  const alreadyDelivered = !!existing && existing.status !== 'draft';

  await deps.prepStore.upsert({
    occurrenceKey: occ.occurrenceKey,
    seriesKey: occ.seriesKey,
    occurrenceStart: occ.occurrenceStart,
    summary: occ.summary,
    status: 'draft',
    prepContent: content,
    inputsDigest: digest,
    model,
  });

  if (!deps.renderer) {
    deps.log.warn({ occurrence: occ.occurrenceKey }, 'Tana not configured — prep composed but not rendered');
    return 'composed-not-rendered';
  }

  const nextStatus: MeetingPrepStatus = alreadyDelivered ? 'refreshed' : 'delivered';
  const stored = await deps.prepStore.get(occ.occurrenceKey);
  const render = await deps.renderer.render(stored!, {
    replaceExisting: alreadyDelivered,
    pageBaseUrl: deps.pageBaseUrl,
  });

  if (render.imported) {
    await deps.prepStore.markDelivered(occ.occurrenceKey, render.dayNodeId, nextStatus);
    return nextStatus;
  }
  // Render skipped (block present, not a refresh, or trash failed): leave as draft.
  return 'composed-not-rendered';
}

function rawFetch(deps: MeetingCycleDeps, opts: { fromIso: string; toIso: string }): Promise<CalendarReadResult> {
  const fetcher = deps.fetcher ?? fetchEvents;
  return fetcher({ fromIso: opts.fromIso, toIso: opts.toIso, bin: deps.gwsBin, account: deps.account });
}
