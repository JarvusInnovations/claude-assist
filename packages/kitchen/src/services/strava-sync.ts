/**
 * Strava activity sync (specs/modules/kitchen.md § Strava activity sync).
 *
 * The scheduled server-side pull: a transcriber with a clock. Each tick
 * lists the trailing 7 days, filters to activities whose seeded ulid
 * (`ulidFromSeed(0, "strava:<activity_id>")` — the locked convention) is not
 * already stored, and only for those fetches the detail (calories exist only
 * there) and inserts an expenditure row. Idempotency IS the watermark: no
 * cursor, a tick that dies mid-batch costs nothing.
 *
 * Cross-source rule: the sync only ever inserts its own seeded rows. An
 * overlap with an existing non-strava (manual/garmin) row is surfaced as a
 * warning log for owner judgment — never deleted, merged, or edited.
 *
 * Skip visibility: an activity with no calorie value is never inserted (a
 * burn is a stated number, never a written 0) — and never will be, since a
 * calorie-less activity re-evaluates to the same answer on every future
 * tick too. `getSkipped()` exposes the current tick's skip list (rebuilt
 * fresh each run, no separate storage) so a caller can tell "this will
 * never arrive" apart from "hasn't synced yet" without reading server logs.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { ExpenditureRecord, ExpenditureStore } from '../store.js';
import { ulidFromSeed } from '../ulid.js';
import { StravaRefreshError, type StravaClient } from './strava-client.js';

/** The trailing list window — wide enough that no activity slips between ticks. */
const WINDOW_DAYS = 7;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Thrown at boot for a malformed KITCHEN_STRAVA_SYNC_MINUTES value. */
export class StravaSyncConfigError extends Error {
  constructor(message: string) {
    super(`KITCHEN_STRAVA_SYNC_MINUTES: ${message}`);
    this.name = 'StravaSyncConfigError';
  }
}

/**
 * All three credentials present ⇒ the sync runs; any absent ⇒ the feature is
 * entirely off — never partial, never guessed (§ Strava activity sync config).
 */
export function isStravaSyncConfigured(config: {
  stravaClientId?: string;
  stravaClientSecret?: string;
  stravaRefreshToken?: string;
}): boolean {
  return Boolean(config.stravaClientId && config.stravaClientSecret && config.stravaRefreshToken);
}

/**
 * Parse raw KITCHEN_STRAVA_SYNC_MINUTES. Absent/blank ⇒ the default 30.
 * Anything that is not a positive integer throws — boot-loud, same doctrine
 * as KITCHEN_DAILY_TARGETS (a silently-misread cadence is worse than none).
 */
export function parseStravaSyncMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 30;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
    throw new StravaSyncConfigError(`"${raw}" is not a positive integer (minutes)`);
  }
  return Number(trimmed);
}

/**
 * Render the cadence as a cron expression for the module scheduler.
 * Sub-hourly cadences map to a minute step; whole-hour cadences to an hour
 * step. Anything unrepresentable in cron throws boot-loud rather than
 * silently firing at some other cadence.
 */
export function stravaSyncCron(minutes: number): string {
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes % 60 === 0 && minutes / 60 <= 24) return `0 */${minutes / 60} * * *`;
  throw new StravaSyncConfigError(
    `${minutes} is not schedulable as cron — use 1–59 minutes or a whole number of hours (60, 120, … 1440)`
  );
}

export interface StravaSyncTickResult {
  listed: number;
  inserted: number;
  skipped_no_calories: number;
  /** True when a token-refresh failure skipped the whole tick. */
  refresh_failed: boolean;
}

/**
 * A Strava activity the sync saw and will never import (§ Strava activity
 * sync — skip visibility). Not a stored row — there is nothing to store, the
 * whole point is that the ledger has no row for it — so this is a plain
 * value, not an `ExpenditureRecord`.
 */
export interface StravaSkippedActivity {
  activity_id: number;
  label: string;
  /** The activity's own start instant, when Strava reported one. */
  occurred_at: Date | null;
}

export class StravaSync {
  /**
   * The most recent tick's skip list — rebuilt from scratch every successful
   * run (never accumulated), so it always reflects exactly what the current
   * trailing-7-day window contains. An activity ages out on its own once it
   * falls outside that window, the same idempotency-is-the-watermark design
   * as insertion. A failed tick (token refresh error) leaves the prior list
   * in place rather than clearing it — stale-but-true beats blank.
   */
  private skipped: StravaSkippedActivity[] = [];

  constructor(
    private readonly client: StravaClient,
    private readonly expenditures: ExpenditureStore,
    private readonly log: FastifyBaseLogger
  ) {}

  /** The current skip list — see `skipped` above. Read-only snapshot. */
  getSkipped(): StravaSkippedActivity[] {
    return [...this.skipped];
  }

