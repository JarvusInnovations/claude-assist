/**
 * Strava activity sync (§ Strava activity sync — the exercise auto-feed).
 *
 * ALL fixtures are synthetic — this is a public repo, so no real tokens,
 * athlete ids, or activities appear anywhere here. Fetch is mocked at the
 * client boundary (the StravaClient's injected FetchLike), never the logic.
 */

import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import { MemoryExpenditureStore, MemoryStravaOAuthStore } from '../memory-store.js';
import { ulidFromSeed } from '../ulid.js';
import { StravaClient, StravaRefreshError } from './strava-client.js';
import {
  StravaSync,
  StravaSyncConfigError,
  isStravaSyncConfigured,
  parseStravaSyncMinutes,
  stravaSyncCron,
} from './strava-sync.js';

// ── Test rig ─────────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  init?: RequestInit;
}

type Route = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined;

function fetchMock(route: Route) {
  const calls: FetchCall[] = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const result = route(url, init);
    if (!result) throw new Error(`unexpected fetch in test: ${url}`);
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fn, calls };
}

function stubLog() {
  const warns: string[] = [];
  const infos: string[] = [];
  const messageOf = (args: unknown[]) =>
    (args.find((a) => typeof a === 'string') as string | undefined) ?? JSON.stringify(args[0]);
  const log = {
    info: (...args: unknown[]) => infos.push(messageOf(args)),
    warn: (...args: unknown[]) => warns.push(messageOf(args)),
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child() {
      return log;
    },
  } as unknown as FastifyBaseLogger;
  return { log, warns, infos };
}

/** Freshly-issued token response — expires_at is epoch SECONDS per Strava. */
function tokenResponse(n: number, expiresInSec = 6 * 3600) {
  return {
    access_token: `synthetic-access-${n}`,
    refresh_token: `synthetic-refresh-${n}`,
    expires_at: Math.floor(Date.now() / 1000) + expiresInSec,
  };
}

// Synthetic activities (never real Strava data).
const RIDE_SUMMARY = { id: 1001, name: 'Morning Ride', sport_type: 'Ride' };
const RIDE_DETAIL = {
  ...RIDE_SUMMARY,
  calories: 512,
  moving_time: 3720, // 62 min
  average_heartrate: 141.6,
  start_date: '2026-07-20T11:00:00Z',
};
const PADDLE_SUMMARY = { id: 1002, name: 'Evening Paddle', sport_type: 'Kayaking' };
const PADDLE_DETAIL = {
  ...PADDLE_SUMMARY,
  calories: 300,
  moving_time: 1800,
  average_heartrate: 118.2,
  start_date: '2026-07-21T22:30:00Z',
};

const CONFIG = {
  clientId: 'synthetic-client-id',
  clientSecret: 'synthetic-client-secret',
  refreshTokenSeed: 'synthetic-env-seed-token',
};

/** Standard happy-path route: token endpoint + list + details. */
function stravaRoutes(options: {
  tokenCounter?: { n: number };
  activities?: Array<Record<string, unknown>>;
  details?: Record<number, Record<string, unknown>>;
  tokenStatus?: number;
}): Route {
  const counter = options.tokenCounter ?? { n: 0 };
  return (url) => {
    if (url.endsWith('/oauth/token')) {
      if (options.tokenStatus && options.tokenStatus >= 400) {
        return { status: options.tokenStatus, body: { message: 'Bad Request' } };
      }
      counter.n += 1;
      return { body: tokenResponse(counter.n) };
    }
    if (url.includes('/api/v3/athlete/activities')) {
      return { body: options.activities ?? [] };
    }
    const detailMatch = url.match(/\/api\/v3\/activities\/(\d+)$/);
    if (detailMatch) {
      const detail = options.details?.[Number(detailMatch[1])];
      return detail ? { body: detail } : { status: 404, body: { message: 'Not Found' } };
    }
    return undefined;
  };
}

function makeSync(route: Route) {
  const { log, warns, infos } = stubLog();
  const oauth = new MemoryStravaOAuthStore();
  const expenditures = new MemoryExpenditureStore();
  const { fn, calls } = fetchMock(route);
  const client = new StravaClient(CONFIG, oauth, log, fn);
  const sync = new StravaSync(client, expenditures, log);
  return { sync, client, oauth, expenditures, calls, warns, infos, log };
}

