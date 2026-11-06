import { describe, expect, it } from 'bun:test';
import {
  buildBlocks,
  clipBlocks,
  completeThrough,
  compareOwnership,
  computeEngagement,
  dedupePrompts,
  engagementMargins,
  isValidTimeZone,
  localDays,
  parseDayStart,
  parseLocalDate,
  startOfLocalDay,
  type EngagementEvent,
  type EngagementSessionMeta,
} from './engagement.js';
import { classifyPrompt } from './prompt-classifier.js';

const MIN = 60_000;
const BLOCK = 15 * MIN;
const GAP = 15 * MIN;
const FAR_FUTURE = Date.UTC(2100, 0, 1);
const NY = 'America/New_York';

const at = (isoLocalAsUtc: string): number => new Date(isoLocalAsUtc).getTime();
const day = (date: string): number => parseLocalDate(date)!;

function meta(projectPath: string | null, started = '2026-01-01T00:00:00Z', ended: string | null = null): EngagementSessionMeta {
  return {
    title: null,
    sessionName: null,
    projectPath,
    projectName: projectPath?.split('/').pop() ?? null,
    startedMs: at(started),
    endedMs: ended ? at(ended) : null,
  };
}
let uuidCounter = 0;
const human = (sessionId: string, ts: string, uuid?: string): EngagementEvent => ({
  sessionId,
  uuid: uuid ?? `u${++uuidCounter}`,
  tsMs: at(ts),
  automatedBy: null,
});
const auto = (sessionId: string, ts: string, rule: EngagementEvent['automatedBy'] = 'loop'): EngagementEvent => ({
  sessionId,
  uuid: `u${++uuidCounter}`,
  tsMs: at(ts),
  automatedBy: rule,
});

function run(
  events: EngagementEvent[],
  sessions: Record<string, string | null>,
  from: string,
  to: string,
  tz = NY,
  nowMs = FAR_FUTURE,
  opts: { dayStart?: string; includeBlocks?: boolean } = {}
) {
  return computeEngagement(
    events,
    new Map(Object.entries(sessions).map(([id, p]) => [id, meta(p)])),
    {
      days: localDays(day(from), day(to), tz, parseDayStart(opts.dayStart ?? '00:00')!),
      blockMs: BLOCK,
      gapMs: GAP,
      nowMs,
      includeBlocks: opts.includeBlocks,
    }
  );
}

const iso = (ms: number): string => new Date(ms).toISOString();

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
    const events = [0, 60, 120].map((m) => ({ sessionId: 'a', uuid: null, tsMs: base + m * MIN, automatedBy: null }) as EngagementEvent);
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

