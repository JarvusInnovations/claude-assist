/**
 * Pure computation behind `GET /sessions/engagement`
 * (specs/behaviors/session-engagement.md): engagement blocks from prompt
 * timestamps, local-day boundaries in an IANA zone, and the per-day rollup.
 * No database access — `routes.ts` owns the queries and calls these on the
 * rows it fetched.
 */

import type { AutomatedRule } from './prompt-classifier.js';

export const DEFAULT_BLOCK_MINUTES = 15;
export const DEFAULT_GAP_MINUTES = 15;
/** Longest window one request may cover, in local days (inclusive). */
export const MAX_ENGAGEMENT_DAYS = 92;

const MINUTE_MS = 60_000;

/** How far before the window a machine's last session may end and still be
 * listed as a source for it (spec: "Source freshness"). */
export const SOURCE_LOOKBACK_MS = 30 * 86_400_000;

/** `complete_through`: the earliest clean sync instant (ISO strings), or null
 * when any is null or there are none. */
export function completeThrough(cleanSyncs: readonly (string | null)[]): string | null {
  if (cleanSyncs.length === 0 || cleanSyncs.some((c) => c === null)) return null;
  return (cleanSyncs as string[]).reduce((min, c) => (Date.parse(c) < Date.parse(min) ? c : min));
}

// ── zones and local days ────────────────────────────────────────────────────

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The zone's wall-clock reading at `ms`, expressed as if it were UTC. */
function wallClockAsUtc(ms: number, tz: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10);
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
}

/** Parse `YYYY-MM-DD` into a UTC-midnight timestamp, or null if it isn't a
 * real calendar date. */
export function parseLocalDate(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const ms = Date.UTC(parseInt(m[1]!, 10), parseInt(m[2]!, 10) - 1, parseInt(m[3]!, 10));
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

/**
 * Parse a wall-clock `HH:MM` (`00:00`–`23:59`) into minutes after midnight, or
 * null if it isn't one.
 */
export function parseDayStart(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10) : null;
}

/**
 * The instant a logical day begins in `tz`: the wall-clock `dayStartMinutes`
 * (default midnight) on the date. Where a daylight-saving jump skips that
 * wall time the boundary is the first instant after the gap; where it repeats
 * it, the first occurrence. `dateUtcMs` is the date as a UTC-midnight
 * timestamp (see `parseLocalDate`).
 */
export function startOfLocalDay(dateUtcMs: number, tz: string, dayStartMinutes = 0): number {
  const target = dateUtcMs + dayStartMinutes * MINUTE_MS;
  // The zone's offset a day either side brackets any transition near `target`;
  // each candidate that really reads `target` is an occurrence of it.
  const offBefore = wallClockAsUtc(target - 86_400_000, tz) - (target - 86_400_000);
  const offAfter = wallClockAsUtc(target + 86_400_000, tz) - (target + 86_400_000);
  const hits = [target - offBefore, target - offAfter].filter((c) => wallClockAsUtc(c, tz) === target);
  if (hits.length > 0) return Math.min(...hits);

  // Skipped: walk to the first instant whose wall clock reaches `target`.
  const cands = [target - offBefore, target - offAfter];
  let lo = Math.min(...cands) - 3 * 3_600_000;
  let hi = Math.max(...cands) + 3 * 3_600_000;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    if (wallClockAsUtc(mid, tz) < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

export interface LocalDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Half-open `[startMs, endMs)`; 23 or 25 hours long across a transition. */
  startMs: number;
  endMs: number;
}

/** Every logical day from `fromUtcMs` to `toUtcMs` inclusive (both UTC-midnight
 * date stamps), with its true bounds in `tz`: each runs from `dayStartMinutes`
 * on its date to the same wall time on the next. */
export function localDays(fromUtcMs: number, toUtcMs: number, tz: string, dayStartMinutes = 0): LocalDay[] {
  const days: LocalDay[] = [];
  let start = startOfLocalDay(fromUtcMs, tz, dayStartMinutes);
  for (let d = fromUtcMs; d <= toUtcMs; d += 86_400_000) {
    const end = startOfLocalDay(d + 86_400_000, tz, dayStartMinutes);
    days.push({ date: new Date(d).toISOString().slice(0, 10), startMs: start, endMs: end });
    start = end;
  }
  return days;
}

// ── blocks ──────────────────────────────────────────────────────────────────

export interface Block {
  startMs: number;
  endMs: number;
}

/**
 * Engagement blocks from prompt timestamps (any order): each prompt opens a
 * block of `blockMs`; blocks whose gap is at most `gapMs` merge, covering the
 * gap; no block extends past `nowMs`.
 */
export function buildBlocks(timestamps: readonly number[], blockMs: number, gapMs: number, nowMs: number): Block[] {
  const sorted = [...timestamps].sort((a, b) => a - b);
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const ts of sorted) {
    if (cur && ts - cur.endMs <= gapMs) {
      cur.endMs = Math.max(cur.endMs, ts + blockMs);
    } else {
      cur = { startMs: ts, endMs: ts + blockMs };
      blocks.push(cur);
    }
  }
  for (const b of blocks) b.endMs = Math.max(b.startMs, Math.min(b.endMs, nowMs));
  return blocks;
}

