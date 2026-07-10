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
    model: 'claude-haiku-4-5',
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
    { type: 'correction', summary: 'Chris corrected the approach', confidence: 0.9, quote: 'no, do it this way' },
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

    expect(calls.length).toBe(0); // no delta → no Haiku call
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