// ── Config gating ────────────────────────────────────────────────────────────

describe('isStravaSyncConfigured (all-three-or-off)', () => {
  const full = {
    stravaClientId: 'id',
    stravaClientSecret: 'secret',
    stravaRefreshToken: 'token',
  };

  it('all three present ⇒ on', () => {
    expect(isStravaSyncConfigured(full)).toBe(true);
  });

  it('any missing (or blank) ⇒ entirely off, never partial', () => {
    expect(isStravaSyncConfigured({})).toBe(false);
    expect(isStravaSyncConfigured({ ...full, stravaClientId: undefined })).toBe(false);
    expect(isStravaSyncConfigured({ ...full, stravaClientSecret: undefined })).toBe(false);
    expect(isStravaSyncConfigured({ ...full, stravaRefreshToken: undefined })).toBe(false);
    expect(isStravaSyncConfigured({ ...full, stravaRefreshToken: '' })).toBe(false);
  });
});

describe('parseStravaSyncMinutes / stravaSyncCron (boot-loud, KITCHEN_DAILY_TARGETS precedent)', () => {
  it('absent/blank ⇒ the default 30', () => {
    expect(parseStravaSyncMinutes(undefined)).toBe(30);
    expect(parseStravaSyncMinutes('')).toBe(30);
    expect(parseStravaSyncMinutes('  ')).toBe(30);
  });

  it('a positive integer parses', () => {
    expect(parseStravaSyncMinutes('45')).toBe(45);
    expect(parseStravaSyncMinutes('120')).toBe(120);
  });

  it('malformed values throw StravaSyncConfigError (never a silent default)', () => {
    for (const raw of ['0', '-5', 'abc', '1.5', '30m']) {
      expect(() => parseStravaSyncMinutes(raw)).toThrow(StravaSyncConfigError);
    }
  });

  it('renders cron for sub-hourly and whole-hour cadences; rejects the unrepresentable', () => {
    expect(stravaSyncCron(30)).toBe('*/30 * * * *');
    expect(stravaSyncCron(1)).toBe('*/1 * * * *');
    expect(stravaSyncCron(120)).toBe('0 */2 * * *');
    expect(() => stravaSyncCron(90)).toThrow(StravaSyncConfigError);
  });
});

// ── Token custody ────────────────────────────────────────────────────────────

