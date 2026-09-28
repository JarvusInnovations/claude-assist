import { createHash } from 'node:crypto';
import type postgres from 'postgres';

/**
 * Chapter rollups for windowed outlines.
 *
 * specs/behaviors/session-outlines.md's "Rollups" section is the governing
 * spec: composing every window summary of a long-running session in one call
 * does not scale, so summaries form a hierarchy with fan-in
 * `SESSIONS_OUTLINE_ROLLUP_FANIN` - each run of `fanin` consecutive closed,
 * resolved windows becomes a level-1 "chapter," each run of `fanin`
 * consecutive closed level-(n-1) rollups becomes a level-n rollup, and the
 * compose call reads only the top of this tree plus whatever hasn't been
 * grouped yet - bounded to roughly `fanin` items per level regardless of how
 * long the session runs.
 *
 * Rollups are closed-by-construction, unlike `sessions.outline_windows`: a
 * row is only ever inserted once every child in its range is itself closed
 * and resolved (summarized or failed). There is no "open tail" rollup, so
 * unlike `OutlineWindowStore` there is no upsert-and-extend path and no
 * immutability guard to write - a rollup is created once, claimed once, and
 * goes terminal. The claim/lease/attempt-cap queue is otherwise the same
 * shape as `OutlineWindowStore` (specs/behaviors/scheduled-work-leases.md).
 */

// ─────────────────────────────────────────────────────────────────────────
// Pure grouping
// ─────────────────────────────────────────────────────────────────────────

export interface RollupChild {
  /** window_index (children of a level-1 rollup) or rollup_index (children of a level-n rollup, n>1). */
  index: number;
  /** Closed (windows only - see below) and terminal (summarized or failed). */
  resolved: boolean;
  fromSeq: number;
  toSeq: number;
  fromTs: string | null;
  toTs: string | null;
}

export interface RollupBoundary {
  rollupIndex: number;
  fromSeq: number;
  toSeq: number;
  fromTs: string | null;
  toTs: string | null;
}

/**
 * Which complete, ready groups of `fanin` consecutive children (by `index`,
 * starting at `k * fanin`) don't have a rollup row yet. Each group is judged
 * independently by its own index range - a group is ready the moment every
 * one of its `fanin` children exists and is `resolved`, regardless of
 * whether earlier or later groups are ready yet. This is deliberate: it
 * keeps the function correct even if children resolve out of order (a
 * second process's sweep racing the scheduled one, per
 * specs/behaviors/scheduled-work-leases.md), not just in the common
 * oldest-first case.
 *
 * Pure and DB-free, exactly like `planWindows` - the caller supplies the
 * children and what rollups already exist at this level.
 */
export function planRollupGroups(
  children: ReadonlyArray<RollupChild>,
  fanin: number,
  existingGroupIndexes: ReadonlySet<number>
): RollupBoundary[] {
  if (children.length === 0) return [];

  const byIndex = new Map(children.map((c) => [c.index, c]));
  const maxIndex = Math.max(...children.map((c) => c.index));
  const numPossibleGroups = Math.floor((maxIndex + 1) / fanin);

  const result: RollupBoundary[] = [];
  for (let k = 0; k < numPossibleGroups; k++) {
    if (existingGroupIndexes.has(k)) continue;

    const start = k * fanin;
    const end = start + fanin - 1;
    let ready = true;
    for (let i = start; i <= end; i++) {
      const c = byIndex.get(i);
      if (!c || !c.resolved) {
        ready = false;
        break;
      }
    }
    if (!ready) continue;

    const first = byIndex.get(start)!;
    const last = byIndex.get(end)!;
    result.push({
      rollupIndex: k,
      fromSeq: first.fromSeq,
      toSeq: last.toSeq,
      fromTs: first.fromTs,
      toTs: last.toTs,
    });
  }
  return result;
}

/**
 * The set of child indices (at `level`) already covered by an existing
 * rollup at `level + 1` - i.e. already grouped into a higher level and so
 * excluded from compose as a loose item at this level. Computed from the
 * parent rows' own index (each parent at index `k` covers children
 * `[k*fanin, (k+1)*fanin)`) rather than from a count, so it stays correct
 * even if parents exist out of order (see `planRollupGroups`).
 */
function coveredChildIndexes(parents: ReadonlyArray<{ index: number }>, fanin: number): Set<number> {
  const covered = new Set<number>();
  for (const p of parents) {
    const start = p.index * fanin;
    for (let i = start; i < start + fanin; i++) covered.add(i);
  }
  return covered;
}

// ─────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────

export interface RollupChildSummary {
  index: number;
  fromTs: string | null;
  toTs: string | null;
  /** null = this child is a resolved gap (failed with no summary) - noted, not silently dropped. */
  summary: string | null;
}

