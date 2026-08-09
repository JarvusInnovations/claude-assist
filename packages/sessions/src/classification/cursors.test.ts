import { describe, expect, it, mock } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import { serializeSince, lastMessageSeq } from '../transcript.js';
import { ClassificationService } from './service.js';
import type { ClassificationEventClassifier } from './events.js';
import type { ClassificationStore } from './store.js';
import type { DetectedEvent, SessionForClassification } from './types.js';

/** Build a JSONL transcript line. */
function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}
function userMsg(uuid: string, ts: string, text: string): string {
  return line({ type: 'user', uuid, parentUuid: null, timestamp: ts, message: { role: 'user', content: text } });
}
function assistantMsg(uuid: string, ts: string, text: string): string {
  return line({ type: 'assistant', uuid, parentUuid: null, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

function makeLogger(): FastifyBaseLogger {
  return {
    info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}),
    debug: mock(() => {}), fatal: mock(() => {}), trace: mock(() => {}),
    child: () => makeLogger(),
  } as unknown as FastifyBaseLogger;
}

const BASE = [
  userMsg('u0', '2026-07-01T10:00:00Z', 'first task'),
  assistantMsg('u1', '2026-07-01T10:00:05Z', 'working on it'),
  userMsg('u2', '2026-07-01T10:01:00Z', 'second task'),
  assistantMsg('u3', '2026-07-01T10:01:05Z', 'done'),
].join('\n');

describe('serializeSince — delta-only windowing', () => {
  it('serializes only messages after the cursor seq', () => {
    const full = serializeSince(BASE, -1);
    expect(full.seqStart).toBe(0);
    expect(full.seqEnd).toBe(3);
    expect(full.count).toBe(4);
    expect(full.text).toContain('first task');
    expect(full.text).toContain('done');

    const delta = serializeSince(BASE, 1); // resume after u1
    expect(delta.seqStart).toBe(2);
    expect(delta.seqEnd).toBe(3);
    expect(delta.count).toBe(2);
    expect(delta.text).not.toContain('first task');
    expect(delta.text).toContain('second task');
  });

  it('is idempotent: re-serializing from the advanced cursor yields an empty window', () => {
    const first = serializeSince(BASE, -1);
    const again = serializeSince(BASE, first.seqEnd);
    expect(again.count).toBe(0);
    expect(again.text).toBe('');
    // Cursor does not move backward or skip.
    expect(again.seqEnd).toBe(first.seqEnd);
  });

  it('processes only appended messages when a long-running session grows', () => {
    const prevSeq = lastMessageSeq(BASE); // 3
    const grown =
      BASE + '\n' +
      userMsg('u4', '2026-07-01T10:05:00Z', 'a third, later task') + '\n' +
      assistantMsg('u5', '2026-07-01T10:05:05Z', 'handled');

    const delta = serializeSince(grown, prevSeq);
    expect(delta.seqStart).toBe(4);
    expect(delta.seqEnd).toBe(5);
    expect(delta.count).toBe(2);
    expect(delta.text).toContain('third, later task');
    expect(delta.text).not.toContain('first task');
    expect(delta.text).not.toContain('second task');
  });
});

// A store double that records every call, so we can assert cursor advancement
// and append-only event writes without a live database.
function makeRecordingStore() {
  const appended: Array<{ sessionId: string; seqStart: number; seqEnd: number; events: DetectedEvent[] }> = [];
  const advanced: Array<{ sessionId: string; lastSeq: number; hash: string; finalPass: boolean }> = [];
  const failures: string[] = [];
  const store = {
    appendEvents: mock(async (sessionId: string, seqStart: number, seqEnd: number, events: DetectedEvent[]) => {
      appended.push({ sessionId, seqStart, seqEnd, events });
    }),
    advanceCursor: mock(async (sessionId: string, lastSeq: number, hash: string, _mc: number, finalPass: boolean) => {
      advanced.push({ sessionId, lastSeq, hash, finalPass });
    }),
    recordFailure: mock(async (sessionId: string) => {
      failures.push(sessionId);
      return failures.filter((f) => f === sessionId).length;
    }),
  } as unknown as ClassificationStore;
  return { store, appended, advanced, failures };
}

function makeClassifier(events: DetectedEvent[]): { classifier: ClassificationEventClassifier; calls: number[] } {
  const calls: number[] = [];
  const classifier = {
    model: 'test-classify-model',
    classifyDelta: mock(async () => {
      calls.push(1);
      return events;
    }),
  } as unknown as ClassificationEventClassifier;
  return { classifier, calls };
}

function sessionRow(overrides: Partial<SessionForClassification> = {}): SessionForClassification {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    project_path: '/repo/thing',
    git_branch: 'main',
    raw_transcript: BASE,
    transcript_hash: 'hashA',
    ended_at: new Date('2026-07-01T10:01:05Z'), // long quiet → final pass
    output_tokens: '100',
    cursor_last_seq: null,
    cursor_last_hash: null,
    cursor_final_pass_done: null,
    ...overrides,
  };
}

