import { describe, expect, it } from 'bun:test';
import { EMPTY_TRAINING, fetchTrainingSummary, parseSessions } from './training.js';

describe('parseSessions', () => {
  const rows = [
    { date: '2026-08-12', kind: 'run', title: 'Easy run 3 mi', distanceMiles: 3 },
    { date: '2026-08-10', kind: 'rest', title: 'Rest' },
  ];

  it('parses stored JSONB and sorts by date', () => {
    const sessions = parseSessions(rows);
    expect(sessions.map((s) => s.date)).toEqual(['2026-08-10', '2026-08-12']);
    expect(sessions[1]!.distanceMiles).toBe(3);
  });

  it('parses a driver that hands back JSON as a string', () => {
    expect(parseSessions(JSON.stringify(rows))).toHaveLength(2);
  });

  it('fills the fields the writer may have omitted', () => {
    const session = parseSessions([{ date: '2026-08-10', title: 'Rest' }])[0]!;
    expect(session.kind).toBe('run');
    expect(session.venue).toBe('either');
    expect(session.detail).toBe('');
    expect(session.distanceMiles).toBeNull();
  });

  it('skips an entry with no date or no title instead of rendering a blank bullet', () => {
    expect(parseSessions([{ kind: 'run', title: 'x' }, { date: '2026-08-10' }])).toEqual([]);
  });

  it('tolerates junk in the column', () => {
    expect(parseSessions(null)).toEqual([]);
    expect(parseSessions('not json')).toEqual([]);
    expect(parseSessions({ nope: true })).toEqual([]);
  });
});

describe('fetchTrainingSummary', () => {
  /** Stand-in for postgres.js's tagged template — answers queries in order. */
  function fakeSql(results: unknown[][]) {
    let i = 0;
    return (() => Promise.resolve(results[i++] ?? [])) as unknown as import('postgres').Sql;
  }

  it('returns the active week with today\'s session and a look-ahead', async () => {
    const sql = fakeSql([
      [
        {
          week_start: '2026-08-10',
          summary: 'Consistency week',
          sessions: [
            { date: '2026-08-12', kind: 'run', title: 'Easy run 3 mi' },
            { date: '2026-08-13', kind: 'rest', title: 'Rest' },
            { date: '2026-08-16', kind: 'run', title: 'Long run 6 mi' },
          ],
        },
      ],
      [],
    ]);
    const summary = await fetchTrainingSummary(sql, { dateIso: '2026-08-12' });
    expect(summary.available).toBe(true);
    expect(summary.today!.title).toBe('Easy run 3 mi');
    // The default two-day horizon includes the 13th and excludes the 16th.
    expect(summary.upcoming.map((s) => s.date)).toEqual(['2026-08-13']);
  });

  it('reports a pending week even when none is active', async () => {
    const sql = fakeSql([[], [{ week_start: '2026-08-17' }]]);
    const summary = await fetchTrainingSummary(sql, { dateIso: '2026-08-12' });
    expect(summary.available).toBe(false);
    expect(summary.pendingWeekStart).toBe('2026-08-17');
  });

  it('degrades a missing schema to absence, not to an error line', async () => {
    // An instance that doesn't run the training module must not see a
    // "not available" bullet in its briefing every morning.
    const sql = (() => Promise.reject(new Error('relation "training.week_plans" does not exist'))) as
      unknown as import('postgres').Sql;
    expect(await fetchTrainingSummary(sql, { dateIso: '2026-08-12' })).toEqual(EMPTY_TRAINING);
  });
});