/** Build the prompt to summarize one rollup from its children's summaries - never raw transcript text. */
export function buildRollupPrompt(
  projectPath: string | null,
  gitBranch: string | null,
  level: number,
  rollupIndex: number,
  children: ReadonlyArray<RollupChildSummary>
): string {
  const childLabel = level === 1 ? 'window' : `level-${level - 1} chapter`;
  const sections = children
    .map((c) => {
      const span = c.fromTs && c.toTs ? `${c.fromTs} → ${c.toTs}` : 'unknown time span';
      const body = c.summary ?? `[gap: this ${childLabel} failed to summarize]`;
      return `<${childLabel} index="${c.index}" span="${span}">\n${body}\n</${childLabel}>`;
    })
    .join('\n\n');

  return `Summarize this chapter (level ${level}, chapter ${rollupIndex}) of a longer
Claude Code session, built from its child summaries below - not the raw
transcript. Give a chronological account of what happened across this span;
synthesize, don't just concatenate. Where a child is marked as a gap, note
that briefly rather than inventing what happened there.

SESSION:
- Project: ${projectPath ?? 'unknown'}
- Branch: ${gitBranch ?? 'unknown'}

CHILD SUMMARIES (chronological):
${sections}

Respond with a concise paragraph (3-6 sentences) describing what happened in
this chapter. No tags, no preamble.`;
}

// ─────────────────────────────────────────────────────────────────────────
// Compose input assembly (shared with outline-windows.ts's compose call)
// ─────────────────────────────────────────────────────────────────────────

/** The minimal shape of a window needed to fold it into compose input - see `SummarizedWindowForCompose` in outline-windows.ts. */
export interface WindowForCompose {
  windowIndex: number;
  fromTs: string | null;
  toTs: string | null;
  closed: boolean;
  summary: string;
}

/** The minimal shape of a rollup row needed to fold it into compose input. */
export interface RollupForCompose {
  level: number;
  index: number;
  fromTs: string | null;
  toTs: string | null;
  /** null = not yet summarized (or failed with no summary) - silently excluded from compose, exactly like an unsummarized window; it reappears once a later sweep resolves it. */
  summary: string | null;
}

export type ComposeInput =
  | { kind: 'window'; index: number; fromTs: string | null; toTs: string | null; closed: boolean; summary: string }
  | { kind: 'rollup'; level: number; index: number; fromTs: string | null; toTs: string | null; summary: string };

/**
 * Assemble the compose call's input list, in chronological order:
 * the highest-level rollups, then at each lower level the rollups not yet
 * grouped into a higher one, then the windows not yet in a level-1 chapter
 * (the current chapter's closed windows and the open tail).
 *
 * `rollupsByLevel` need not include every level (only levels with at least
 * one row present matter); levels with no rows are treated as absent. Each
 * level's "not yet grouped" set is computed from the existing parent rows'
 * own index ranges (`coveredChildIndexes`), not a count, so this stays
 * correct even when rollups exist out of order.
 */
export function buildComposeInputs(
  windows: ReadonlyArray<WindowForCompose>,
  rollupsByLevel: ReadonlyMap<number, ReadonlyArray<RollupForCompose>>,
  fanin: number
): ComposeInput[] {
  const levelsPresent = [...rollupsByLevel.entries()]
    .filter(([, rows]) => rows.length > 0)
    .map(([level]) => level);
  const maxLevel = levelsPresent.length > 0 ? Math.max(...levelsPresent) : 0;

  const result: ComposeInput[] = [];

  if (maxLevel > 0) {
    const top = [...(rollupsByLevel.get(maxLevel) ?? [])]
      .filter((r) => r.summary !== null)
      .sort((a, b) => a.index - b.index);
    for (const r of top) {
      result.push({ kind: 'rollup', level: maxLevel, index: r.index, fromTs: r.fromTs, toTs: r.toTs, summary: r.summary! });
    }

    for (let level = maxLevel - 1; level >= 1; level--) {
      const rows = rollupsByLevel.get(level) ?? [];
      const covered = coveredChildIndexes(rollupsByLevel.get(level + 1) ?? [], fanin);
      const ungrouped = rows
        .filter((r) => !covered.has(r.index) && r.summary !== null)
        .sort((a, b) => a.index - b.index);
      for (const r of ungrouped) {
        result.push({ kind: 'rollup', level, index: r.index, fromTs: r.fromTs, toTs: r.toTs, summary: r.summary! });
      }
    }
  }

  const coveredWindows = coveredChildIndexes(rollupsByLevel.get(1) ?? [], fanin);
  const looseWindows = [...windows]
    .filter((w) => !coveredWindows.has(w.windowIndex))
    .sort((a, b) => a.windowIndex - b.windowIndex);
  for (const w of looseWindows) {
    result.push({ kind: 'window', index: w.windowIndex, fromTs: w.fromTs, toTs: w.toTs, closed: w.closed, summary: w.summary });
  }

  return result;
}

/**
 * Backstop cap on the compose call's total input size, independent of the
 * per-level fan-in bound above (which bounds item *count*, not the length of
 * each item's summary text). If the composed text would still exceed
 * `charBudget` - a pathological case, not the expected one - the OLDEST
 * inputs are dropped first (never crash, never drop the single most recent
 * item) and the caller logs a warning. Chronological order in, chronological
 * order out.
 */
