/**
 * Activity-history seam over the module's Strava credentials.
 *
 * This module already owns the Strava OAuth row, and Strava rotates the refresh
 * token on every refresh — so there can be exactly ONE rotator per instance. A
 * sibling module that wanted activity history and held its own refresh token
 * would invalidate this one's stored token on its first refresh, and vice
 * versa. Rather than duplicate token custody, the module exposes what it can
 * already read behind the generic `ActivityHistoryProvider` contract in core,
 * and the server composes it into whatever consumer wants it.
 *
 * Read-only and side-effect free: no rows are written, nothing is depleted.
 * The expenditure sync (strava-sync.ts) remains the only writer.
 */

import type { ActivityHistoryProvider, ActivityHistoryRecord } from '@jarvus/claude-assist-core';
import type { StravaActivitySummary, StravaClient } from './strava-client.js';

/**
 * Adapt one Strava summary activity to the provider-agnostic record.
 *
 * `sport_type` is preferred over the legacy `type` because it distinguishes
 * a trail run from a road run and a virtual ride from an outdoor one — exactly
 * the distinctions a consumer of training history cares about. Exported for tests.
 */
export function toActivityRecord(activity: StravaActivitySummary): ActivityHistoryRecord {
  return {
    id: String(activity.id),
    sport: activity.sport_type ?? activity.type ?? 'unknown',
    name: activity.name ?? '',
    startedAt: activity.start_date ?? '',
    distanceMeters: numberOrNull(activity.distance),
    movingSeconds: numberOrNull(activity.moving_time),
    elevationGainMeters: numberOrNull(activity.total_elevation_gain),
    averageHeartrate: numberOrNull(activity.average_heartrate),
  };
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Build the provider. Activities with no usable start instant are dropped —
 * every consumer buckets by date, and a record without one would silently land
 * in whatever bucket the empty string sorts into.
 */
export function createActivityHistoryProvider(client: StravaClient): ActivityHistoryProvider {
  return async (since: Date): Promise<ActivityHistoryRecord[]> => {
    const activities = await client.listActivities(since);
    return activities.map(toActivityRecord).filter((r) => r.startedAt.length > 0);
  };
}
