import { describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import {
  planWindows,
  isWindowedSession,
  windowsSignature,
  buildComposePrompt,
  buildWindowPrompt,
  approxMessageBytes,
  OutlineWindowStore,
  DEFAULT_OUTLINE_WINDOW_CONFIG,
} from './outline-windows.js';
import type { TranscriptMessage } from './types.js';

// ── planWindows — pure boundary planning ────────────────────────────────────

function msg(ts: string, approxBytes = 10): { timestamp: string | null; approxBytes: number } {
  return { timestamp: ts, approxBytes };
}

describe('planWindows', () => {
  const CFG = { maxMessages: 3, maxBytes: 1_000_000, maxSpanMs: 1_000_000_000 };

  it('never emits undefined timestamps: lines without one become null, and the span starts at the first known one', () => {
    const messages = [
      { timestamp: undefined as unknown as string | null, approxBytes: 10 },
      msg('2026-01-01T00:00:05Z'),
      { timestamp: undefined as unknown as string | null, approxBytes: 10 },
    ];
    const result = planWindows(0, 0, messages, CFG);
    expect(result).toHaveLength(1);
    expect(result[0]!.fromTs).toBe('2026-01-01T00:00:05Z');
    expect(result[0]!.toTs).toBeNull();
    for (const b of result) {
      expect(b.fromTs).not.toBeUndefined();
      expect(b.toTs).not.toBeUndefined();
    }
  });

  it('returns [] for no messages', () => {
    expect(planWindows(0, 0, [], CFG)).toEqual([]);
  });

  it('produces a single open tail boundary when under every cap', () => {
    const messages = [msg('2026-01-01T00:00:00Z'), msg('2026-01-01T00:00:01Z')];
    const result = planWindows(0, 0, messages, CFG);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ windowIndex: 0, fromSeq: 0, toSeq: 1, closed: false });
  });

  it('closes a window on message-count cap and opens the next as tail', () => {
    const messages = [
      msg('2026-01-01T00:00:00Z'),
      msg('2026-01-01T00:00:01Z'),
      msg('2026-01-01T00:00:02Z'), // 3rd message trips maxMessages=3
      msg('2026-01-01T00:00:03Z'),
    ];
    const result = planWindows(0, 0, messages, CFG);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ windowIndex: 0, fromSeq: 0, toSeq: 2, closed: true });
    expect(result[1]).toMatchObject({ windowIndex: 1, fromSeq: 3, toSeq: 3, closed: false });
  });

  it('can close several windows in one call (first-time backfill of a big backlog)', () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg(`2026-01-01T00:00:${String(i).padStart(2, '0')}Z`));
    const result = planWindows(0, 0, messages, CFG);
    // 3+3+3 closed, 1 left open as tail.
    const closed = result.filter((w) => w.closed);
    const open = result.filter((w) => !w.closed);
    expect(closed).toHaveLength(3);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ windowIndex: 3, fromSeq: 9, toSeq: 9 });
  });

  it('closes on byte cap even under the message cap', () => {
    const cfg = { maxMessages: 100, maxBytes: 25, maxSpanMs: 1_000_000_000 };
    const messages = [msg('2026-01-01T00:00:00Z', 10), msg('2026-01-01T00:00:01Z', 10), msg('2026-01-01T00:00:02Z', 10)];
    const result = planWindows(0, 0, messages, cfg);
    // 10+10=20 < 25, +10=30 >= 25 trips on the 3rd message.
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ fromSeq: 0, toSeq: 2, closed: true });
  });

  it('closes on time-span cap even under message/byte caps', () => {
    const cfg = { maxMessages: 100, maxBytes: 1_000_000, maxSpanMs: 60_000 }; // 1 minute
    const messages = [
      msg('2026-01-01T00:00:00Z'),
      msg('2026-01-01T00:00:30Z'),
      msg('2026-01-01T00:01:30Z'), // 90s span >= 60s cap
    ];
    const result = planWindows(0, 0, messages, cfg);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ fromSeq: 0, toSeq: 2, closed: true });
  });

  it('continues numbering and seq offsets from a non-zero start', () => {
    const messages = [msg('2026-01-01T00:00:10Z')];
    const result = planWindows(5, 100, messages, CFG);
    expect(result).toEqual([
      { windowIndex: 5, fromSeq: 100, toSeq: 100, fromTs: '2026-01-01T00:00:10Z', toTs: '2026-01-01T00:00:10Z', closed: false },
    ]);
  });

  it('re-running over an unchanged message set is idempotent (same boundaries)', () => {
    const messages = [msg('2026-01-01T00:00:00Z'), msg('2026-01-01T00:00:01Z')];
    const first = planWindows(0, 0, messages, CFG);
    const second = planWindows(0, 0, messages, CFG);
    expect(second).toEqual(first);
  });
});

