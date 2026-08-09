import { describe, expect, it } from 'bun:test';
import { createActivityHistoryProvider, toActivityRecord } from './activity-history.js';
import type { StravaActivitySummary, StravaClient } from './strava-client.js';

function summary(over: Partial<StravaActivitySummary> = {}): StravaActivitySummary {
  return {
    id: 987654,
    name: 'Morning Run',
    type: 'Run',
    sport_type: 'TrailRun',
    distance: 8046.7,
    moving_time: 2700,
    elapsed_time: 2900,
    total_elevation_gain: 120,
    average_heartrate: 148,
    start_date: '2026-08-05T11:00:00Z',
    ...over,
  };
}

describe('toActivityRecord', () => {
  it('maps the list-endpoint fields a history consumer needs', () => {
    expect(toActivityRecord(summary())).toEqual({
      id: '987654',
      sport: 'TrailRun',
      name: 'Morning Run',
      startedAt: '2026-08-05T11:00:00Z',
      distanceMeters: 8046.7,
      movingSeconds: 2700,
      elevationGainMeters: 120,
      averageHeartrate: 148,
    });
  });

  it('prefers sport_type over the legacy type', () => {
    // A trail run and a road run are different training stimuli; the legacy
    // `type` collapses them.
    expect(toActivityRecord(summary()).sport).toBe('TrailRun');
    expect(toActivityRecord(summary({ sport_type: undefined })).sport).toBe('Run');
    expect(toActivityRecord(summary({ sport_type: undefined, type: undefined })).sport).toBe(
      'unknown'
    );
  });

  it('nulls absent metrics rather than defaulting them to zero', () => {
    const record = toActivityRecord(
      summary({ distance: undefined, moving_time: undefined, average_heartrate: undefined })
    );
    expect(record.distanceMeters).toBeNull();
    expect(record.movingSeconds).toBeNull();
    expect(record.averageHeartrate).toBeNull();
  });
});

describe('createActivityHistoryProvider', () => {
  function fakeClient(activities: StravaActivitySummary[]): StravaClient {
    return {
      listActivities: async () => activities,
    } as unknown as StravaClient;
  }

  it('passes the window through and adapts every activity', async () => {
    const asked: Date[] = [];
    const client = {
      listActivities: async (after: Date) => {
        asked.push(after);
        return [summary()];
      },
    } as unknown as StravaClient;

    const since = new Date('2026-07-01T00:00:00Z');
    const records = await createActivityHistoryProvider(client)(since);
    expect(asked).toEqual([since]);
    expect(records).toHaveLength(1);
  });

  it('drops an activity with no usable start instant', async () => {
    // Every consumer buckets by date; a record without one would silently land
    // in whatever bucket the empty string sorts into.
    const records = await createActivityHistoryProvider(
      fakeClient([summary(), summary({ id: 2, start_date: undefined })])
    )(new Date());
    expect(records.map((r) => r.id)).toEqual(['987654']);
  });

  it('surfaces a client failure rather than swallowing it', async () => {
    const client = {
      listActivities: async () => {
        throw new Error('token refresh rejected');
      },
    } as unknown as StravaClient;
    await expect(createActivityHistoryProvider(client)(new Date())).rejects.toThrow(
      'token refresh rejected'
    );
  });
});
