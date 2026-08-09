import { describe, expect, it } from 'bun:test';
import type { ActivityHistoryRecord } from '@jarvus/claude-assist-core';
import { fetchActivitySummary, isRun, normalizeSport, summarizeActivities } from './activity.js';

function record(overrides: Partial<ActivityHistoryRecord>): ActivityHistoryRecord {
  return {
    id: 'a1',
    sport: 'Run',
    name: 'Morning Run',
    startedAt: '2026-08-05T11:00:00Z',
    distanceMeters: 5000,
    movingSeconds: 1800,
    elevationGainMeters: 20,
    averageHeartrate: 150,
    ...overrides,
  };
}

describe('sport normalization', () => {
  it('folds the provider\'s casing and punctuation', () => {
    expect(normalizeSport('TrailRun')).toBe('trailrun');
    expect(normalizeSport('Virtual Ride')).toBe('virtualride');
  });

  it('counts trail and treadmill work as running, cycling as cross-training', () => {
    expect(isRun('Run')).toBe(true);
    expect(isRun('TrailRun')).toBe(true);
    expect(isRun('Ride')).toBe(false);
    expect(isRun('Swim')).toBe(false);
  });
});

describe('summarizeActivities', () => {
  const records = [
    record({ id: '1', sport: 'Run', startedAt: '2026-08-03T11:00:00Z', distanceMeters: 3218.7 }),
    record({ id: '2', sport: 'Run', startedAt: '2026-08-06T11:00:00Z', distanceMeters: 6437.4 }),
    record({
      id: '3',
      sport: 'Ride',
      startedAt: '2026-08-07T11:00:00Z',
      distanceMeters: 24140,
      movingSeconds: 3600,
    }),
    record({ id: '4', sport: 'Run', startedAt: '2026-07-28T11:00:00Z', distanceMeters: 3218.7 }),
  ];

  it('rolls up by sport and by week, most recent week first', () => {
    const summary = summarizeActivities(records, { windowDays: 42, asOfIso: '2026-08-10' });
    expect(summary.totalCount).toBe(4);

    const run = summary.bySport.find((s) => s.sport === 'run')!;
    expect(run.count).toBe(3);
    expect(run.distanceMiles).toBeCloseTo(8.0, 1);

    expect(summary.weekly.map((w) => w.weekStart)).toEqual(['2026-08-03', '2026-07-27']);
    expect(summary.weekly[0]!.runCount).toBe(2);
    expect(summary.weekly[0]!.crossCount).toBe(1);
    expect(summary.weekly[0]!.crossMinutes).toBe(60);
  });

  it('tracks the longest run and days since the last one', () => {
    const summary = summarizeActivities(records, { windowDays: 42, asOfIso: '2026-08-10' });
    expect(summary.longestRunMiles).toBeCloseTo(4.0, 1);
    expect(summary.daysSinceLastRun).toBe(4); // last run 2026-08-06
  });

  it('reports no run in the window rather than zero days since one', () => {
    // Zero would read as "ran today", which is the opposite of the truth.
    const summary = summarizeActivities(
      [record({ sport: 'Ride' })],
      { windowDays: 42, asOfIso: '2026-08-10' }
    );
    expect(summary.daysSinceLastRun).toBeNull();
    expect(summary.longestRunMiles).toBe(0);
  });

  it('survives records with missing distance or duration', () => {
    const summary = summarizeActivities(
      [record({ distanceMeters: null, movingSeconds: null })],
      { windowDays: 42, asOfIso: '2026-08-10' }
    );
    expect(summary.bySport[0]!.distanceMiles).toBe(0);
    expect(summary.bySport[0]!.movingMinutes).toBe(0);
  });
});

describe('fetchActivitySummary', () => {
  it('flags an absent provider instead of returning a silent empty week', () => {
    return fetchActivitySummary(undefined, { asOfIso: '2026-08-10' }).then((summary) => {
      expect(summary.error).toContain('not configured');
      expect(summary.totalCount).toBe(0);
    });
  });

  it('degrades a throwing provider to a flagged error', async () => {
    const summary = await fetchActivitySummary(
      async () => {
        throw new Error('token refresh rejected');
      },
      { asOfIso: '2026-08-10' }
    );
    expect(summary.error).toContain('token refresh rejected');
  });

  it('passes the trailing window through to the provider', async () => {
    let asked: Date | null = null;
    const summary = await fetchActivitySummary(
      async (since) => {
        asked = since;
        return [record({})];
      },
      { asOfIso: '2026-08-10', windowDays: 14 }
    );
    expect(summary.windowDays).toBe(14);
    expect(summary.totalCount).toBe(1);
    const days = (Date.now() - (asked as unknown as Date).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(14, 0);
  });
});