describe('approxMessageBytes', () => {
  it('is deterministic and grows with message content', () => {
    const a: TranscriptMessage = {
      type: 'user', sessionId: 's', uuid: 'u1', parentUuid: null, timestamp: 't',
      message: { role: 'user', content: 'hi' },
    };
    const b: TranscriptMessage = { ...a, message: { role: 'user', content: 'a much longer message body here' } };
    expect(approxMessageBytes(a)).toBe(approxMessageBytes(a));
    expect(approxMessageBytes(b)).toBeGreaterThan(approxMessageBytes(a));
  });
});

describe('isWindowedSession', () => {
  const CFG = { thresholdMessages: 400, thresholdBytes: 2_000_000 };
  it('is false under both thresholds', () => {
    expect(isWindowedSession(10, 1000, CFG)).toBe(false);
  });
  it('is true over the message threshold alone', () => {
    expect(isWindowedSession(401, 100, CFG)).toBe(true);
  });
  it('is true over the byte threshold alone (few huge messages)', () => {
    expect(isWindowedSession(5, 2_000_001, CFG)).toBe(true);
  });
});

describe('windowsSignature', () => {
  it('is stable for the same summaries and changes when a summary changes', () => {
    const a = windowsSignature([
      { windowIndex: 0, fromTs: null, toTs: null, closed: true, summary: 'did X' },
      { windowIndex: 1, fromTs: null, toTs: null, closed: false, summary: 'doing Y' },
    ]);
    const same = windowsSignature([
      { windowIndex: 0, fromTs: null, toTs: null, closed: true, summary: 'did X' },
      { windowIndex: 1, fromTs: null, toTs: null, closed: false, summary: 'doing Y' },
    ]);
    const changed = windowsSignature([
      { windowIndex: 0, fromTs: null, toTs: null, closed: true, summary: 'did X' },
      { windowIndex: 1, fromTs: null, toTs: null, closed: false, summary: 'doing Y, now more' },
    ]);
    expect(same).toBe(a);
    expect(changed).not.toBe(a);
  });

  it('changes when a window closes (open -> closed) even with the same text', () => {
    const open = windowsSignature([{ windowIndex: 0, fromTs: null, toTs: null, closed: false, summary: 'did X' }]);
    const closed = windowsSignature([{ windowIndex: 0, fromTs: null, toTs: null, closed: true, summary: 'did X' }]);
    expect(open).not.toBe(closed);
  });

  it('is order-sensitive (chronological composition matters)', () => {
    const w0 = { windowIndex: 0, fromTs: null, toTs: null, closed: true, summary: 'a' };
    const w1 = { windowIndex: 1, fromTs: null, toTs: null, closed: true, summary: 'b' };
    expect(windowsSignature([w0, w1])).not.toBe(windowsSignature([w1, w0]));
  });
});

