/**
 * Activity history → `ActivitySummary`.
 *
 * The records arrive through the generic `ActivityHistoryProvider` seam in core
 * (the server composes it from whichever module owns the provider credentials
 * and token custody). This module never holds an activity-provider refresh
 * token of its own: a second independent rotator for the same OAuth app would
 * invalidate the first one's stored token on every refresh.
 *
 * Everything below is pure over the record list, so the rollup is testable
 * without a network or a database.
 */

import type { ActivityHistoryProvider, ActivityHistoryRecord } from '@jarvus/claude-assist-core';
import type { ActivitySummary } from '../types.js';
import { daysBetween, weekStartOf } from '../week.js';

const METERS_PER_MILE = 1609.344;

/** Sport strings that count as running for the volume math. */
const RUN_SPORTS = new Set(['run', 'trailrun', 'virtualrun', 'treadmillrun']);

export function normalizeSport(sport: string): string {
  return sport.toLowerCase().replace(/[^a-z]/g, '');
}

export function isRun(sport: string): boolean {
  return RUN_SPORTS.has(normalizeSport(sport));
}

export interface ActivityFetchOptions {
  /** Trailing window in days (default 42 — six weeks of context). */
  windowDays?: number;
  /** "Now" for the recency math; the plan-week Monday in practice. */
  asOfIso: string;
}

/**
 * Fetch + roll up. Never throws: an absent or failing provider degrades to an
 * empty summary carrying the reason, and the synthesis is told the history is
 * unavailable rather than being handed silence it would read as "did nothing".
 */
export async function fetchActivitySummary(
  provider: ActivityHistoryProvider | undefined,
  opts: ActivityFetchOptions
): Promise<ActivitySummary> {
  const windowDays = opts.windowDays ?? 42;
  if (!provider) {
    return { ...emptySummary(windowDays), error: 'activity history provider not configured' };
  }
  try {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const records = await provider(since);
    return summarizeActivities(records, { windowDays, asOfIso: opts.asOfIso });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...emptySummary(windowDays), error: `activity history unavailable: ${message}` };
  }
}

function emptySummary(windowDays: number): ActivitySummary {
  return {
    windowDays,
    totalCount: 0,
    bySport: [],
    weekly: [],
    longestRunMiles: 0,
    daysSinceLastRun: null,
    error: null,
  };
}

/** Pure rollup — exported for tests. */
export function summarizeActivities(
  records: ActivityHistoryRecord[],
  opts: { windowDays: number; asOfIso: string }
): ActivitySummary {
  const summary = emptySummary(opts.windowDays);
  summary.totalCount = records.length;

  const bySport = new Map<string, { count: number; meters: number; seconds: number }>();
  const weekly = new Map<
    string,
    { runMiles: number; runCount: number; crossCount: number; crossMinutes: number }
  >();
  let lastRunDate: string | null = null;

  for (const rec of records) {
    const dateIso = rec.startedAt.slice(0, 10);
    const sport = normalizeSport(rec.sport) || 'unknown';
    const meters = rec.distanceMeters ?? 0;
    const seconds = rec.movingSeconds ?? 0;

    const sportAgg = bySport.get(sport) ?? { count: 0, meters: 0, seconds: 0 };
    sportAgg.count += 1;
    sportAgg.meters += meters;
    sportAgg.seconds += seconds;
    bySport.set(sport, sportAgg);

    const wk = weekStartOf(dateIso);
    const weekAgg = weekly.get(wk) ?? { runMiles: 0, runCount: 0, crossCount: 0, crossMinutes: 0 };
    if (isRun(sport)) {
      const miles = meters / METERS_PER_MILE;
      weekAgg.runMiles += miles;
      weekAgg.runCount += 1;
      if (miles > summary.longestRunMiles) summary.longestRunMiles = miles;
      if (lastRunDate === null || dateIso > lastRunDate) lastRunDate = dateIso;
    } else {
      weekAgg.crossCount += 1;
      weekAgg.crossMinutes += seconds / 60;
    }
    weekly.set(wk, weekAgg);
  }

  summary.bySport = [...bySport.entries()]
    .map(([sport, agg]) => ({
      sport,
      count: agg.count,
      distanceMiles: round1(agg.meters / METERS_PER_MILE),
      movingMinutes: Math.round(agg.seconds / 60),
    }))
    .sort((a, b) => b.count - a.count);

  summary.weekly = [...weekly.entries()]
    .map(([weekStart, agg]) => ({
      weekStart,
      runMiles: round1(agg.runMiles),
      runCount: agg.runCount,
      crossCount: agg.crossCount,
      crossMinutes: Math.round(agg.crossMinutes),
    }))
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));

  summary.longestRunMiles = round1(summary.longestRunMiles);
  summary.daysSinceLastRun = lastRunDate === null ? null : daysBetween(lastRunDate, opts.asOfIso);
  return summary;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