describe('ClassificationService.classifyOne (via classifyBatch)', () => {
  const detected: DetectedEvent[] = [
    { type: 'correction', summary: 'the owner corrected the approach', confidence: 0.9, quote: 'no, do it this way' },
  ];

  it('classifies a fresh session, appends events, and advances the cursor to seqEnd', async () => {
    const { store, appended, advanced } = makeRecordingStore();
    const { classifier, calls } = makeClassifier(detected);
    const svc = new ClassificationService(store, classifier, makeLogger());

    const result = await (svc as unknown as {
      classifyBatch(s: SessionForClassification[]): Promise<{ sessionsClassified: number; eventsAppended: number }>;
    }).classifyBatch([sessionRow()]);

    expect(calls.length).toBe(1);
    expect(result.sessionsClassified).toBe(1);
    expect(result.eventsAppended).toBe(1);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.seqStart).toBe(0);
    expect(appended[0]!.seqEnd).toBe(3);
    expect(advanced).toHaveLength(1);
    expect(advanced[0]!.lastSeq).toBe(3);
    expect(advanced[0]!.hash).toBe('hashA');
    // ended >48h before "now" → terminal (final) pass flagged.
    expect(advanced[0]!.finalPass).toBe(true);
  });

  it('re-ingest with no new messages is a no-op call: advances hash, appends nothing, no model spend', async () => {
    const { store, appended, advanced } = makeRecordingStore();
    const { classifier, calls } = makeClassifier(detected);
    const svc = new ClassificationService(store, classifier, makeLogger());

    // Cursor already at the end of this transcript (seq 3).
    await (svc as unknown as {
      classifyBatch(s: SessionForClassification[]): Promise<unknown>;
    }).classifyBatch([sessionRow({ cursor_last_seq: 3, cursor_last_hash: 'hashOld' })]);

    expect(calls.length).toBe(0); // no delta → no model call
    expect(appended).toHaveLength(0); // append-only: nothing written
    expect(advanced).toHaveLength(1); // hash advanced so it isn't re-selected
    expect(advanced[0]!.hash).toBe('hashA');
  });

  it('holds a small, still-active delta without spending on the model', async () => {
    const { store, appended, advanced } = makeRecordingStore();
    const { classifier, calls } = makeClassifier(detected);
    const svc = new ClassificationService(store, classifier, makeLogger(), { minDelta: 6 });

    // Active session (ended just now), only a 2-message delta < minDelta.
    const result = await (svc as unknown as {
      classifyBatch(s: SessionForClassification[]): Promise<{ sessionsSkipped: number }>;
    }).classifyBatch([sessionRow({ cursor_last_seq: 1, ended_at: new Date() })]);

    expect(calls.length).toBe(0);
    expect(result.sessionsSkipped).toBe(1);
    expect(appended).toHaveLength(0);
    expect(advanced).toHaveLength(0); // cursor untouched → re-selected next cycle
  });
});

// ── Resumed old sessions ─────────────────────────────────────────────────────
// the owner routinely resumes sessions long after they went quiet (e.g. the
// invoicing session a month later). A session that was already final-passed
// (cursor at seq 3, final_pass_done=true) must classify its resumed segment
// fully — both a large delta and a small tail flushed by the next quiet pass —
// and the resumed pass must RESET final_pass_done (it no longer covers the
// tail) so a later quiet period triggers a fresh final pass.

function grow(base: string, extra: number, startUuid: number, ts: string): string {
  const lines: string[] = [];
  for (let i = 0; i < extra; i++) {
    const uuid = `r${startUuid + i}`;
    lines.push(
      i % 2 === 0
        ? userMsg(uuid, ts, `resumed request ${i}`)
        : assistantMsg(uuid, ts, `resumed reply ${i}`)
    );
  }
  return base + '\n' + lines.join('\n');
}