describe('token custody (env = first-boot seed only; rotation persisted)', () => {
  it('first use seeds the row from the env token, then persists the rotation', async () => {
    const { sync, oauth, calls } = makeSync(stravaRoutes({ activities: [] }));
    await sync.tick();

    const tokenCall = calls.find((c) => c.url.endsWith('/oauth/token'));
    expect(tokenCall).toBeDefined();
    expect(String(tokenCall!.init?.body)).toContain('refresh_token=synthetic-env-seed-token');

    // The rotated pair — not the env seed — is now stored.
    const state = await oauth.get();
    expect(state?.refresh_token).toBe('synthetic-refresh-1');
    expect(state?.access_token).toBe('synthetic-access-1');
    expect(state!.expires_at!.getTime()).toBeGreaterThan(Date.now());
  });

  it('once a row exists the env seed is ignored — the stored token refreshes', async () => {
    const { sync, oauth, calls } = makeSync(stravaRoutes({ activities: [] }));
    await oauth.save({
      refresh_token: 'synthetic-stored-token',
      access_token: null,
      expires_at: null,
    });

    await sync.tick();

    const tokenCall = calls.find((c) => c.url.endsWith('/oauth/token'));
    expect(String(tokenCall!.init?.body)).toContain('refresh_token=synthetic-stored-token');
    expect(String(tokenCall!.init?.body)).not.toContain('synthetic-env-seed-token');
  });

  it('the rotated refresh token is what the NEXT refresh uses', async () => {
    const { sync, oauth, calls } = makeSync(stravaRoutes({ activities: [] }));
    await sync.tick(); // rotation 1 → stores synthetic-refresh-1

    // Force the next tick to refresh again: expire the stored access token.
    const state = await oauth.get();
    await oauth.save({ ...state!, expires_at: new Date(Date.now() - 1000) });

    await sync.tick(); // rotation 2 — must present synthetic-refresh-1

    const tokenCalls = calls.filter((c) => c.url.endsWith('/oauth/token'));
    expect(tokenCalls).toHaveLength(2);
    expect(String(tokenCalls[1]!.init?.body)).toContain('refresh_token=synthetic-refresh-1');
    expect((await oauth.get())?.refresh_token).toBe('synthetic-refresh-2');
  });

  it('a fresh stored access token is reused without hitting the token endpoint', async () => {
    const { sync, oauth, calls } = makeSync(stravaRoutes({ activities: [] }));
    await oauth.save({
      refresh_token: 'synthetic-stored-token',
      access_token: 'synthetic-live-access',
      expires_at: new Date(Date.now() + 3600_000), // > 5 min margin
    });

    await sync.tick();

    expect(calls.filter((c) => c.url.endsWith('/oauth/token'))).toHaveLength(0);
    const listCall = calls.find((c) => c.url.includes('/athlete/activities'));
    expect((listCall!.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer synthetic-live-access'
    );
  });

  it('a refresh failure skips the tick with a warning — no crash, stored row untouched', async () => {
    const { sync, oauth, calls, warns } = makeSync(
      stravaRoutes({ tokenStatus: 400, activities: [RIDE_SUMMARY] })
    );
    await oauth.save({
      refresh_token: 'synthetic-stored-token',
      access_token: null,
      expires_at: null,
    });

    const result = await sync.tick();

    expect(result.refresh_failed).toBe(true);
    expect(result.inserted).toBe(0);
    expect(warns.some((w) => w.includes('refresh failed'))).toBe(true);
    // No API calls happened, and the row survives for the next tick's retry.
    expect(calls.filter((c) => c.url.includes('/api/v3/'))).toHaveLength(0);
    expect((await oauth.get())?.refresh_token).toBe('synthetic-stored-token');
  });
});

// ── Pull contract ────────────────────────────────────────────────────────────

describe('pull contract (unseen-only, seeded ulids, stated numbers)', () => {
  it('inserts an unseen activity with the mapped fields and seeded ulid', async () => {
    const { sync, expenditures, calls } = makeSync(
      stravaRoutes({ activities: [RIDE_SUMMARY], details: { 1001: RIDE_DETAIL } })
    );

    const result = await sync.tick(new Date('2026-07-24T12:00:00Z'));
    expect(result).toMatchObject({ listed: 1, inserted: 1, skipped_no_calories: 0 });

    // List call carries the 7-day `after` epoch.
    const listCall = calls.find((c) => c.url.includes('/athlete/activities'))!;
    const after = Number(new URL(listCall.url).searchParams.get('after'));
    expect(after).toBe(Math.floor(new Date('2026-07-17T12:00:00Z').getTime() / 1000));

    const rows = await expenditures.list({});
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.ulid).toBe(ulidFromSeed(0, 'strava:1001'));
    expect(row.source).toBe('strava');
    expect(row.label).toBe('Morning Ride');
    expect(row.kcal).toBe(512);
    expect(row.duration_min).toBe(62); // round(3720 / 60)
    expect(row.avg_hr).toBe(142); // round(141.6)
    expect(row.occurred_at.toISOString()).toBe('2026-07-20T11:00:00.000Z');
  });

  it('a blank name falls back to the sport type', async () => {
    const { sync, expenditures } = makeSync(
      stravaRoutes({
        activities: [{ id: 1003, name: '  ', sport_type: 'Run' }],
        details: {
          1003: { id: 1003, name: '  ', sport_type: 'Run', calories: 200, moving_time: 900, start_date: '2026-07-22T10:00:00Z' },
        },
      })
    );
    await sync.tick();
    const [row] = await expenditures.list({});
    expect(row!.label).toBe('Run');
    expect(row!.avg_hr).toBeNull(); // absent heart rate stays null, never 0
  });

  it('already-seen seeded ulids are replayed: no duplicate row, NO detail call', async () => {
    const { sync, expenditures, calls } = makeSync(
      stravaRoutes({
        activities: [RIDE_SUMMARY, PADDLE_SUMMARY],
        details: { 1001: RIDE_DETAIL, 1002: PADDLE_DETAIL },
      })
    );
    // The manual backfill already wrote activity 1001 under the locked seed.
    await expenditures.insertIfAbsent({
      ulid: ulidFromSeed(0, 'strava:1001'),
      occurred_at: new Date('2026-07-20T11:00:00Z'),
      source: 'strava',
      label: 'Morning Ride',
      kcal: 512,
      duration_min: 62,
      avg_hr: 142,
    });

    const result = await sync.tick();
    expect(result).toMatchObject({ listed: 2, inserted: 1 });

    const detailCalls = calls.filter((c) => /\/api\/v3\/activities\/\d+$/.test(c.url));
    expect(detailCalls).toHaveLength(1);
    expect(detailCalls[0]!.url.endsWith('/1002')).toBe(true);
    expect(await expenditures.list({})).toHaveLength(2);
  });

  it('an activity without calories is skipped with a log line, never written as 0', async () => {
    const { sync, expenditures, infos } = makeSync(
      stravaRoutes({
        activities: [{ id: 1004, name: 'Walk With No Meter', sport_type: 'Walk' }],
        details: {
          1004: { id: 1004, name: 'Walk With No Meter', sport_type: 'Walk', moving_time: 600, start_date: '2026-07-23T09:00:00Z' },
        },
      })
    );
    const result = await sync.tick();
    expect(result).toMatchObject({ inserted: 0, skipped_no_calories: 1 });
    expect(await expenditures.list({})).toHaveLength(0);
    expect(infos.some((m) => m.includes('no calorie value'))).toBe(true);
  });

  it('zero calories counts as absent (a burn is a stated number)', async () => {
    const { sync, expenditures } = makeSync(
      stravaRoutes({
        activities: [{ id: 1005, name: 'Zeroed Ride' }],
        details: { 1005: { id: 1005, name: 'Zeroed Ride', calories: 0, moving_time: 600, start_date: '2026-07-23T09:00:00Z' } },
      })
    );
    const result = await sync.tick();
    expect(result.skipped_no_calories).toBe(1);
    expect(await expenditures.list({})).toHaveLength(0);
  });
});