/** Milliseconds of `blocks` (sorted, disjoint) falling inside `[startMs, endMs)`. */
export function overlapMs(blocks: readonly Block[], startMs: number, endMs: number): number {
  let total = 0;
  for (const b of blocks) {
    if (b.endMs <= startMs) continue;
    if (b.startMs >= endMs) break;
    total += Math.min(b.endMs, endMs) - Math.max(b.startMs, startMs);
  }
  return total;
}

/** The parts of `blocks` (sorted, disjoint) inside `[startMs, endMs)`, clipped
 * to it; empty pieces are dropped. */
export function clipBlocks(blocks: readonly Block[], startMs: number, endMs: number): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.endMs <= startMs) continue;
    if (b.startMs >= endMs) break;
    out.push({ startMs: Math.max(b.startMs, startMs), endMs: Math.min(b.endMs, endMs) });
  }
  return out;
}

/** Whole minutes from an exact duration — rounded once per figure. */
function toMinutes(ms: number): number {
  return Math.round(ms / MINUTE_MS);
}

// ── rollup ──────────────────────────────────────────────────────────────────

export interface EngagementEvent {
  sessionId: string;
  /** Message uuid — the prompt's identity across transcripts; null = unique. */
  uuid: string | null;
  tsMs: number;
  /** `null` = human; otherwise the rule that marked it automated. */
  automatedBy: AutomatedRule | null;
}

export interface EngagementSessionMeta {
  title: string | null;
  sessionName: string | null;
  projectPath: string | null;
  projectName: string | null;
  /** Ownership order (spec: "One prompt, one owner"). */
  startedMs: number;
  /** Null while the session has no recorded end — sorts last. */
  endedMs: number | null;
}

/** Ownership order: started first, then ended first, then lowest id. Negative
 * when `a` owns before `b`. */