describe('buildComposePrompt / buildWindowPrompt', () => {
  it('compose prompt includes project, branch, and every window summary in order', () => {
    const prompt = buildComposePrompt('/repo/thing', 'main', [
      { windowIndex: 0, fromTs: '2026-01-01T00:00:00Z', toTs: '2026-01-01T01:00:00Z', closed: true, summary: 'first slice' },
      { windowIndex: 1, fromTs: '2026-01-01T01:00:00Z', toTs: null, closed: false, summary: 'still going' },
    ]);
    expect(prompt).toContain('/repo/thing');
    expect(prompt).toContain('main');
    expect(prompt.indexOf('first slice')).toBeLessThan(prompt.indexOf('still going'));
    expect(prompt).toContain('(in progress)');
    expect(prompt).toContain('<title>');
  });

  it('window prompt marks an in-progress (tail) window distinctly from a closed one', () => {
    const closed = buildWindowPrompt('/repo', 'main', 2, true, 'slice text');
    const open = buildWindowPrompt('/repo', 'main', 2, false, 'slice text');
    expect(closed).not.toContain('still in progress');
    expect(open).toContain('still in progress');
  });
});

// ── OutlineWindowStore — a small in-memory fake Postgres ────────────────────
//
// Executes the store's actual SQL semantics against an in-memory row array
// rather than just recording query text, because the property under test —
// exactly-once summarization, safe under a concurrent claim — is a real
// concurrency guarantee, not just "the right SQL text was issued."

interface FakeRow {
  id: string;
  session_id: string;
  window_index: number;
  from_seq: number;
  to_seq: number;
  from_ts: string | null;
  to_ts: string | null;
  closed_at: string | null;
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
    window_index: 0,
    from_seq: 0,
    to_seq: 9,
    from_ts: null,
    to_ts: null,
    closed_at: null,
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

    if (text.includes("SELECT id, session_id, window_index")) {
      // listWindows: values = [sessionId]
      const [sessionId] = values as [string];
      const out = rows
        .filter((r) => r.session_id === sessionId)
        .sort((a, b) => a.window_index - b.window_index);
      return Promise.resolve(out);
    }

    if (text.includes('MAX(to_seq)')) {
      const [sessionId] = values as [string];
      const closed = rows.filter((r) => r.session_id === sessionId && r.closed_at !== null);
      const toSeq = closed.length ? Math.max(...closed.map((r) => r.to_seq)) : null;
      return Promise.resolve([{ to_seq: toSeq, closed_count: closed.length }]);
    }

    if (text.includes('INSERT INTO sessions.outline_windows')) {
      // upsertBoundary: values = [sessionId, windowIndex, fromSeq, toSeq, fromTs, toTs, closed]
      const [sessionId, windowIndex, fromSeq, toSeq, fromTs, toTs, closed] = values as [
        string, number, number, number, string | null, string | null, boolean,
      ];
      const existing = rows.find((r) => r.session_id === sessionId && r.window_index === windowIndex);
      if (!existing) {
        rows.push(
          fakeRow({
            id: String(rows.length + 1),
            session_id: sessionId,
            window_index: windowIndex,
            from_seq: fromSeq,
            to_seq: toSeq,
            from_ts: fromTs,
            to_ts: toTs,
            closed_at: closed ? new Date().toISOString() : null,
          })
        );
      } else if (existing.closed_at === null) {
        existing.to_seq = toSeq;
        existing.to_ts = toTs;
        if (closed) existing.closed_at = new Date().toISOString();
      }
      return Promise.resolve([]);
    }

    if (text.includes("SET status = 'summarizing'")) {
      // claimOne: values = [ownerId, leaseMs, id]
      const [ownerId, , id] = values as [string, number, string];
      const row = rows.find((r) => r.id === id);
      if (!row || row.status !== 'pending') return Promise.resolve([]);
      row.status = 'summarizing';
      row.lease_owner = ownerId;
      row.lease_expires_at = new Date(Date.now() + 3600_000).toISOString();
      return Promise.resolve([{ id: row.id }]);
    }

    if (text.includes('lease_expires_at < NOW()')) {
      // reclaimExpired: no values
      const now = Date.now();
      const reclaimed = rows.filter(
        (r) => r.status === 'summarizing' && r.lease_expires_at && Date.parse(r.lease_expires_at) < now
      );
      for (const r of reclaimed) {
        r.status = 'pending';
        r.lease_owner = null;
        r.lease_expires_at = null;
      }
      return Promise.resolve(reclaimed.map((r) => ({ id: r.id })));
    }