// ── Skip visibility (claude-assist#214) ─────────────────────────────────────

describe('getSkipped (live skip list, not stored)', () => {
  it('starts empty before any tick', () => {
    const { sync } = makeSync(stravaRoutes({ activities: [] }));
    expect(sync.getSkipped()).toEqual([]);
  });

  it('a skipped activity appears with its id, label, and start instant', async () => {
    const { sync } = makeSync(
      stravaRoutes({
        activities: [{ id: 1004, name: 'Walk With No Meter', sport_type: 'Walk' }],
        details: {
          1004: { id: 1004, name: 'Walk With No Meter', sport_type: 'Walk', moving_time: 600, start_date: '2026-07-23T09:00:00Z' },
        },
      })
    );
    await sync.tick();
    expect(sync.getSkipped()).toEqual([
      { activity_id: 1004, label: 'Walk With No Meter', occurred_at: new Date('2026-07-23T09:00:00Z') },
    ]);
  });

  it('a blank/absent name falls back to sport type, same as an inserted row', async () => {
    const { sync } = makeSync(
      stravaRoutes({
        activities: [{ id: 1006, sport_type: 'Swim' }],
        details: { 1006: { id: 1006, sport_type: 'Swim', start_date: '2026-07-24T08:00:00Z' } },
      })
    );
    await sync.tick();
    expect(sync.getSkipped()).toEqual([
      { activity_id: 1006, label: 'Swim', occurred_at: new Date('2026-07-24T08:00:00Z') },
    ]);
  });

  it('an insert is never also a skip', async () => {
    const { sync } = makeSync(
      stravaRoutes({ activities: [RIDE_SUMMARY], details: { 1001: RIDE_DETAIL } })
    );
    await sync.tick();
    expect(sync.getSkipped()).toEqual([]);
  });

  it('rebuilds fresh each tick — an activity dropped from the next list disappears', async () => {
    // A mutable route: first tick's list carries the no-calorie activity,
    // second tick's list is empty — e.g. it aged out of the trailing window.
    let activities: Array<Record<string, unknown>> = [
      { id: 1007, name: 'Aging Out', sport_type: 'Run' },
    ];
    const details = {
      1007: { id: 1007, name: 'Aging Out', sport_type: 'Run', start_date: '2026-07-10T08:00:00Z' },
    };
    const counter = { n: 0 };
    const route: Route = (url) => stravaRoutes({ tokenCounter: counter, activities, details })(url);
    const { sync } = makeSync(route);

    await sync.tick();
    expect(sync.getSkipped()).toHaveLength(1);

    activities = []; // simulate the activity aging out of the trailing window
    await sync.tick();
    expect(sync.getSkipped()).toEqual([]);
  });

  it('a failed tick (token refresh error) leaves the prior skip list in place', async () => {
    // First tick succeeds and records a skip; the SECOND token refresh
    // fails (the stored access token is forced to expire between ticks).
    let tokenCalls = 0;
    const route: Route = (url) => {
      if (url.endsWith('/oauth/token')) {
        tokenCalls += 1;
        if (tokenCalls === 1) return { body: tokenResponse(1) };
        return { status: 400, body: { message: 'Bad Request' } };
      }
      if (url.includes('/athlete/activities')) {
        return { body: [{ id: 1008, name: 'Kept On Failure', sport_type: 'Row' }] };
      }
      const detailMatch = url.match(/\/api\/v3\/activities\/(\d+)$/);
      if (detailMatch && Number(detailMatch[1]) === 1008) {
        return {
          body: { id: 1008, name: 'Kept On Failure', sport_type: 'Row', start_date: '2026-07-11T08:00:00Z' },
        };
      }
      return undefined;
    };
    const { sync, oauth } = makeSync(route);

    await sync.tick();
    expect(sync.getSkipped()).toHaveLength(1);

    // Expire the stored access token so the next tick must refresh — and
    // the mocked token endpoint now 400s.
    const state = await oauth.get();
    await oauth.save({ ...state!, expires_at: new Date(Date.now() - 1000) });

    const result = await sync.tick();
    expect(result.refresh_failed).toBe(true);
    expect(sync.getSkipped()).toHaveLength(1); // unchanged from the earlier successful tick
  });
});

