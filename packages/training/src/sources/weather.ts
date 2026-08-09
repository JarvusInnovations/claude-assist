/**
 * Daily forecast for the plan week (AccuWeather's daily-forecast API).
 *
 * Fetch-based, no SDK — one GET, and the only thing worth owning is the
 * defensive parse: the response nests differently between the free and paid
 * tiers, and a shape change must degrade the section rather than sink the
 * weekly job.
 *
 * PREFLIGHT: both the API key and the location key are instance config. With
 * either absent the client is never constructed and the forecast section
 * reports "not configured" — the synthesis is then explicitly told it is
 * planning without a forecast, which is very different from being handed a
 * week of blank weather it would read as mild.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { ForecastDay, WeatherSummary } from '../types.js';

const DEFAULT_BASE_URL = 'https://dataservice.accuweather.com';

/** Injection seam for tests — mock at the client boundary, never the logic. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface WeatherClientConfig {
  apiKey: string;
  /** Provider's opaque location id for the owner's training area. */
  locationKey: string;
  /** Override for tests / a proxy. */
  baseUrl?: string;
  /** Forecast horizon the account is entitled to (1 | 5 | 10 | 15). Default 5. */
  days?: number;
  timeoutMs?: number;
}

export interface WeatherConfigInput {
  apiKey?: string;
  locationKey?: string;
  baseUrl?: string;
  days?: number;
}

/** True when every credential the forecast needs is present. */
export function isWeatherConfigured(config: WeatherConfigInput): boolean {
  return Boolean(config.apiKey && config.locationKey);
}

export class WeatherClient {
  private readonly baseUrl: string;
  private readonly days: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: WeatherClientConfig,
    private readonly log: FastifyBaseLogger,
    private readonly fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init)
  ) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.days = config.days ?? 5;
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  /**
   * The forecast, filtered to the requested dates. Never throws — a failure
   * resolves to `{ days: [], error }` and the week is planned without it.
   */
  async forecast(dates: string[]): Promise<WeatherSummary> {
    const url =
      `${this.baseUrl}/forecasts/v1/daily/${this.days}day/` +
      `${encodeURIComponent(this.config.locationKey)}` +
      `?apikey=${encodeURIComponent(this.config.apiKey)}&details=true&metric=false`;

    try {
      const res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        return { days: [], error: `forecast request failed (HTTP ${res.status})` };
      }
      const body: unknown = await res.json();
      const all = parseDailyForecast(body);
      const wanted = new Set(dates);
      return { days: all.filter((d) => wanted.has(d.date)), error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn({ err }, 'Training: forecast fetch failed — planning without it');
      return { days: [], error: `forecast unavailable: ${message}` };
    }
  }
}

/**
 * Parse the provider's `DailyForecasts` array into `ForecastDay`s.
 *
 * Every field is optional-by-assumption: an entry that yields no usable date is
 * dropped, and a missing temperature or precipitation probability becomes null
 * rather than a zero the synthesis would read as freezing and dry.
 *
 * Exported for tests.
 */
export function parseDailyForecast(body: unknown): ForecastDay[] {
  const root = body as { DailyForecasts?: unknown };
  const entries = Array.isArray(root?.DailyForecasts) ? root.DailyForecasts : [];
  const out: ForecastDay[] = [];

  for (const raw of entries) {
    const entry = raw as Record<string, unknown>;
    const date = isoDateOf(entry.Date);
    if (!date) continue;

    const temp = entry.Temperature as
      | { Minimum?: { Value?: unknown }; Maximum?: { Value?: unknown } }
      | undefined;
    const day = entry.Day as
      | { IconPhrase?: unknown; PrecipitationProbability?: unknown; ShortPhrase?: unknown }
      | undefined;

    out.push({
      date,
      summary: firstString(day?.IconPhrase, day?.ShortPhrase) ?? '',
      highF: numberOrNull(temp?.Maximum?.Value),
      lowF: numberOrNull(temp?.Minimum?.Value),
      precipProbability: numberOrNull(day?.PrecipitationProbability),
    });
  }
  return out;
}

function isoDateOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1]! : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}
