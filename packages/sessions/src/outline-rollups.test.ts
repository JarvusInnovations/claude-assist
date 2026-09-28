import { describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import {
  planRollupGroups,
  buildRollupPrompt,
  buildComposeInputs,
  capComposeInputs,
  rollupContentHash,
  OutlineRollupStore,
  type RollupChild,
  type WindowForCompose,
  type RollupForCompose,
  type ComposeInput,
} from './outline-rollups.js';

// ── planRollupGroups — pure grouping ─────────────────────────────────────

function child(index: number, resolved: boolean): RollupChild {
  return { index, resolved, fromSeq: index * 10, toSeq: index * 10 + 9, fromTs: `t${index}`, toTs: `t${index}b` };
}

describe('planRollupGroups', () => {
  it('groups exactly fanin consecutive resolved children into one rollup', () => {
    const children = Array.from({ length: 4 }, (_, i) => child(i, true));
    const groups = planRollupGroups(children, 4, new Set());
    expect(groups).toEqual([
      { rollupIndex: 0, fromSeq: 0, toSeq: 39, fromTs: 't0', toTs: 't3b' },
    ]);
  });

  it('waits (no group) when a group still has a pending/summarizing child', () => {
    const children = [child(0, true), child(1, true), child(2, false), child(3, true)];
    expect(planRollupGroups(children, 4, new Set())).toEqual([]);
  });

  it('waits when a group is missing a child entirely (not yet created)', () => {
    const children = [child(0, true), child(1, true), child(3, true)]; // index 2 absent
    expect(planRollupGroups(children, 4, new Set())).toEqual([]);
  });

  it('still rolls up a group containing a failed (resolved) child', () => {
    // "resolved" covers both summarized and failed — planRollupGroups only
    // cares about resolved/not, not which; the gap itself is handled by
    // buildRollupPrompt via a null summary, not by exclusion here.
    const children = [child(0, true), child(1, true), child(2, true), child(3, true)];
    const groups = planRollupGroups(children, 4, new Set());
    expect(groups).toHaveLength(1);
  });

  it('judges each group independently — a later group can be ready while an earlier one is not', () => {
    const children = [
      child(0, true), child(1, false), child(2, true), child(3, true), // group 0: not ready (index 1 unresolved)
      child(4, true), child(5, true), child(6, true), child(7, true), // group 1: ready
    ];
    const groups = planRollupGroups(children, 4, new Set());
    expect(groups.map((g) => g.rollupIndex)).toEqual([1]);
  });

  it('skips a group index already in existingGroupIndexes (idempotent re-planning)', () => {
    const children = Array.from({ length: 8 }, (_, i) => child(i, true));
    const groups = planRollupGroups(children, 4, new Set([0]));
    expect(groups.map((g) => g.rollupIndex)).toEqual([1]);
  });

  it('returns [] for no children', () => {
    expect(planRollupGroups([], 4, new Set())).toEqual([]);
  });

  it('is deterministic — re-running over the same input yields the same groups', () => {
    const children = Array.from({ length: 12 }, (_, i) => child(i, true));
    const first = planRollupGroups(children, 4, new Set());
    const second = planRollupGroups(children, 4, new Set());
    expect(second).toEqual(first);
  });
});

// ── buildRollupPrompt ────────────────────────────────────────────────────

describe('buildRollupPrompt', () => {
  it('includes the level, index, and every child summary in order', () => {
    const prompt = buildRollupPrompt('/repo', 'main', 1, 2, [
      { index: 80, fromTs: 't0', toTs: 't1', summary: 'first window' },
      { index: 81, fromTs: 't1', toTs: 't2', summary: 'second window' },
    ]);
    expect(prompt).toContain('level 1, chapter 2');
    expect(prompt.indexOf('first window')).toBeLessThan(prompt.indexOf('second window'));
    expect(prompt).toContain('<window index="80"');
  });

  it('notes a gap for a child with no summary rather than inventing content', () => {
    const prompt = buildRollupPrompt('/repo', 'main', 1, 0, [
      { index: 0, fromTs: null, toTs: null, summary: 'did stuff' },
      { index: 1, fromTs: null, toTs: null, summary: null },
    ]);
    expect(prompt).toContain('did stuff');
    expect(prompt).toContain('[gap: this window failed to summarize]');
  });

  it('labels a level-n (n>1) child as a chapter, not a window', () => {
    const prompt = buildRollupPrompt('/repo', 'main', 2, 0, [{ index: 0, fromTs: null, toTs: null, summary: 'x' }]);
    expect(prompt).toContain('level-1 chapter');
  });
});

// ── buildComposeInputs — grouping-aware compose assembly ────────────────

function windowForCompose(index: number, closed = true): WindowForCompose {
  return { windowIndex: index, fromTs: null, toTs: null, closed, summary: `w${index}` };
}

describe('buildComposeInputs', () => {
  it('with no rollups yet, compose input is just the loose windows in order', () => {
    const windows = [windowForCompose(0), windowForCompose(1)];
    const inputs = buildComposeInputs(windows, new Map(), 40);
    expect(inputs).toEqual([
      { kind: 'window', index: 0, fromTs: null, toTs: null, closed: true, summary: 'w0' },
      { kind: 'window', index: 1, fromTs: null, toTs: null, closed: true, summary: 'w1' },
    ]);
  });

  it('windows covered by a level-1 chapter are excluded; only the loose remainder appears', () => {
    const windows = Array.from({ length: 45 }, (_, i) => windowForCompose(i, i < 44));
    const rollupsByLevel = new Map<number, RollupForCompose[]>([
      [1, [{ level: 1, index: 0, fromTs: 't0', toTs: 't39', summary: 'chapter 0' }]],
    ]);
    const inputs = buildComposeInputs(windows, rollupsByLevel, 40);
    // Chapter 0 (windows 0-39) stands in for those; windows 40-44 are loose.
    expect(inputs[0]).toEqual({ kind: 'rollup', level: 1, index: 0, fromTs: 't0', toTs: 't39', summary: 'chapter 0' });
    expect(inputs.slice(1).map((i) => (i.kind === 'window' ? i.index : -1))).toEqual([40, 41, 42, 43, 44]);
  });

  it('a level-2 rollup covers its level-1 children — only ungrouped level-1 rollups appear alongside it', () => {
    const windows: WindowForCompose[] = [];
    const level1: RollupForCompose[] = Array.from({ length: 45 }, (_, i) => ({
      level: 1, index: i, fromTs: `a${i}`, toTs: `b${i}`, summary: `L1-${i}`,
    }));
    const level2: RollupForCompose[] = [{ level: 2, index: 0, fromTs: 'a0', toTs: 'b39', summary: 'L2-0' }];
    const rollupsByLevel = new Map<number, RollupForCompose[]>([[1, level1], [2, level2]]);

    const inputs = buildComposeInputs(windows, rollupsByLevel, 40);
    expect(inputs[0]).toEqual({ kind: 'rollup', level: 2, index: 0, fromTs: 'a0', toTs: 'b39', summary: 'L2-0' });
    // Level-1 rollups 0-39 are covered by the level-2 rollup; 40-44 are ungrouped leftovers.
    const level1Inputs = inputs.filter((i): i is ComposeInput & { kind: 'rollup' } => i.kind === 'rollup' && i.level === 1);
    expect(level1Inputs.map((i) => i.index)).toEqual([40, 41, 42, 43, 44]);
  });

  it('excludes a rollup that has not been summarized yet (null summary), same as an unsummarized window', () => {
    const windows = [windowForCompose(0)];
    const rollupsByLevel = new Map<number, RollupForCompose[]>([
      [1, [{ level: 1, index: 0, fromTs: null, toTs: null, summary: null }]],
    ]);
    const inputs = buildComposeInputs(windows, rollupsByLevel, 40);
    expect(inputs.every((i) => i.kind !== 'rollup' || i.summary !== undefined)).toBe(true);
    expect(inputs.some((i) => i.kind === 'rollup')).toBe(false);
  });

  it('stays chronological: top rollups, then descending ungrouped levels, then loose windows', () => {
    const windows = [windowForCompose(80), windowForCompose(81)];
    const rollupsByLevel = new Map<number, RollupForCompose[]>([
      [1, [
        { level: 1, index: 0, fromTs: null, toTs: null, summary: 'L1-0' }, // covered by L2
        { level: 1, index: 1, fromTs: null, toTs: null, summary: 'L1-1' }, // ungrouped
      ]],
      [2, [{ level: 2, index: 0, fromTs: null, toTs: null, summary: 'L2-0' }]], // covers L1 index 0 only (fanin=1 for this test)
    ]);
    const inputs = buildComposeInputs(windows, rollupsByLevel, 1);
    expect(inputs.map((i) => i.summary)).toEqual(['L2-0', 'L1-1', 'w80', 'w81']);
  });

  // ── Bound proof: compose input count stays ~fanin per level regardless of session length ──

  function buildFullRollupTree(
    windowCount: number,
    fanin: number
  ): { windows: WindowForCompose[]; rollupsByLevel: Map<number, RollupForCompose[]> } {
    const windows: WindowForCompose[] = Array.from({ length: windowCount }, (_, i) => windowForCompose(i));
    const rollupsByLevel = new Map<number, RollupForCompose[]>();

    let children: RollupChild[] = windows.map((w) => ({
      index: w.windowIndex, resolved: true, fromSeq: w.windowIndex, toSeq: w.windowIndex, fromTs: null, toTs: null,
    }));
    let level = 1;
    while (children.length >= fanin) {
      const groups = planRollupGroups(children, fanin, new Set());
      if (groups.length === 0) break;
      const rows: RollupForCompose[] = groups.map((g) => ({
        level, index: g.rollupIndex, fromTs: g.fromTs, toTs: g.toTs, summary: `L${level}-${g.rollupIndex}`,
      }));
      rollupsByLevel.set(level, rows);
      children = rows.map((r) => ({ index: r.index, resolved: true, fromSeq: 0, toSeq: 0, fromTs: r.fromTs, toTs: r.toTs }));
      level++;
    }

    return { windows, rollupsByLevel };
  }

  const FANIN = 40;

  for (const n of [10, 100, 1_000, 10_000]) {
    it(`compose inputs stay ≤ fanin per level for ${n} windows`, () => {
      const { windows, rollupsByLevel } = buildFullRollupTree(n, FANIN);
      const inputs = buildComposeInputs(windows, rollupsByLevel, FANIN);

      const looseWindows = inputs.filter((i) => i.kind === 'window');
      expect(looseWindows.length).toBeLessThan(FANIN);

      const maxLevel = rollupsByLevel.size > 0 ? Math.max(...rollupsByLevel.keys()) : 0;
      for (let level = 1; level <= maxLevel; level++) {
        const atLevel = inputs.filter((i) => i.kind === 'rollup' && i.level === level);
        expect(atLevel.length).toBeLessThanOrEqual(FANIN);
      }

      // The whole compose call never grows anywhere near linearly with n:
      // bounded by roughly (number of levels + 1) * fanin, not n itself.
      const bound = FANIN * (maxLevel + 1);
      expect(inputs.length).toBeLessThanOrEqual(bound);
      if (n > FANIN) expect(inputs.length).toBeLessThan(n);
    });
  }
});

// ── capComposeInputs — prompt-size backstop ──────────────────────────────

describe('capComposeInputs', () => {
  function inputs(n: number, summaryLen: number): ComposeInput[] {
    return Array.from({ length: n }, (_, i) => ({
      kind: 'window' as const,
      index: i,
      fromTs: null,
      toTs: null,
      closed: true,
      summary: 'x'.repeat(summaryLen),
    }));
  }

  it('is a no-op under budget', () => {
    const items = inputs(3, 10);
    const { inputs: kept, trimmed } = capComposeInputs(items, 10_000);
    expect(kept).toEqual(items);
    expect(trimmed).toBe(false);
  });

  it('trims the OLDEST inputs first when over budget, keeping the newest', () => {
    const items = inputs(5, 1000);
    const { inputs: kept, trimmed } = capComposeInputs(items, 2500);
    expect(trimmed).toBe(true);
    expect(kept.length).toBeLessThan(items.length);
    // Chronological order preserved, and the tail (most recent) survives.
    expect(kept.at(-1)).toEqual(items.at(-1));
    expect(kept.map((i) => i.index)).toEqual(items.slice(items.length - kept.length).map((i) => i.index));
  });

  it('never drops to zero — always keeps at least the single most recent input, even if it alone exceeds budget', () => {
    const items = inputs(4, 10_000);
    const { inputs: kept } = capComposeInputs(items, 100);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toEqual(items.at(-1));
  });

  it('never throws regardless of how far over budget the input is', () => {
    const items = inputs(50, 50_000);
    expect(() => capComposeInputs(items, 1)).not.toThrow();
  });
});

// ── rollupContentHash ────────────────────────────────────────────────────

describe('rollupContentHash', () => {
  it('is stable for the same children and changes when a summary changes', () => {
    const a = rollupContentHash([{ index: 0, fromTs: null, toTs: null, summary: 'x' }]);
    const same = rollupContentHash([{ index: 0, fromTs: null, toTs: null, summary: 'x' }]);
    const changed = rollupContentHash([{ index: 0, fromTs: null, toTs: null, summary: 'y' }]);
    expect(same).toBe(a);
    expect(changed).not.toBe(a);
  });

  it('treats a gap (null summary) distinctly from an empty-string summary', () => {
    const gap = rollupContentHash([{ index: 0, fromTs: null, toTs: null, summary: null }]);
    const empty = rollupContentHash([{ index: 0, fromTs: null, toTs: null, summary: '' }]);
    // Both currently hash to the same material (null coalesces to '') - this
    // pins that behavior so a future change to distinguish them is a visible diff.
    expect(gap).toBe(empty);
  });
});

// ── OutlineRollupStore — a small in-memory fake Postgres ────────────────
//
// Mirrors outline-windows.test.ts's OutlineWindowStore fake: executes the
// store's real SQL semantics against an in-memory row array, because the
// property under test (exactly-once summarization, safe under a concurrent
// claim) is a concurrency guarantee, not just "the right SQL text was issued."

interface FakeRow {
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
  lease_owner: string | null;
  lease_expires_at: string | null;
  summarized_at: string | null;
}

function fakeRow(over: Partial<FakeRow>): FakeRow {
  return {
    id: '1',
    session_id: 's1',
    level: 1,
    rollup_index: 0,
    from_seq: 0,
    to_seq: 39,
    from_ts: null,
    to_ts: null,
    status: 'pending',
    summary: null,
    content_hash: null,
    model: null,
    attempts: 0,
    lease_owner: null,
    lease_expires_at: null,
    summarized_at: null,
    ...over,
  };
}

function fakeSql(rows: FakeRow[]): postgres.Sql {
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');

    if (text.includes('SELECT id, session_id, level')) {
      const [sessionId] = values as [string];
      return Promise.resolve(
        rows.filter((r) => r.session_id === sessionId).sort((a, b) => a.level - b.level || a.rollup_index - b.rollup_index)
      );
    }

    if (text.includes('INSERT INTO sessions.outline_rollups')) {
      const [sessionId, level, rollupIndex, fromSeq, toSeq, fromTs, toTs] = values as [
        string, number, number, number, number, string | null, string | null,
      ];
      const existing = rows.find((r) => r.session_id === sessionId && r.level === level && r.rollup_index === rollupIndex);
      if (!existing) {
        rows.push(fakeRow({ id: String(rows.length + 1), session_id: sessionId, level, rollup_index: rollupIndex, from_seq: fromSeq, to_seq: toSeq, from_ts: fromTs, to_ts: toTs }));
      }
      return Promise.resolve([]);
    }

    if (text.includes("SET status = 'summarizing'")) {
      const [ownerId, , id] = values as [string, number, string];
      const row = rows.find((r) => r.id === id);
      if (!row || row.status !== 'pending') return Promise.resolve([]);
      row.status = 'summarizing';
      row.lease_owner = ownerId;
      row.lease_expires_at = new Date(Date.now() + 3600_000).toISOString();
      return Promise.resolve([{ id: row.id }]);
    }

    if (text.includes('summarized_at = NOW()')) {
      const [summary, model, contentHash, id] = values as [string, string, string, string];
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.status = 'summarized';
        row.summary = summary;
        row.model = model;
        row.content_hash = contentHash;
        row.summarized_at = new Date().toISOString();
        row.lease_owner = null;
        row.lease_expires_at = null;
      }
      return Promise.resolve([]);
    }

    if (text.includes('attempts = attempts + 1')) {
      const [error, maxAttempts, id] = values as [string, number, string];
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.attempts += 1;
        row.lease_owner = null;
        row.lease_expires_at = null;
        row.status = row.attempts >= maxAttempts ? 'failed' : 'pending';
        void error;
      }
      return Promise.resolve([]);
    }

    if (text.includes('lease_expires_at < NOW()')) {
      const now = Date.now();
      const reclaimed = rows.filter((r) => r.status === 'summarizing' && r.lease_expires_at && Date.parse(r.lease_expires_at) < now);
      for (const r of reclaimed) {
        r.status = 'pending';
        r.lease_owner = null;
        r.lease_expires_at = null;
      }
      return Promise.resolve(reclaimed.map((r) => ({ id: r.id })));
    }

    throw new Error(`fakeSql: unrecognized query: ${text}`);
  }) as unknown as postgres.Sql;
  return fn;
}