describe('ClassificationService — resumed session after a final pass', () => {
  const detected: DetectedEvent[] = [
    { type: 'notable-decision', summary: 'resumed-segment decision', confidence: 0.8, quote: null },
  ];

  // The session started long ago; only its transcript activity is recent.
  const finalPassedCursor = {
    cursor_last_seq: 3,
    cursor_last_hash: 'hashOld',
    cursor_final_pass_done: true,
  };

  it('(a) large resumed delta classifies fully and RESETS final_pass_done while active', async () => {
    const { store, appended, advanced } = makeRecordingStore();
    const { classifier, calls } = makeClassifier(detected);
    const svc = new ClassificationService(store, classifier, makeLogger(), { minDelta: 6 });

    // 8 new messages (seqs 4..11), session active again (ended just now).
    const resumed = grow(BASE, 8, 0, new Date().toISOString());
    const result = await (svc as unknown as {
      classifyBatch(s: SessionForClassification[]): Promise<{ sessionsClassified: number }>;
    }).classifyBatch([
      sessionRow({
        ...finalPassedCursor,
        raw_transcript: resumed,
        transcript_hash: 'hashResumed',
        ended_at: new Date(),
      }),
    ]);

    expect(calls.length).toBe(1);
    expect(result.sessionsClassified).toBe(1);
    // Only the resumed segment is classified — never the already-covered head.
    expect(appended).toHaveLength(1);
    expect(appended[0]!.seqStart).toBe(4);
    expect(appended[0]!.seqEnd).toBe(11);
    expect(advanced).toHaveLength(1);
    expect(advanced[0]!.lastSeq).toBe(11);
    expect(advanced[0]!.hash).toBe('hashResumed');
    // Session is active again → the fresh flag is false; combined with the
    // store's advance-past-final-pass CASE, final_pass_done resets to false.
    expect(advanced[0]!.finalPass).toBe(false);
  });

  it('(b) a 2-message resumed tail is held while active, then flushed by the quiet pass as a fresh final pass', async () => {
    const { store, appended, advanced } = makeRecordingStore();
    const { classifier, calls } = makeClassifier(detected);
    const svc = new ClassificationService(store, classifier, makeLogger(), { minDelta: 6 });
    const batch = (s: SessionForClassification[]) =>
      (svc as unknown as {
        classifyBatch(s: SessionForClassification[]): Promise<{ sessionsClassified: number; sessionsSkipped: number }>;
      }).classifyBatch(s);

    // Resumed with only 2 new messages (seqs 4..5).
    const resumed = grow(BASE, 2, 0, new Date().toISOString());
    const row = sessionRow({
      ...finalPassedCursor,
      raw_transcript: resumed,
      transcript_hash: 'hashResumed',
    });

    // While the resumed segment is active: held, no spend, cursor untouched
    // (so the hash mismatch keeps it selected on later sweeps).
    const held = await batch([{ ...row, ended_at: new Date() }]);
    expect(held.sessionsSkipped).toBe(1);
    expect(calls.length).toBe(0);
    expect(advanced).toHaveLength(0);

    // 3 days later, still selected (activity within lookback), now quiet:
    // the tail flushes and this pass is a fresh final pass over the segment.
    const quiet = await batch([
      { ...row, ended_at: new Date(Date.now() - 3 * 24 * 3600 * 1000) },
    ]);
    expect(quiet.sessionsClassified).toBe(1);
    expect(calls.length).toBe(1);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.seqStart).toBe(4);
    expect(appended[0]!.seqEnd).toBe(5);
    expect(advanced).toHaveLength(1);
    expect(advanced[0]!.lastSeq).toBe(5);
    expect(advanced[0]!.finalPass).toBe(true);
  });
});

// ── Store SQL contracts for the resume fixes ────────────────────────────────
// Pin the two load-bearing SQL details with query-text assertions (behavior is
// additionally exercised against a real Postgres in the repo's smoke run):
// selection must window on transcript ACTIVITY (synced_at), and the cursor
// upsert must reset final_pass_done when last_seq advances past it.

function recordingSql(): { sql: import('postgres').Sql; queries: string[] } {
  const queries: string[] = [];
  const fn = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
    if (Array.isArray(strings) && 'raw' in strings) queries.push(strings.join(' ? '));
    return Promise.resolve([]);
  }) as unknown as import('postgres').Sql;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return { sql: fn, queries };
}

describe('ClassificationStore SQL contracts', () => {
  it('selectForClassification windows on synced_at (activity), not started_at', async () => {
    const { sql, queries } = recordingSql();
    const { ClassificationStore } = await import('./store.js');
    await new ClassificationStore(sql).selectForClassification(50, 5, '3 days');
    const q = queries[0]!;
    expect(q).toContain('s.synced_at > NOW() -');
    expect(q).not.toContain('s.started_at >');
  });

  it('advanceCursor resets final_pass_done when the cursor advances past it', async () => {
    const { sql, queries } = recordingSql();
    const { ClassificationStore } = await import('./store.js');
    await new ClassificationStore(sql).advanceCursor('sid', 11, 'h', 12, false);
    const q = queries[0]!;
    expect(q).toContain('CASE');
    expect(q).toContain('EXCLUDED.last_seq > sessions.classification_cursors.last_seq');
    expect(q).toContain('THEN EXCLUDED.final_pass_done');
  });
});