    if (text.includes("SET status = 'pending', lease_owner = NULL")) {
      // releaseUnchanged: values = [id]
      const [id] = values as [string];
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.status = 'pending';
        row.lease_owner = null;
        row.lease_expires_at = null;
      }
      return Promise.resolve([]);
    }

    if (text.includes('summarized_at = NOW()')) {
      // completeSummary: values = [status, summary, model, contentHash, id]
      const [status, summary, model, contentHash, id] = values as [string, string, string, string, string];
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.status = status as FakeRow['status'];
        row.summary = summary;
        row.model = model;
        row.content_hash = contentHash;
        row.summarized_at = new Date().toISOString();
        row.attempts = 0;
        row.lease_owner = null;
        row.lease_expires_at = null;
      }
      return Promise.resolve([]);
    }

    if (text.includes('attempts = attempts + 1')) {
      // failSummary: values = [error, maxAttempts, id]
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

    throw new Error(`fakeSql: unrecognized query: ${text}`);
  }) as unknown as postgres.Sql;
  return fn;
}

describe('OutlineWindowStore.upsertBoundary', () => {
  it('inserts a new window and extends the open tail across calls', async () => {
    const rows: FakeRow[] = [];
    const store = new OutlineWindowStore(fakeSql(rows));

    await store.upsertBoundary('s1', { windowIndex: 0, fromSeq: 0, toSeq: 4, fromTs: 't0', toTs: 't4', closed: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.closed_at).toBeNull();
    expect(rows[0]!.to_seq).toBe(4);

    await store.upsertBoundary('s1', { windowIndex: 0, fromSeq: 0, toSeq: 8, fromTs: 't0', toTs: 't8', closed: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.to_seq).toBe(8);
  });

  it('never rewrites a window once closed (immutability)', async () => {
    const rows: FakeRow[] = [];
    const store = new OutlineWindowStore(fakeSql(rows));

    await store.upsertBoundary('s1', { windowIndex: 0, fromSeq: 0, toSeq: 4, fromTs: 't0', toTs: 't4', closed: true });
    const closedAt = rows[0]!.closed_at;
    expect(closedAt).not.toBeNull();

    // A stray re-plan attempts to extend the now-closed window — must be a no-op.
    await store.upsertBoundary('s1', { windowIndex: 0, fromSeq: 0, toSeq: 99, fromTs: 't0', toTs: 't99', closed: false });
    expect(rows[0]!.to_seq).toBe(4);
    expect(rows[0]!.closed_at).toBe(closedAt);
  });
});

describe('OutlineWindowStore claim/complete/fail — idempotency', () => {
  it('a closed window is claimed once and goes terminal (summarized) — never claimable again', async () => {
    const rows: FakeRow[] = [fakeRow({ id: 'w1', closed_at: new Date().toISOString() })];
    const store = new OutlineWindowStore(fakeSql(rows));

    expect(await store.claimOne('w1', 'owner-a', 300_000)).toBe(true);
    await store.completeSummary('w1', { summary: 'did stuff', model: 'test-model', contentHash: 'h1', closed: true });
    expect(rows[0]!.status).toBe('summarized');

    // A later sweep must not be able to reclaim it.
    expect(await store.claimOne('w1', 'owner-b', 300_000)).toBe(false);
    expect(rows[0]!.status).toBe('summarized');
  });

  it('two concurrent claims on the same row: only one succeeds (safe under a manual trigger racing the sweep)', async () => {
    const rows: FakeRow[] = [fakeRow({ id: 'w1' })];
    const store = new OutlineWindowStore(fakeSql(rows));

    const [a, b] = await Promise.all([
      store.claimOne('w1', 'owner-a', 300_000),
      store.claimOne('w1', 'owner-b', 300_000),
    ]);
    // Exactly one claimer wins.
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(rows[0]!.status).toBe('summarizing');
  });

  it('the open tail cycles back to pending with attempts reset on success, and is claimable again', async () => {
    const rows: FakeRow[] = [fakeRow({ id: 'tail', closed_at: null, attempts: 3 })];
    const store = new OutlineWindowStore(fakeSql(rows));

    await store.claimOne('tail', 'owner-a', 300_000);
    await store.completeSummary('tail', { summary: 'so far...', model: 'test-model', contentHash: 'hA', closed: false });
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.attempts).toBe(0);

    // Next sweep: claimable again.
    expect(await store.claimOne('tail', 'owner-b', 300_000)).toBe(true);
  });

  it('unchanged tail content is released without touching attempts or summary', async () => {
    const rows: FakeRow[] = [fakeRow({ id: 'tail', closed_at: null, summary: 'old summary', content_hash: 'hA', attempts: 1 })];
    const store = new OutlineWindowStore(fakeSql(rows));

    await store.claimOne('tail', 'owner-a', 300_000);
    await store.releaseUnchanged('tail');
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.summary).toBe('old summary');
    expect(rows[0]!.attempts).toBe(1);
  });

  it('a window fails repeatedly and goes terminal (failed) at the attempt cap', async () => {
    const rows: FakeRow[] = [fakeRow({ id: 'w1', closed_at: new Date().toISOString(), attempts: 4 })];
    const store = new OutlineWindowStore(fakeSql(rows));

    await store.claimOne('w1', 'owner-a', 300_000);
    await store.failSummary('w1', 'model timeout', 5);
    expect(rows[0]!.attempts).toBe(5);
    expect(rows[0]!.status).toBe('failed');

    // Terminal: no longer claimable.
    expect(await store.claimOne('w1', 'owner-b', 300_000)).toBe(false);
  });

  it('a failed attempt under the cap goes back to pending for the next sweep', async () => {
    const rows: FakeRow[] = [fakeRow({ id: 'w1', closed_at: new Date().toISOString(), attempts: 0 })];
    const store = new OutlineWindowStore(fakeSql(rows));

    await store.claimOne('w1', 'owner-a', 300_000);
    await store.failSummary('w1', 'transient error', 5);
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.status).toBe('pending');
    expect(await store.claimOne('w1', 'owner-b', 300_000)).toBe(true);
  });

  it('reclaimExpired returns a stuck lease (crashed sweep) to pending', async () => {
    const rows: FakeRow[] = [
      fakeRow({ id: 'w1', status: 'summarizing', lease_owner: 'dead-owner', lease_expires_at: new Date(Date.now() - 1000).toISOString() }),
      fakeRow({ id: 'w2', status: 'summarizing', lease_owner: 'live-owner', lease_expires_at: new Date(Date.now() + 1_000_000).toISOString() }),
    ];
    const store = new OutlineWindowStore(fakeSql(rows));

    const n = await store.reclaimExpired();
    expect(n).toBe(1);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[1]!.status).toBe('summarizing'); // untouched — lease not expired
  });
});

