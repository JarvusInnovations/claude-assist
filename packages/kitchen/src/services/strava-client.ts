/**
 * Strava API client (specs/modules/kitchen.md § Strava activity sync).
 *
 * Fetch-based, no SDK — the module needs exactly three calls (token refresh,
 * activity list, activity detail), and owning the token custody is the whole
 * point: Strava rotates the refresh token on every refresh, so the rotated
 * token MUST be persisted (kitchen.strava_oauth) before anything else
 * proceeds. The env refresh token is a first-boot seed only; once the row
 * exists, the stored token is authoritative and the env value is ignored.
 *
 * A refresh failure throws `StravaRefreshError` — typed so the sync can skip
 * its tick with a warning instead of crashing. The stored row is NEVER
 * deleted on failure (transient Strava outages must not force a re-auth).
 */

import type { FastifyBaseLogger } from 'fastify';
import type { StravaOAuthStore } from '../store.js';

const STRAVA_BASE = 'https://www.strava.com';

/** Refresh when the access token expires within this margin. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface StravaClientConfig {
  clientId: string;
  clientSecret: string;
  /** First-boot seed only — ignored once kitchen.strava_oauth has a row. */
  refreshTokenSeed: string;
}

/**
 * Summary activity from GET /api/v3/athlete/activities (fields we read).
 *
 * The list endpoint already carries distance, duration, elevation, and average
 * heart rate — the expenditure sync ignores them (only the detail call has
 * `calories`), but a consumer reading activity *history* needs exactly these,
 * and a per-activity detail fetch to re-read what the list already returned
 * would burn the rate limit for nothing.
 */
export interface StravaActivitySummary {
  id: number;
  name?: string;
  type?: string;
  sport_type?: string;
  /** Meters. */
  distance?: number;
  /** Seconds. */
  moving_time?: number;
  /** Seconds. */
  elapsed_time?: number;
  /** Meters. */
  total_elevation_gain?: number;
  average_heartrate?: number;
  /** The activity's start instant, UTC (e.g. "2026-07-20T11:00:00Z"). */
  start_date?: string;
}

/** Detail from GET /api/v3/activities/:id — `calories` exists only here. */
export interface StravaActivityDetail extends StravaActivitySummary {
  /** Active calories. Absent/zero ⇒ the sync skips the activity. */
  calories?: number;
}

/** Token refresh failed — the sync catches this to skip the tick, warn-only. */
export class StravaRefreshError extends Error {
  constructor(message: string) {
    super(`Strava token refresh: ${message}`);
    this.name = 'StravaRefreshError';
  }
}

/** A non-token Strava API call failed (list/detail). */
export class StravaApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'StravaApiError';
  }
}

/** Injection seam for tests — mock at the client boundary, never the logic. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class StravaClient {
  constructor(
    private readonly config: StravaClientConfig,
    private readonly oauth: StravaOAuthStore,
    private readonly log: FastifyBaseLogger,
    private readonly fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init)
  ) {}

  /** GET /api/v3/athlete/activities?after=<epoch> — trailing-window list. */
  async listActivities(after: Date): Promise<StravaActivitySummary[]> {
    const epoch = Math.floor(after.getTime() / 1000);
    return this.apiGet<StravaActivitySummary[]>(
      `/api/v3/athlete/activities?after=${epoch}&per_page=100`
    );
  }

  /** GET /api/v3/activities/:id — the detail carries `calories`. */
  async getActivity(id: number): Promise<StravaActivityDetail> {
    return this.apiGet<StravaActivityDetail>(`/api/v3/activities/${id}`);
  }

  private async apiGet<T>(path: string): Promise<T> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${STRAVA_BASE}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new StravaApiError(`GET ${path} failed (HTTP ${res.status})`, res.status);
    }
    return (await res.json()) as T;
  }

  /**
   * A currently-valid access token: load the stored row (seeding it from the
   * configured refresh token on very first use), reuse the stored access
   * token while it has >5 min left, otherwise refresh — persisting the
   * rotated refresh token before returning.
   */
  private async accessToken(): Promise<string> {
    let state = await this.oauth.get();
    if (!state) {
      state = await this.oauth.seed(this.config.refreshTokenSeed);
      this.log.info('Strava OAuth row seeded from configured refresh token (first boot)');
    }
    const fresh =
      state.access_token !== null &&
      state.expires_at !== null &&
      state.expires_at.getTime() - Date.now() > EXPIRY_MARGIN_MS;
    if (fresh) return state.access_token!;
    return this.refresh(state.refresh_token);
  }

  private async refresh(refreshToken: string): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${STRAVA_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
      });
    } catch (err) {
      throw new StravaRefreshError(`request failed — ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new StravaRefreshError(`rejected (HTTP ${res.status})`);
    }

    let body: { access_token?: unknown; refresh_token?: unknown; expires_at?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch (err) {
      throw new StravaRefreshError(`unparseable response — ${(err as Error).message}`);
    }
    if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
      throw new StravaRefreshError('response missing access_token/refresh_token');
    }
    // Strava returns expires_at as epoch seconds.
    const expiresAt =
      typeof body.expires_at === 'number' ? new Date(body.expires_at * 1000) : null;

    // Persist the rotation BEFORE using the token — the stored row is the
    // only authoritative copy of the (now-rotated) refresh token.
    await this.oauth.save({
      refresh_token: body.refresh_token,
      access_token: body.access_token,
      expires_at: expiresAt,
    });
    return body.access_token;
  }
}
