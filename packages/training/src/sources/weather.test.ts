import { describe, expect, it } from 'bun:test';
import { WeatherClient, isWeatherConfigured, parseDailyForecast } from './weather.js';

const log = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return log;
  },
  level: 'info',
  silent() {},
} as unknown as import('fastify').FastifyBaseLogger;

const BODY = {
  DailyForecasts: [
    {
      Date: '2026-08-10T07:00:00-04:00',
      Temperature: { Minimum: { Value: 71.2 }, Maximum: { Value: 88.4 } },
      Day: { IconPhrase: 'Partly sunny', PrecipitationProbability: 14 },
    },
    {
      Date: '2026-08-11T07:00:00-04:00',
      Temperature: { Minimum: { Value: 68 }, Maximum: { Value: 79 } },
      Day: { ShortPhrase: 'Showers', PrecipitationProbability: 80 },
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('isWeatherConfigured', () => {
  it('requires both credentials — a partial config is off, not half-on', () => {
    expect(isWeatherConfigured({ apiKey: 'k', locationKey: 'l' })).toBe(true);
    expect(isWeatherConfigured({ apiKey: 'k' })).toBe(false);
    expect(isWeatherConfigured({ locationKey: 'l' })).toBe(false);
    expect(isWeatherConfigured({})).toBe(false);
  });
});

describe('parseDailyForecast', () => {
  it('reads the date, phrase, temperatures, and precipitation probability', () => {
    const days = parseDailyForecast(BODY);
    expect(days).toHaveLength(2);
    expect(days[0]).toEqual({
      date: '2026-08-10',
      summary: 'Partly sunny',
      highF: 88,
      lowF: 71,
      precipProbability: 14,
    });
    // ShortPhrase is the fallback when IconPhrase is absent.
    expect(days[1]!.summary).toBe('Showers');
  });

  it('nulls a missing temperature rather than defaulting it to zero', () => {
    const days = parseDailyForecast({
      DailyForecasts: [{ Date: '2026-08-10T07:00:00-04:00', Day: {} }],
    });
    expect(days[0]!.highF).toBeNull();
    expect(days[0]!.lowF).toBeNull();
    expect(days[0]!.precipProbability).toBeNull();
  });

  it('drops an entry with no usable date, and tolerates a shape change', () => {
    expect(parseDailyForecast({ DailyForecasts: [{ Temperature: {} }] })).toEqual([]);
    expect(parseDailyForecast({})).toEqual([]);
    expect(parseDailyForecast(null)).toEqual([]);
    expect(parseDailyForecast({ DailyForecasts: 'nope' })).toEqual([]);
  });
});

describe('WeatherClient.forecast', () => {
  const config = { apiKey: 'key', locationKey: 'loc', baseUrl: 'https://weather.example' };

  it('filters the provider response to the requested dates', async () => {
    let requested = '';
    const client = new WeatherClient(config, log, async (url) => {
      requested = url;
      return jsonResponse(BODY);
    });
    const result = await client.forecast(['2026-08-10']);
    expect(result.error).toBeNull();
    expect(result.days.map((d) => d.date)).toEqual(['2026-08-10']);
    expect(requested).toContain('https://weather.example/forecasts/v1/daily/5day/loc');
    expect(requested).toContain('apikey=key');
  });

  it('degrades a non-OK response to a flagged error, never a throw', async () => {
    const client = new WeatherClient(config, log, async () => jsonResponse({}, 503));
    const result = await client.forecast(['2026-08-10']);
    expect(result.days).toEqual([]);
    expect(result.error).toContain('HTTP 503');
  });

  it('degrades a transport failure the same way', async () => {
    const client = new WeatherClient(config, log, async () => {
      throw new Error('ENOTFOUND');
    });
    const result = await client.forecast(['2026-08-10']);
    expect(result.error).toContain('ENOTFOUND');
  });
});
