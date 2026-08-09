/**
 * Today's training, read from the training module's tables (claude-assist
 * Postgres).
 *
 * Follows the kitchen/captures source pattern: a direct read of the sibling
 * module's schema, no import of @jarvus/claude-assist-training. That is what
 * keeps the dependency acyclic — the training module imports this package's
 * calendar-read boundary, so an import back the other way would close a loop.
 *
 * Only an ACTIVE plan renders. A week still sitting in `proposed` is one a
 * human hasn't approved yet, and showing it in the briefing as though it were
 * the plan would quietly convert an async gate into a fait accompli.
 *
 * Every failure degrades to `available: false` — a missing training schema is
 * the normal state on an instance that doesn't run the module, and it must
 * read as absence, not as an error worth a line in the briefing.
 */

import type postgres from 'postgres';

/** One planned session, as stored by the training module. */
export interface TrainingSession {
  date: string;
  kind: string;
  title: string;
  detail: string;
  distanceMiles: number | null;
  durationMinutes: number | null;
  why: string;
  venue: string;
}

export interface TrainingSummary {
  /** False when the module isn't installed, has no active week, or errored. */
  available: boolean;
  /** Monday of the active plan week. */
  weekStart: string | null;
  /** The active week's one-line headline. */
  weekSummary: string;
  /** Today's session, when the active week speaks to today. */
  today: TrainingSession | null;
  /** Sessions later in the week — the two-day look-ahead. */
  upcoming: TrainingSession[];
  /** A week awaiting approval, surfaced so a forgotten gate is visible. */
  pendingWeekStart: string | null;
  error: string | null;
}

export const EMPTY_TRAINING: TrainingSummary = {
  available: false,
  weekStart: null,
  weekSummary: '',
  today: null,
  upcoming: [],
  pendingWeekStart: null,
  error: null,
};

export interface TrainingSummaryOptions {
  dateIso: string;
  /** Days ahead to include in the look-ahead (default 2). */
  lookaheadDays?: number;
}

export async function fetchTrainingSummary(
  sql: postgres.Sql,
  opts: TrainingSummaryOptions
): Promise<TrainingSummary> {
  try {
    const [active] = await sql<
      { week_start: string; summary: string; sessions: unknown }[]
    >`
      SELECT week_start::text AS week_start, summary, sessions
      FROM training.week_plans
      WHERE status = 'active'
        AND week_start <= ${opts.dateIso}::date
        AND week_start + 6 >= ${opts.dateIso}::date
      ORDER BY week_start DESC
      LIMIT 1
    `;

    // A pending proposal is worth one line even with an active week: it is how
    // an unanswered gate becomes visible without a second notification.
    const [pending] = await sql<{ week_start: string }[]>`
      SELECT week_start::text AS week_start
      FROM training.week_plans
      WHERE status = 'proposed'
      ORDER BY week_start ASC
      LIMIT 1
    `;

    if (!active) {
      return { ...EMPTY_TRAINING, pendingWeekStart: pending?.week_start ?? null };
    }

    const sessions = parseSessions(active.sessions);
    const horizon = addDays(opts.dateIso, opts.lookaheadDays ?? 2);

    return {
      available: true,
      weekStart: active.week_start,
      weekSummary: active.summary ?? '',
      today: sessions.find((s) => s.date === opts.dateIso) ?? null,
      upcoming: sessions.filter((s) => s.date > opts.dateIso && s.date <= horizon),
      pendingWeekStart: pending?.week_start ?? null,
      error: null,
    };
  } catch {
    // Absent schema / absent module — indistinguishable, and both mean the
    // section simply doesn't appear.
    return { ...EMPTY_TRAINING };
  }
}

/** Exported for tests. */
export function parseSessions(value: unknown): TrainingSession[] {
  const raw =
    typeof value === 'string'
      ? (safeJson(value) as unknown)
      : value;
  if (!Array.isArray(raw)) return [];
  const out: TrainingSession[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const s = entry as Record<string, unknown>;
    if (typeof s.date !== 'string' || typeof s.title !== 'string') continue;
    out.push({
      date: s.date,
      kind: typeof s.kind === 'string' ? s.kind : 'run',
      title: s.title,
      detail: typeof s.detail === 'string' ? s.detail : '',
      distanceMiles: typeof s.distanceMiles === 'number' ? s.distanceMiles : null,
      durationMinutes: typeof s.durationMinutes === 'number' ? s.durationMinutes : null,
      why: typeof s.why === 'string' ? s.why : '',
      venue: typeof s.venue === 'string' ? s.venue : 'either',
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

function addDays(dateIso: string, days: number): string {
  const ms = Date.parse(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(ms)) return dateIso;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