describe('OutlineWindowStore.boundaryState', () => {
  it('reports -1 / 0 when no closed windows exist yet', async () => {
    const rows: FakeRow[] = [fakeRow({ id: 'tail', closed_at: null })];
    const store = new OutlineWindowStore(fakeSql(rows));
    expect(await store.boundaryState('s1')).toEqual({ lastClosedToSeq: -1, closedCount: 0 });
  });

  it('reports the highest closed to_seq and the closed count', async () => {
    const rows: FakeRow[] = [
      fakeRow({ id: 'w0', window_index: 0, to_seq: 9, closed_at: 'x' }),
      fakeRow({ id: 'w1', window_index: 1, to_seq: 19, closed_at: 'x' }),
      fakeRow({ id: 'tail', window_index: 2, to_seq: 25, closed_at: null }),
    ];
    const store = new OutlineWindowStore(fakeSql(rows));
    expect(await store.boundaryState('s1')).toEqual({ lastClosedToSeq: 19, closedCount: 2 });
  });
});

// Config sanity — pin the documented defaults so a drift is a visible diff.
describe('DEFAULT_OUTLINE_WINDOW_CONFIG', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_OUTLINE_WINDOW_CONFIG).toEqual({
      thresholdMessages: 400,
      thresholdBytes: 2_000_000,
      maxMessages: 200,
      maxBytes: 500_000,
      maxSpanMs: 6 * 60 * 60 * 1000,
      sweepCap: 20,
      maxAttempts: 5,
    });
  });
});