export function compareOwnership(
  a: { id: string; startedMs: number; endedMs: number | null },
  b: { id: string; startedMs: number; endedMs: number | null }
): number {
  if (a.startedMs !== b.startedMs) return a.startedMs - b.startedMs;
  const ae = a.endedMs ?? Infinity;
  const be = b.endedMs ?? Infinity;
  if (ae !== be) return ae - be;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Collapse copies of one prompt (same uuid, within or across transcripts) to
 * the single event owned by the earliest session in ownership order. Events
 * without a uuid pass through. Output keeps the input's order.
 */
export function dedupePrompts(
  events: readonly EngagementEvent[],
  sessions: ReadonlyMap<string, EngagementSessionMeta>
): EngagementEvent[] {
  const owner = new Map<string, EngagementEvent>();
  const rank = (e: EngagementEvent) => {
    const m = sessions.get(e.sessionId);
    return { id: e.sessionId, startedMs: m?.startedMs ?? Infinity, endedMs: m?.endedMs ?? null };
  };
  for (const e of events) {
    if (e.uuid === null) continue;
    const cur = owner.get(e.uuid);
    if (!cur || compareOwnership(rank(e), rank(cur)) < 0) owner.set(e.uuid, e);
  }
  return events.filter((e) => e.uuid === null || owner.get(e.uuid) === e);
}

interface HumanStats {
  human_minutes: number;
  human_prompt_count: number;
  first_human_prompt: string | null;
  last_human_prompt: string | null;
}

export interface TimeBlock {
  /** ISO instants (UTC). */
  start: string;
  end: string;
}

export interface EngagementProject extends HumanStats {
  project_path: string | null;
  project_name: string | null;
  /** Only with `includeBlocks`. */
  blocks?: TimeBlock[];
}

export interface EngagementSession extends HumanStats {
  id: string;
  title: string | null;
  session_name: string | null;
  project_path: string | null;
  project_name: string | null;
  automated_minutes: number;
  automated_prompt_count: number;
  automated_by: Partial<Record<AutomatedRule, number>>;
}

export interface EngagementDay {
  date: string;
  /** The day's boundaries as ISO instants. */
  starts_at: string;
  ends_at: string;
  envelope_minutes: number;
  /** Only with `includeBlocks`: the envelope's blocks, clipped to the day. */
  blocks?: TimeBlock[];
  human_prompt_count: number;
  first_human_prompt: string | null;
  last_human_prompt: string | null;
  projects: EngagementProject[];
  sessions: EngagementSession[];
}

export interface EngagementParams {
  days: readonly LocalDay[];
  blockMs: number;
  gapMs: number;
  nowMs: number;
  /** Return the merged, clipped blocks on each day and project. */
  includeBlocks?: boolean;
}

/** How far outside the window prompts can still change a day's figures: a
 * prompt this long before the first midnight can run a block across it, and
 * one this long after the last can bridge a gap back into the final day.
 * Fetching this margin is what makes a day's figures window-independent. */
export function engagementMargins(blockMs: number, gapMs: number): { beforeMs: number; afterMs: number } {
  return { beforeMs: blockMs + gapMs, afterMs: gapMs };
}

const iso = (ms: number): string => new Date(ms).toISOString();
const toTimeBlocks = (blocks: readonly Block[]): TimeBlock[] => blocks.map((b) => ({ start: iso(b.startMs), end: iso(b.endMs) }));

function dayIndexOf(days: readonly LocalDay[], tsMs: number): number {
  let lo = 0;
  let hi = days.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = days[mid]!;
    if (tsMs < d.startMs) hi = mid - 1;
    else if (tsMs >= d.endMs) lo = mid + 1;
    else return mid;
  }
  return -1;
}

interface Tally {
  count: number;
  firstMs: number | null;
  lastMs: number | null;
}
const emptyTally = (): Tally => ({ count: 0, firstMs: null, lastMs: null });
function tally(t: Tally, tsMs: number): void {
  t.count++;
  if (t.firstMs === null || tsMs < t.firstMs) t.firstMs = tsMs;
  if (t.lastMs === null || tsMs > t.lastMs) t.lastMs = tsMs;
}
function humanStats(blocks: readonly Block[], day: LocalDay, t: Tally | undefined): HumanStats {
  return {
    human_minutes: toMinutes(overlapMs(blocks, day.startMs, day.endMs)),
    human_prompt_count: t?.count ?? 0,
    first_human_prompt: t?.firstMs != null ? iso(t.firstMs) : null,
    last_human_prompt: t?.lastMs != null ? iso(t.lastMs) : null,
  };
}

/**
 * Roll classified prompt events up into per-day figures. `rawEvents` must
 * cover the window widened by `engagementMargins`; events outside the days
 * themselves shape blocks but are never counted as that window's prompts.
 * Copies of one prompt collapse to its owner first (`dedupePrompts`).
 *
 * The three minute figures pool prompts at different scopes *before* merging
 * (day: all sessions; project: its sessions; session: itself), so they are
 * deliberately not additive — see the spec's table.
 */