describe('one prompt, one owner', () => {
  it('a resumed session replaying its own history counts each uuid once', () => {
    const events = [human('a', '2026-09-17T14:00:00Z', 'p1'), human('a', '2026-09-17T14:00:00Z', 'p1'), human('a', '2026-09-17T14:20:00Z', 'p2')];
    const [d] = run(events, { a: '/repos/x' }, '2026-09-17', '2026-09-17');
    expect(d!.human_prompt_count).toBe(2);
    expect(d!.sessions[0]!.human_prompt_count).toBe(2);
  });

  it('a fork carries its parent\'s turns: they count once, for the parent, and the fork covers only what it originated', () => {
    // Parent `p` ran 10:00–10:20 local and stopped when the fork `f` opened;
    // `f` copies those three turns (same uuids, same timestamps) and adds its
    // own the next day.
    const shared = [
      ['2026-09-17T14:00:00Z', 's1'],
      ['2026-09-17T14:10:00Z', 's2'],
      ['2026-09-17T14:20:00Z', 's3'],
    ] as const;
    const events = [
      ...shared.map(([ts, id]) => human('p', ts, id)),
      ...shared.map(([ts, id]) => human('f', ts, id)),
      human('f', '2026-09-18T15:00:00Z', 'f1'),
      human('f', '2026-09-18T15:10:00Z', 'f2'),
    ];
    const sessions = new Map<string, EngagementSessionMeta>([
      ['p', meta('/repos/x', '2026-09-17T14:00:00Z', '2026-09-17T14:21:00Z')],
      ['f', meta('/repos/x', '2026-09-17T14:00:00Z', '2026-09-18T15:11:00Z')], // same start: the copies
    ]);
    const days = computeEngagement(events, sessions, {
      days: localDays(day('2026-09-17'), day('2026-09-18'), NY),
      blockMs: BLOCK,
      gapMs: GAP,
      nowMs: FAR_FUTURE,
    });
    const [d17, d18] = days;
    expect(d17!.human_prompt_count).toBe(3); // not 6
    expect(d17!.envelope_minutes).toBe(35);
    expect(d17!.projects[0]).toMatchObject({ human_prompt_count: 3, human_minutes: 35 });
    expect(d17!.sessions.map((s) => s.id)).toEqual(['p']); // the fork did not exist yet
    expect(d17!.sessions[0]).toMatchObject({ human_prompt_count: 3, human_minutes: 35 });
    expect(d18!.sessions.map((s) => [s.id, s.human_prompt_count, s.human_minutes])).toEqual([['f', 2, 25]]);
  });

  it('ownership falls back to end time, then id; events without a uuid are their own prompt', () => {
    const a = { id: 'a', startedMs: 0, endedMs: 50 };
    const b = { id: 'b', startedMs: 0, endedMs: null };
    const c = { id: 'c', startedMs: 0, endedMs: 50 };
    expect(compareOwnership(a, b)).toBeLessThan(0); // ended first wins over still open
    expect(compareOwnership(a, c)).toBeLessThan(0); // then lowest id
    expect(compareOwnership({ id: 'z', startedMs: -1, endedMs: null }, a)).toBeLessThan(0); // started first wins

    const sessions = new Map([['a', meta(null, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')], ['b', meta(null)]]);
    const kept = dedupePrompts(
      [
        { sessionId: 'b', uuid: 'x', tsMs: 1, automatedBy: null },
        { sessionId: 'a', uuid: 'x', tsMs: 1, automatedBy: null },
        { sessionId: 'b', uuid: null, tsMs: 2, automatedBy: null },
        { sessionId: 'a', uuid: null, tsMs: 2, automatedBy: null },
      ],
      sessions
    );
    expect(kept.map((e) => [e.sessionId, e.uuid])).toEqual([['a', 'x'], ['b', null], ['a', null]]);
  });
});

describe('day_start', () => {
  it('parses only HH:MM from 00:00 to 23:59', () => {
    expect(parseDayStart('00:00')).toBe(0);
    expect(parseDayStart('04:30')).toBe(270);
    expect(parseDayStart('23:59')).toBe(1439);
    for (const bad of ['24:00', '4:00', 'ab:cd', '04:60', '04:00:00', '']) expect(parseDayStart(bad)).toBeNull();
  });

  it('a prompt at 01:30 counts toward the previous day with day_start=04:00, the same day by default', () => {
    // 01:30 EDT on 2026-09-10 = 05:30Z.
    const events = [human('a', '2026-09-10T05:30:00Z')];
    const rolled = run(events, { a: '/r/x' }, '2026-09-09', '2026-09-10', NY, FAR_FUTURE, { dayStart: '04:00' });
    expect(rolled.map((d) => [d.date, d.envelope_minutes, d.human_prompt_count])).toEqual([
      ['2026-09-09', 15, 1],
      ['2026-09-10', 0, 0],
    ]);
    expect(rolled[0]!.starts_at).toBe('2026-09-09T08:00:00.000Z');
    expect(rolled[0]!.ends_at).toBe('2026-09-10T08:00:00.000Z');
    const plain = run(events, { a: '/r/x' }, '2026-09-09', '2026-09-10');
    expect(plain.map((d) => [d.date, d.envelope_minutes, d.human_prompt_count])).toEqual([
      ['2026-09-09', 0, 0],
      ['2026-09-10', 15, 1],
    ]);
  });

  it('a block crossing the day_start boundary is split there', () => {
    // 03:55 EDT = 07:55Z; boundary at 04:00 EDT = 08:00Z.
    const days = run([human('a', '2026-09-10T07:55:00Z')], { a: null }, '2026-09-09', '2026-09-10', NY, FAR_FUTURE, {
      dayStart: '04:00',
      includeBlocks: true,
    });
    expect(days.map((d) => d.envelope_minutes)).toEqual([5, 10]);
    expect(days[0]!.blocks).toEqual([{ start: '2026-09-10T07:55:00.000Z', end: '2026-09-10T08:00:00.000Z' }]);
    expect(days[1]!.blocks).toEqual([{ start: '2026-09-10T08:00:00.000Z', end: '2026-09-10T08:10:00.000Z' }]);
  });

  it('spring forward: a day_start inside the skipped hour resolves to the first instant after the gap', () => {
    // 2026-03-08 02:00 EST jumps to 03:00 EDT; 02:30 does not exist.
    expect(iso(startOfLocalDay(day('2026-03-08'), NY, 150))).toBe('2026-03-08T07:00:00.000Z');
    const days = localDays(day('2026-03-07'), day('2026-03-09'), NY, 150);
    expect(days.map((d) => (d.endMs - d.startMs) / 3_600_000)).toEqual([23.5, 23.5, 24]);
    // Boundaries chain with no hole and no overlap.
    expect(days[0]!.endMs).toBe(days[1]!.startMs);
    expect(days[1]!.endMs).toBe(days[2]!.startMs);
  });

  it('spring forward: a whole-hour day_start before the gap gives a 23h day', () => {
    const days = localDays(day('2026-03-07'), day('2026-03-08'), NY, 60);
    expect(days.map((d) => (d.endMs - d.startMs) / 3_600_000)).toEqual([24, 23]);
  });

  it('fall back: a day_start inside the repeated hour is its first occurrence', () => {
    // 2026-11-01 01:30 happens twice; the first is EDT = 05:30Z.
    expect(iso(startOfLocalDay(day('2026-11-01'), NY, 90))).toBe('2026-11-01T05:30:00.000Z');
    const days = localDays(day('2026-10-31'), day('2026-11-02'), NY, 90);
    expect(days.map((d) => (d.endMs - d.startMs) / 3_600_000)).toEqual([24, 25, 24]);
  });

  it('across a transition every block minute is counted exactly once', () => {
    // A long run of prompts spanning the fall-back repeated hour.
    const events: EngagementEvent[] = [];
    for (let t = at('2026-11-01T03:00:00Z'); t < at('2026-11-01T09:00:00Z'); t += 10 * MIN) {
      events.push({ sessionId: 'a', uuid: `u${++uuidCounter}`, tsMs: t, automatedBy: null });
    }
    const total = (dayStart: string) =>
      run(events, { a: null }, '2026-10-31', '2026-11-02', NY, FAR_FUTURE, { dayStart }).reduce(
        (sum, d) => sum + d.envelope_minutes,
        0
      );
    // One merged block: 03:00Z to 08:50Z + 15 min.
    expect(total('00:00')).toBe(6 * 60 + 5);
    expect(total('01:30')).toBe(6 * 60 + 5);
    expect(total('04:00')).toBe(6 * 60 + 5);
  });

  it("a day's figures do not depend on the window, with a non-default day_start", () => {
    const events = [human('a', '2026-09-10T07:50:00Z'), human('a', '2026-09-10T08:05:00Z'), human('a', '2026-09-10T12:00:00Z')];
    const wide = run(events, { a: null }, '2026-09-08', '2026-09-11', NY, FAR_FUTURE, { dayStart: '04:00', includeBlocks: true });
    for (const date of ['2026-09-09', '2026-09-10']) {
      const narrow = run(events, { a: null }, date, date, NY, FAR_FUTURE, { dayStart: '04:00', includeBlocks: true });
      expect(narrow[0]).toEqual(wide.find((d) => d.date === date)!);
    }
  });
});

describe('time blocks', () => {
  it('clips to the interval and drops empty pieces', () => {
    const blocks = [
      { startMs: 0, endMs: 10 },
      { startMs: 20, endMs: 40 },
    ];
    expect(clipBlocks(blocks, 5, 30)).toEqual([
      { startMs: 5, endMs: 10 },
      { startMs: 20, endMs: 30 },
    ]);
    expect(clipBlocks(blocks, 10, 20)).toEqual([]);
  });

  it('day blocks are ordered, disjoint, and sum to the envelope; project blocks may overlap across projects', () => {
    const events = [
      human('a', '2026-09-17T14:00:00Z'),
      human('b', '2026-09-17T14:05:00Z'),
      human('a', '2026-09-17T14:20:00Z'),
      human('b', '2026-09-17T18:00:00Z'),
    ];
    const [d] = run(events, { a: '/r/x', b: '/r/y' }, '2026-09-17', '2026-09-17', NY, FAR_FUTURE, { includeBlocks: true });
    expect(d!.blocks).toEqual([
      { start: '2026-09-17T14:00:00.000Z', end: '2026-09-17T14:35:00.000Z' },
      { start: '2026-09-17T18:00:00.000Z', end: '2026-09-17T18:15:00.000Z' },
    ]);
    const sum = d!.blocks!.reduce((s, b) => s + (Date.parse(b.end) - Date.parse(b.start)), 0) / MIN;
    expect(sum).toBe(d!.envelope_minutes);
    const x = d!.projects.find((p) => p.project_path === '/r/x')!;
    const y = d!.projects.find((p) => p.project_path === '/r/y')!;
    // x: 14:00-14:15 and 14:20-14:35 (gap 5 <= 15 merges) = one block.
    expect(x.blocks).toEqual([{ start: '2026-09-17T14:00:00.000Z', end: '2026-09-17T14:35:00.000Z' }]);
    expect(y.blocks).toEqual([
      { start: '2026-09-17T14:05:00.000Z', end: '2026-09-17T14:20:00.000Z' },
      { start: '2026-09-17T18:00:00.000Z', end: '2026-09-17T18:15:00.000Z' },
    ]);
    // Projects overlap each other (14:05-14:20 sits inside x's block).
  });

  it('a block crossing midnight appears as two clipped pieces, and none extends past now', () => {
    // 23:50 EDT on the 17th; "now" is 03:57Z (23:57 local).
    const nowMs = at('2026-09-18T03:57:00Z');
    const days = run([human('a', '2026-09-18T03:50:00Z')], { a: null }, '2026-09-17', '2026-09-18', NY, nowMs, {
      includeBlocks: true,
    });
    expect(days[0]!.blocks).toEqual([{ start: '2026-09-18T03:50:00.000Z', end: '2026-09-18T03:57:00.000Z' }]);
    expect(days[1]!.blocks).toEqual([]);

    const later = run([human('a', '2026-09-18T03:50:00Z')], { a: null }, '2026-09-17', '2026-09-18', NY, FAR_FUTURE, {
      includeBlocks: true,
    });
    expect(later[0]!.blocks![0]!.end).toBe(later[1]!.blocks![0]!.start);
    expect(later[1]!.blocks![0]!.start).toBe(later[1]!.starts_at);
  });

  it('omits blocks unless asked', () => {
    const [d] = run([human('a', '2026-09-17T14:00:00Z')], { a: '/r/x' }, '2026-09-17', '2026-09-17');
    expect('blocks' in d!).toBe(false);
    expect('blocks' in d!.projects[0]!).toBe(false);
  });
});

describe('hand-backs', () => {
  it('a session whose only queued prompts are hand-backs and task notifications has 0 human minutes', () => {
    const rule = (head: string) => classifyPrompt({ head, isMeta: false, isSidechain: false, isCompactSummary: false });
    const heads = [
      '<agent-message agent="x">report</agent-message>',
      '<task-notification>\n<task-id>1</task-id>',
      '<agent-message agent="y">another</agent-message>',
    ];
    const events: EngagementEvent[] = heads.map((h, i) => ({
      sessionId: 'orch',
      uuid: `u${++uuidCounter}`,
      tsMs: at('2026-09-17T14:00:00Z') + i * 20 * MIN,
      automatedBy: rule(h),
    }));
    expect(events.map((e) => e.automatedBy)).toEqual(['handback', 'task-notification', 'handback']);
    const [d] = run(events, { orch: '/r/x' }, '2026-09-17', '2026-09-17');
    expect(d!.envelope_minutes).toBe(0);
    expect(d!.projects).toEqual([]);
    expect(d!.sessions[0]).toMatchObject({ id: 'orch', human_minutes: 0, automated_by: { handback: 2, 'task-notification': 1 } });
  });
});

describe('completeThrough', () => {
  it('is the earliest clean sync, null when any is null or there are none', () => {
    expect(completeThrough(['2026-09-17T10:00:00.000Z', '2026-09-16T10:00:00.000Z'])).toBe('2026-09-16T10:00:00.000Z');
    expect(completeThrough(['2026-09-17T10:00:00.000Z', null])).toBeNull();
    expect(completeThrough([])).toBeNull();
  });
});