// ── Cross-source rule ────────────────────────────────────────────────────────

describe('cross-source rule (warn-only overlap surfacing)', () => {
  it('warns about an overlapping manual row and leaves it untouched', async () => {
    const { sync, expenditures, warns } = makeSync(
      stravaRoutes({ activities: [RIDE_SUMMARY], details: { 1001: RIDE_DETAIL } })
    );
    // Manual row 11:30–12:00Z overlaps the ride's 11:00–12:02Z span.
    const manual = await expenditures.insertIfAbsent({
      ulid: ulidFromSeed(0, 'test:manual-overlap'),
      occurred_at: new Date('2026-07-20T11:30:00Z'),
      source: 'manual',
      label: 'Bike ride (hand-logged)',
      kcal: 480,
      duration_min: 30,
      avg_hr: null,
    });

    await sync.tick();

    expect(warns.some((w) => w.includes('overlaps an existing expenditure'))).toBe(true);
    // The manual row is exactly as it was — never deleted, merged, or edited.
    const rows = await expenditures.list({});
    const stillManual = rows.find((r) => r.ulid === manual.record.ulid)!;
    expect(stillManual.kcal).toBe(480);
    expect(stillManual.label).toBe('Bike ride (hand-logged)');
    expect(rows).toHaveLength(2);
  });

  it('a non-overlapping manual row produces no warning', async () => {
    const { sync, expenditures, warns } = makeSync(
      stravaRoutes({ activities: [RIDE_SUMMARY], details: { 1001: RIDE_DETAIL } })
    );
    await expenditures.insertIfAbsent({
      ulid: ulidFromSeed(0, 'test:manual-clear'),
      occurred_at: new Date('2026-07-20T14:00:00Z'), // hours after the ride ends
      source: 'manual',
      label: 'Afternoon walk',
      kcal: 150,
      duration_min: 40,
      avg_hr: null,
    });

    await sync.tick();

    expect(warns.filter((w) => w.includes('overlaps'))).toHaveLength(0);
  });
});
