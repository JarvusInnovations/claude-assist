import { describe, expect, it } from 'bun:test';
import {
  buildBlocks,
  computeEngagement,
  engagementMargins,
  isValidTimeZone,
  localDays,
  parseLocalDate,
  startOfLocalDay,
  type EngagementEvent,
  type EngagementSessionMeta,
} from './engagement.js';

const MIN = 60_000;
const BLOCK = 15 * MIN;
const GAP = 15 * MIN;
const FAR_FUTURE = Date.UTC(2100, 0, 1);
const NY = 'America/New_York';

const at = (isoLocalAsUtc: string): number => new Date(isoLocalAsUtc).getTime();
const day = (date: string): number => parseLocalDate(date)!;

function meta(projectPath: string | null): EngagementSessionMeta {
  return { title: null, sessionName: null, projectPath, projectName: projectPath?.split('/').pop() ?? null };
}
const human = (sessionId: string, ts: string): EngagementEvent => ({ sessionId, tsMs: at(ts), automatedBy: null });
const auto = (sessionId: string, ts: string, rule: EngagementEvent['automatedBy'] = 'loop'): EngagementEvent => ({
  sessionId,
  tsMs: at(ts),
  automatedBy: rule,
});

function run(events: EngagementEvent[], sessions: Record<string, string | null>, from: string, to: string, tz = NY, nowMs = FAR_FUTURE) {
  return computeEngagement(
    events,
    new Map(Object.entries(sessions).map(([id, p]) => [id, meta(p)])),
    { days: localDays(day(from), day(to), tz), blockMs: BLOCK, gapMs: GAP, nowMs }
  );
}