export function computeEngagement(
  rawEvents: readonly EngagementEvent[],
  sessions: ReadonlyMap<string, EngagementSessionMeta>,
  params: EngagementParams
): EngagementDay[] {
  const { days, blockMs, gapMs, nowMs, includeBlocks = false } = params;
  const events = dedupePrompts(rawEvents, sessions);
  const projectKey = (sessionId: string): string => sessions.get(sessionId)?.projectPath ?? '';

  const allHuman: number[] = [];
  const projectHuman = new Map<string, number[]>();
  const sessionHuman = new Map<string, number[]>();
  const sessionAutomated = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, v: number): void => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };

  // Per-day tallies of the prompts that fall on each day.
  const dayTally = days.map(emptyTally);
  const projectTally = days.map(() => new Map<string, Tally>());
  const sessionTally = days.map(() => new Map<string, Tally>());
  const sessionAutoCounts = days.map(() => new Map<string, Partial<Record<AutomatedRule, number>>>());
  const tallyIn = (m: Map<string, Tally>, k: string, tsMs: number): void => {
    let t = m.get(k);
    if (!t) m.set(k, (t = emptyTally()));
    tally(t, tsMs);
  };

  for (const e of events) {
    const di = dayIndexOf(days, e.tsMs);
    if (e.automatedBy === null) {
      allHuman.push(e.tsMs);
      push(projectHuman, projectKey(e.sessionId), e.tsMs);
      push(sessionHuman, e.sessionId, e.tsMs);
      if (di >= 0) {
        tally(dayTally[di]!, e.tsMs);
        tallyIn(projectTally[di]!, projectKey(e.sessionId), e.tsMs);
        tallyIn(sessionTally[di]!, e.sessionId, e.tsMs);
      }
    } else {
      push(sessionAutomated, e.sessionId, e.tsMs);
      if (di >= 0) {
        const m = sessionAutoCounts[di]!;
        let counts = m.get(e.sessionId);
        if (!counts) m.set(e.sessionId, (counts = {}));
        counts[e.automatedBy] = (counts[e.automatedBy] ?? 0) + 1;
      }
    }
  }

  const blocksOf = (m: Map<string, number[]>): Map<string, Block[]> =>
    new Map([...m].map(([k, ts]) => [k, buildBlocks(ts, blockMs, gapMs, nowMs)]));
  const envelope = buildBlocks(allHuman, blockMs, gapMs, nowMs);
  const projectBlocks = blocksOf(projectHuman);
  const sessionBlocks = blocksOf(sessionHuman);
  const sessionAutoBlocks = blocksOf(sessionAutomated);
  const sessionIds = new Set([...sessionHuman.keys(), ...sessionAutomated.keys()]);

  return days.map((day, di) => {
    const projects: EngagementProject[] = [];
    for (const [key, blocks] of projectBlocks) {
      const stats = humanStats(blocks, day, projectTally[di]!.get(key));
      if (stats.human_minutes === 0 && stats.human_prompt_count === 0) continue;
      const anySession = [...sessions.values()].find((s) => (s.projectPath ?? '') === key);
      projects.push({
        project_path: key === '' ? null : key,
        project_name: anySession?.projectName ?? null,
        ...stats,
        ...(includeBlocks ? { blocks: toTimeBlocks(clipBlocks(blocks, day.startMs, day.endMs)) } : {}),
      });
    }
    projects.sort((a, b) => b.human_minutes - a.human_minutes || (a.project_path ?? '').localeCompare(b.project_path ?? ''));

    const daySessions: EngagementSession[] = [];
    for (const id of sessionIds) {
      const stats = humanStats(sessionBlocks.get(id) ?? [], day, sessionTally[di]!.get(id));
      const automatedBy = sessionAutoCounts[di]!.get(id) ?? {};
      const automatedCount = Object.values(automatedBy).reduce((sum, n) => sum + (n ?? 0), 0);
      const automatedMinutes = toMinutes(overlapMs(sessionAutoBlocks.get(id) ?? [], day.startMs, day.endMs));
      if (stats.human_minutes === 0 && stats.human_prompt_count === 0 && automatedCount === 0 && automatedMinutes === 0) {
        continue;
      }
      const meta = sessions.get(id);
      daySessions.push({
        id,
        title: meta?.title ?? null,
        session_name: meta?.sessionName ?? null,
        project_path: meta?.projectPath ?? null,
        project_name: meta?.projectName ?? null,
        ...stats,
        automated_minutes: automatedMinutes,
        automated_prompt_count: automatedCount,
        automated_by: automatedBy,
      });
    }
    daySessions.sort(
      (a, b) =>
        b.human_minutes - a.human_minutes || b.automated_minutes - a.automated_minutes || a.id.localeCompare(b.id)
    );

    const t = dayTally[di]!;
    return {
      date: day.date,
      starts_at: iso(day.startMs),
      ends_at: iso(day.endMs),
      envelope_minutes: toMinutes(overlapMs(envelope, day.startMs, day.endMs)),
      ...(includeBlocks ? { blocks: toTimeBlocks(clipBlocks(envelope, day.startMs, day.endMs)) } : {}),
      human_prompt_count: t.count,
      first_human_prompt: t.firstMs !== null ? iso(t.firstMs) : null,
      last_human_prompt: t.lastMs !== null ? iso(t.lastMs) : null,
      projects,
      sessions: daySessions,
    };
  });
}