export function capComposeInputs(
  inputs: ReadonlyArray<ComposeInput>,
  charBudget: number
): { inputs: ComposeInput[]; trimmed: boolean } {
  const approxSize = (i: ComposeInput): number => i.summary.length + 80; // + tag/span overhead
  let total = inputs.reduce((sum, i) => sum + approxSize(i), 0);
  if (total <= charBudget || inputs.length <= 1) {
    return { inputs: [...inputs], trimmed: false };
  }

  const kept = [...inputs];
  while (total > charBudget && kept.length > 1) {
    const removed = kept.shift()!;
    total -= approxSize(removed);
  }
  return { inputs: kept, trimmed: kept.length !== inputs.length };
}

// ─────────────────────────────────────────────────────────────────────────
// Persistence — sessions.outline_rollups
// ─────────────────────────────────────────────────────────────────────────

export interface OutlineRollupRow {
  id: string;
  session_id: string;
  level: number;
  rollup_index: number;
  from_seq: number;
  to_seq: number;
  from_ts: string | null;
  to_ts: string | null;
  status: 'pending' | 'summarizing' | 'summarized' | 'failed';
  summary: string | null;
  content_hash: string | null;
  model: string | null;
  attempts: number;
  summarized_at: string | null;
}

/**
 * The DB half of rollups - a claim/lease queue over `sessions.outline_rollups`,
 * sharing the same primitives as `OutlineWindowStore` (see that class's
 * comment for why a hand-rolled queue rather than `packages/core`'s generic
 * `createLeaseQueue`). Simpler than the window store in one respect: every
 * rollup is closed-by-construction (see the module comment), so there is no
 * open-tail case and therefore no `releaseUnchanged` - a rollup is claimed
 * once and always goes terminal, `summarized` or `failed`.
 */
export class OutlineRollupStore {
  constructor(private sql: postgres.Sql) {}

  /** All rollups for a session, across every level, oldest level and index first. */
  async listRollups(sessionId: string): Promise<OutlineRollupRow[]> {
    return this.sql<OutlineRollupRow[]>`
      SELECT id, session_id, level, rollup_index, from_seq, to_seq, from_ts, to_ts,
             status, summary, content_hash, model, attempts, summarized_at
      FROM sessions.outline_rollups
      WHERE session_id = ${sessionId}::uuid
      ORDER BY level ASC, rollup_index ASC
    `;
  }

  /** Insert a newly-ready group. A no-op if the row already exists (planning may re-derive the same group before a previous insert's effect is visible in this process's own view). */
  async insertRollup(sessionId: string, level: number, b: RollupBoundary): Promise<void> {
    await this.sql`
      INSERT INTO sessions.outline_rollups
        (session_id, level, rollup_index, from_seq, to_seq, from_ts, to_ts, status)
      VALUES (
        ${sessionId}::uuid, ${level}, ${b.rollupIndex}, ${b.fromSeq}, ${b.toSeq},
        ${b.fromTs}, ${b.toTs}, 'pending'
      )
      ON CONFLICT (session_id, level, rollup_index) DO NOTHING
    `;
  }

  /** Atomically claim one pending rollup by id - `false` means another process already claimed it. */
  async claimOne(id: string, ownerId: string, leaseMs: number): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE sessions.outline_rollups
      SET status = 'summarizing',
          lease_owner = ${ownerId},
          lease_expires_at = NOW() + (${leaseMs}::text || ' milliseconds')::interval
      WHERE id = ${id} AND status = 'pending'
      RETURNING id
    `;
    return rows.length > 0;
  }

  /** Record a successful summarization - terminal, never claimed again. */
  async completeSummary(id: string, args: { summary: string; model: string; contentHash: string }): Promise<void> {
    await this.sql`
      UPDATE sessions.outline_rollups
      SET status = 'summarized',
          summary = ${args.summary},
          model = ${args.model},
          content_hash = ${args.contentHash},
          summarized_at = NOW(),
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE id = ${id}
    `;
  }

  /** Record a failed summarization attempt; terminal (`failed`) once `maxAttempts` is reached. */
  async failSummary(id: string, error: string, maxAttempts: number): Promise<void> {
    await this.sql`
      UPDATE sessions.outline_rollups
      SET attempts = attempts + 1,
          last_error = ${error.slice(0, 2000)},
          lease_owner = NULL,
          lease_expires_at = NULL,
          status = CASE WHEN attempts + 1 >= ${maxAttempts} THEN 'failed' ELSE 'pending' END
      WHERE id = ${id}
    `;
  }

  /** Return leases stuck past their expiry (a crashed sweep) to `pending`. */
  async reclaimExpired(): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE sessions.outline_rollups
      SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
      WHERE status = 'summarizing' AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()
      RETURNING id
    `;
    return rows.length;
  }
}

/** Deterministic content hash over a rollup's children's summaries, for the same debugging/audit purpose as a window's `content_hash` - not used to skip summarization (a rollup's children never change after it's created). */
export function rollupContentHash(children: ReadonlyArray<RollupChildSummary>): string {
  const material = children.map((c) => `${c.index}:${c.summary ?? ''}`).join('\u0001');
  return createHash('md5').update(material).digest('hex');
}