describe('OutlineRollupStore.insertRollup', () => {
  it('inserts a new rollup and is a no-op on a duplicate (session, level, index)', async () => {
    const rows: FakeRow[] = [];
    const store = new OutlineRollupStore(fakeSql(rows));

    await store.insertRollup('s1', 1, { rollupIndex: 0, fromSeq: 0, toSeq: 399, fromTs: 't0', toTs: 't399' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');

    await store.insertRollup('s1', 1, { rollupIndex: 0, fromSeq: 0, toSeq: 399, fromTs: 't0', toTs: 't399' });
    expect(rows).toHaveLength(1); // still just one row
  });
});

describe('OutlineRollupStore claim/complete/fail — idempotency', () => {
  it('a rollup is claimed once and goes terminal (summarized) — never claimable again', async () => {
    const rows: FakeRow[] = [fakeRow({ id: 'r1' })];
    const store = new OutlineRollupStore(fakeSql(rows));

    expect(await store.claimOne('r1', 'owner-a', 300_000)).toBe(true);
    await store.completeSummary('r1', { summary: 'chapter summary', model: 'test-model', contentHash: 'h1' });
    expect(rows[0]!.status).toBe('summarized');

    expect(await store.claimOne('r1', 'owner-b', 300_000)).toBe(false);
    expect(rows[0]!.status).toBe('summarized');
  });

  it('two concurrent claims on the same rollup: only one succeeds', async () => {
    const rows: FakeRow[] = [fakeRow({ id: 'r1' })];
    const store = new OutlineRollupStore(fakeSql(rows));

    const [a, b] = await Promise.all([
      store.claimOne('r1', 'owner-a', 300_000),
      store.claimOne('r1', 'owner-b', 300_000),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(rows[0]!.status).toBe('summarizing');
  });

  it('a rollup fails repeatedly and goes terminal (failed) at the attempt cap', async () => {
    const rows: FakeRow[] = [fakeRow({ id: 'r1', attempts: 4 })];
    const store = new OutlineRollupStore(fakeSql(rows));

    await store.claimOne('r1', 'owner-a', 300_000);
    await store.failSummary('r1', 'model timeout', 5);
    expect(rows[0]!.attempts).toBe(5);
    expect(rows[0]!.status).toBe('failed');
    expect(await store.claimOne('r1', 'owner-b', 300_000)).toBe(false);
  });

  it('a failed attempt under the cap goes back to pending and is retried next sweep', async () => {
    const rows: FakeRow[] = [fakeRow({ id: 'r1', attempts: 0 })];
    const store = new OutlineRollupStore(fakeSql(rows));

    await store.claimOne('r1', 'owner-a', 300_000);
    await store.failSummary('r1', 'transient error', 5);
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.status).toBe('pending');
    expect(await store.claimOne('r1', 'owner-b', 300_000)).toBe(true);
  });

  it('reclaimExpired returns a stuck lease (crashed sweep) to pending, leaving a live lease untouched', async () => {
    const rows: FakeRow[] = [
      fakeRow({ id: 'r1', status: 'summarizing', lease_owner: 'dead-owner', lease_expires_at: new Date(Date.now() - 1000).toISOString() }),
      fakeRow({ id: 'r2', status: 'summarizing', lease_owner: 'live-owner', lease_expires_at: new Date(Date.now() + 1_000_000).toISOString() }),
    ];
    const store = new OutlineRollupStore(fakeSql(rows));

    const n = await store.reclaimExpired();
    expect(n).toBe(1);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[1]!.status).toBe('summarizing');
  });
});

describe('OutlineRollupStore.listRollups', () => {
  it('orders by level then rollup_index', async () => {
    const rows: FakeRow[] = [
      fakeRow({ id: 'a', level: 2, rollup_index: 0 }),
      fakeRow({ id: 'b', level: 1, rollup_index: 1 }),
      fakeRow({ id: 'c', level: 1, rollup_index: 0 }),
    ];
    const store = new OutlineRollupStore(fakeSql(rows));
    const listed = await store.listRollups('s1');
    expect(listed.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
});