  /**
   * One sync pass. A StravaRefreshError anywhere in the pass skips the rest
   * of the tick with a warning — never a crash, and the stored OAuth row is
   * left untouched for the next tick's retry.
   */
  async tick(now: Date = new Date()): Promise<StravaSyncTickResult> {
    try {
      return await this.run(now);
    } catch (err) {
      if (err instanceof StravaRefreshError) {
        this.log.warn(
          { err: err.message },
          'Strava token refresh failed — skipping this sync tick (stored token untouched; next tick retries)'
        );
        return { listed: 0, inserted: 0, skipped_no_calories: 0, refresh_failed: true };
      }
      throw err;
    }
  }

  private async run(now: Date): Promise<StravaSyncTickResult> {
    const after = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
    const activities = await this.client.listActivities(after);

    const seeded = activities.map((activity) => ({
      activity,
      ulid: ulidFromSeed(0, `strava:${activity.id}`),
    }));
    const seen = await this.expenditures.existingUlids(seeded.map((s) => s.ulid));
    const unseen = seeded.filter((s) => !seen.has(s.ulid));

    let inserted = 0;
    let skippedNoCalories = 0;
    const skippedThisRun: StravaSkippedActivity[] = [];
    for (const { activity, ulid } of unseen) {
      const detail = await this.client.getActivity(activity.id);

      // A burn is a stated number, never a written 0 (absent ≠ zero, same
      // doctrine as the nutrition panel). This activity will never be
      // imported by any future tick either — the trailing-window relist
      // re-evaluates it every time and reaches the same answer — so it is
      // recorded in the skip list (§ Skip visibility) for `expenditure list
      // --include-skipped` to surface, rather than left to a server log only.
      if (typeof detail.calories !== 'number' || !(detail.calories > 0)) {
        skippedNoCalories += 1;
        const label = (detail.name ?? activity.name ?? '').trim() || detail.sport_type || detail.type || 'Activity';
        const startDate = detail.start_date ? new Date(detail.start_date) : null;
        skippedThisRun.push({
          activity_id: activity.id,
          label,
          occurred_at: startDate && !Number.isNaN(startDate.getTime()) ? startDate : null,
        });
        this.log.info(
          { activity_id: activity.id, name: detail.name ?? activity.name },
          'Strava activity carries no calorie value — skipped (never written as 0)'
        );
        continue;
      }

      const startDate = detail.start_date ? new Date(detail.start_date) : null;
      if (!startDate || Number.isNaN(startDate.getTime())) {
        this.log.warn(
          { activity_id: activity.id },
          'Strava activity detail has no usable start_date — skipped'
        );
        continue;
      }

      const label =
        (detail.name ?? activity.name ?? '').trim() ||
        detail.sport_type ||
        detail.type ||
        'Activity';
      const { record, created } = await this.expenditures.insertIfAbsent({
        ulid,
        occurred_at: startDate,
        source: 'strava',
        label,
        kcal: detail.calories,
        duration_min:
          typeof detail.moving_time === 'number' ? Math.round(detail.moving_time / 60) : null,
        avg_hr:
          typeof detail.average_heartrate === 'number'
            ? Math.round(detail.average_heartrate)
            : null,
      });
      if (!created) continue; // raced replay — nothing new to warn about
      inserted += 1;
      await this.warnOverlaps(record);
    }

    this.skipped = skippedThisRun;

    return {
      listed: activities.length,
      inserted,
      skipped_no_calories: skippedNoCalories,
      refresh_failed: false,
    };
  }

  /**
   * Cross-source rule: warn — and only warn — about any existing non-strava
   * (manual/garmin) expenditure whose [occurred_at, occurred_at + duration]
   * span intersects the new row's. Owner arbitrates duplicates; the sync
   * never deletes, merges, or edits.
   */
  private async warnOverlaps(row: ExpenditureRecord): Promise<void> {
    const start = row.occurred_at.getTime();
    const end = start + (row.duration_min ?? 0) * MINUTE_MS;
    // Spans aren't indexed as ranges, so overfetch a generous window around
    // the new row (no stored activity plausibly exceeds 24 h) and intersect
    // in code.
    const candidates = await this.expenditures.list({
      since: new Date(start - DAY_MS),
      until: new Date(end + 1),
      limit: 500,
    });
    for (const other of candidates) {
      if (other.ulid === row.ulid || other.source === 'strava') continue;
      const otherStart = other.occurred_at.getTime();
      const otherEnd = otherStart + (other.duration_min ?? 0) * MINUTE_MS;
      if (otherStart <= end && start <= otherEnd) {
        this.log.warn(
          {
            strava_ulid: row.ulid,
            strava_label: row.label,
            overlapping_ulid: other.ulid,
            overlapping_source: other.source,
            overlapping_label: other.label,
          },
          'Synced Strava activity overlaps an existing expenditure — left untouched, owner arbitrates duplicates'
        );
      }
    }
  }
}