describe('local days', () => {
  it('parses only real calendar dates', () => {
    expect(parseLocalDate('2026-09-17')).toBe(Date.UTC(2026, 8, 17));
    expect(parseLocalDate('2026-02-30')).toBeNull();
    expect(parseLocalDate('2026-9-17')).toBeNull();
    expect(parseLocalDate('nope')).toBeNull();
  });

  it('validates IANA zones', () => {
    expect(isValidTimeZone(NY)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
  });

  it('finds local midnight on either side of a DST transition', () => {
    expect(new Date(startOfLocalDay(day('2026-07-01'), NY)).toISOString()).toBe('2026-07-01T04:00:00.000Z');
    expect(new Date(startOfLocalDay(day('2026-12-01'), NY)).toISOString()).toBe('2026-12-01T05:00:00.000Z');
    expect(new Date(startOfLocalDay(day('2026-07-01'), 'Asia/Kolkata')).toISOString()).toBe('2026-06-30T18:30:00.000Z');
  });

  it('gives transition days their true length', () => {
    const hours = (date: string) => {
      const [d] = localDays(day(date), day(date), NY);
      return (d!.endMs - d!.startMs) / 3_600_000;
    };
    expect(hours('2026-03-08')).toBe(23); // spring forward
    expect(hours('2026-11-01')).toBe(25); // fall back
    expect(hours('2026-09-17')).toBe(24);
  });

  it('starts a day whose midnight is skipped at its first instant', () => {
    // America/Sao_Paulo 2018-11-04: 00:00 jumped straight to 01:00.
    const start = startOfLocalDay(day('2018-11-04'), 'America/Sao_Paulo');
    expect(new Date(start).toISOString()).toBe('2018-11-04T03:00:00.000Z');
  });
});

describe('buildBlocks', () => {
  it('opens a block per prompt and merges across gaps up to the limit', () => {
    const t0 = at('2026-09-17T14:00:00Z');
    // 10:00 and 10:25 → gap between blocks is 10 min → one 40-minute block.
    expect(buildBlocks([t0 + 25 * MIN, t0], BLOCK, GAP, FAR_FUTURE)).toEqual([{ startMs: t0, endMs: t0 + 40 * MIN }]);
    // Gap of exactly 15 min merges; 16 does not.
    expect(buildBlocks([t0, t0 + 30 * MIN], BLOCK, GAP, FAR_FUTURE)).toHaveLength(1);
    expect(buildBlocks([t0, t0 + 31 * MIN], BLOCK, GAP, FAR_FUTURE)).toHaveLength(2);
  });

  it('never extends a block past now', () => {
    const t0 = at('2026-09-17T14:00:00Z');
    expect(buildBlocks([t0], BLOCK, GAP, t0 + 4 * MIN)).toEqual([{ startMs: t0, endMs: t0 + 4 * MIN }]);
  });
});

describe('computeEngagement', () => {
  it('a session of only loop firings and task notifications has 0 human minutes but is listed', () => {
    const events = [
      auto('bot', '2026-09-17T14:00:00Z', 'loop'),
      auto('bot', '2026-09-17T14:20:00Z', 'loop'),
      auto('bot', '2026-09-17T14:40:00Z', 'task-notification'),
    ];
    const [d] = run(events, { bot: '/repos/site' }, '2026-09-17', '2026-09-17');
    expect(d!.envelope_minutes).toBe(0);
    expect(d!.human_prompt_count).toBe(0);
    expect(d!.first_human_prompt).toBeNull();
    expect(d!.projects).toEqual([]);
    expect(d!.sessions).toHaveLength(1);
    expect(d!.sessions[0]).toMatchObject({
      id: 'bot',
      human_minutes: 0,
      human_prompt_count: 0,
      automated_minutes: 55,
      automated_prompt_count: 3,
      automated_by: { loop: 2, 'task-notification': 1 },
    });
  });

  it('two parallel sessions with interleaved prompts count the hour once', () => {
    const events: EngagementEvent[] = [];
    for (let m = 0; m < 60; m += 10) {
      const hh = `2026-09-17T14:${String(m).padStart(2, '0')}:00Z`;
      events.push(human(m % 20 === 0 ? 'a' : 'b', hh));
    }
    // a: :00 :20 :40, b: :10 :30 :50 → pooled block 14:00–15:05.
    const [d] = run(events, { a: '/repos/x', b: '/repos/x' }, '2026-09-17', '2026-09-17');
    expect(d!.envelope_minutes).toBe(65);
    expect(d!.projects).toEqual([
      expect.objectContaining({ project_path: '/repos/x', project_name: 'x', human_minutes: 65, human_prompt_count: 6 }),
    ]);
    // Parts are not additive: each session alone spans 55 minutes.
    expect(d!.sessions.map((s) => [s.id, s.human_minutes])).toEqual([
      ['a', 55],
      ['b', 55],
    ]);
  });

  it('pools across projects for the envelope but not for each project', () => {
    // A at 10:00, B (other project) at 10:25 local → one 40-minute envelope.
    const events = [human('a', '2026-09-17T14:00:00Z'), human('b', '2026-09-17T14:25:00Z')];
    const [d] = run(events, { a: '/repos/x', b: '/repos/y' }, '2026-09-17', '2026-09-17');
    expect(d!.envelope_minutes).toBe(40);
    expect(d!.projects.map((p) => p.human_minutes)).toEqual([15, 15]);
    expect(d!.first_human_prompt).toBe('2026-09-17T14:00:00.000Z');
    expect(d!.last_human_prompt).toBe('2026-09-17T14:25:00.000Z');
  });

  it('splits a block at local midnight in the requested zone', () => {
    // 23:50 EDT on 09-17 is 03:50Z on 09-18 — the UTC day would be wrong.
    const events = [human('a', '2026-09-18T03:50:00Z')];
    const days = run(events, { a: '/repos/x' }, '2026-09-17', '2026-09-18');
    expect(days.map((d) => [d.date, d.envelope_minutes, d.human_prompt_count])).toEqual([
      ['2026-09-17', 10, 1],
      ['2026-09-18', 5, 0],
    ]);
    // The session is listed on the day its block spills into, without a prompt there.
    expect(days[1]!.sessions[0]).toMatchObject({ id: 'a', human_minutes: 5, human_prompt_count: 0 });

    // Same instant bucketed in UTC lands wholly on the 18th.
    const utc = run(events, { a: '/repos/x' }, '2026-09-17', '2026-09-18', 'UTC');
    expect(utc.map((d) => d.envelope_minutes)).toEqual([0, 15]);
  });

  it('splits correctly across the fall-back transition', () => {
    // 2026-11-01 in New York is 25h long; midnight on 11-02 is 05:00Z.
    const events = [human('a', '2026-11-02T04:55:00Z')];
    const days = run(events, { a: null }, '2026-11-01', '2026-11-02');
    expect(days.map((d) => d.envelope_minutes)).toEqual([5, 10]);
  });

  it("a day's figures do not depend on the requested window", () => {
    const events = [
      human('a', '2026-09-17T03:52:00Z'), // 23:52 on the 16th: spills 7 min into the 17th
      human('a', '2026-09-17T15:00:00Z'),
      human('a', '2026-09-18T03:40:00Z'), // 23:40 on the 17th
      human('a', '2026-09-18T04:05:00Z'), // 00:05 on the 18th: bridges back to 23:55–24:00
    ];
    const sessions = { a: '/repos/x' };
    const wide = run(events, sessions, '2026-09-15', '2026-09-19').find((d) => d.date === '2026-09-17')!;
    const [narrow] = run(events, sessions, '2026-09-17', '2026-09-17');
    expect(narrow).toEqual(wide);
    expect(narrow!.envelope_minutes).toBe(7 + 15 + 20);
    expect(narrow!.human_prompt_count).toBe(2);

    // And the margins are what a query must widen by to make that true.
    const { beforeMs, afterMs } = engagementMargins(BLOCK, GAP);
    const start = localDays(day('2026-09-17'), day('2026-09-17'), NY)[0]!;
    expect(at('2026-09-17T03:52:00Z')).toBeGreaterThanOrEqual(start.startMs - beforeMs);
    expect(at('2026-09-18T04:05:00Z')).toBeLessThan(start.endMs + afterMs);
  });

  it('lists every day in the window, zeroed when empty, and rounds each figure once', () => {
    // Three isolated 20-second blocks (clamped by now): 60s total → 1 minute, not 0+0+0.
    const base = at('2026-09-17T14:00:00Z');
    const events = [0, 60, 120].map((m) => ({ sessionId: 'a', tsMs: base + m * MIN, automatedBy: null }) as EngagementEvent);
    const days = computeEngagement(events, new Map([['a', meta(null)]]), {
      days: localDays(day('2026-09-16'), day('2026-09-18'), NY),
      blockMs: 20_000,
      gapMs: 0,
      nowMs: FAR_FUTURE,
    });
    expect(days.map((d) => d.date)).toEqual(['2026-09-16', '2026-09-17', '2026-09-18']);
    expect(days[1]!.envelope_minutes).toBe(1);
    expect(days[0]).toMatchObject({ envelope_minutes: 0, human_prompt_count: 0, projects: [], sessions: [] });
  });
});
