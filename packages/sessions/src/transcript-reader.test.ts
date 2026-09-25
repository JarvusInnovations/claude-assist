import { describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { TranscriptReader } from './transcript-reader.js';
import { feed, EMPTY_CHECKPOINT } from './incremental-parser.js';
import { chunkLines, splitLinesWithTerminators } from './chunked-ingest.js';

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

const TRANSCRIPT = [
  userMsg('u0', '2026-07-01T10:00:00Z', 'first task'),
  assistantMsg('u1', '2026-07-01T10:00:05Z', 'working on it'),
  userMsg('u2', '2026-07-01T10:01:00Z', 'second task'),
  assistantMsg('u3', '2026-07-01T10:01:05Z', 'done'),
].join('\n');

const KNOWN_ID = '00000000-0000-0000-0000-000000000001';
const MISSING_ID = '00000000-0000-0000-0000-000000000099';

/** Chunk a transcript with the real production chunker/parser, for a
 * realistic chunked-session fixture (not a hand-rolled approximation). */
function buildChunks(transcript: string, chunkMaxBytes: number) {
  const lines = splitLinesWithTerminators(transcript);
  const { lineSeqs } = feed(EMPTY_CHECKPOINT, lines);
  return chunkLines(lines, lineSeqs, 0, chunkMaxBytes).map((c, i) => ({ ...c, seq: i }));
}

/** A fake `sessions.sessions`/`transcript_chunks`/`transcript_messages` set,
 * keyed by session id, backed by chunk rows + a message index — matching the
 * query shapes `TranscriptReader` issues (a real Postgres isn't available in
 * CI). `existingIds` distinguishes a session with zero chunks (empty archive)
 * from a session that doesn't exist at all. */
function fakeSql(
  existingIds: Set<string>,
  chunksBySession: Record<string, ReturnType<typeof buildChunks>> = {},
  messagesBySession: Record<string, Array<{ seq: number; uuid: string }>> = {},
  ingestedBytesBySession: Record<string, number> = {}
): postgres.Sql {
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');

    if (text.includes('SELECT id FROM sessions.sessions WHERE id =')) {
      const [sessionId] = values as [string];
      return Promise.resolve(existingIds.has(sessionId) ? [{ id: sessionId }] : []);
    }

    if (text.includes('SELECT ingested_bytes FROM sessions.sessions')) {
      const [sessionId] = values as [string];
      if (!existingIds.has(sessionId)) return Promise.resolve([]);
      return Promise.resolve([{ ingested_bytes: ingestedBytesBySession[sessionId] ?? 0 }]);
    }

    if (text.includes('SELECT DISTINCT session_id AS id FROM sessions.transcript_chunks')) {
      const ids = Object.keys(chunksBySession).filter((id) => chunksBySession[id]!.length > 0);
      return Promise.resolve(ids.map((id) => ({ id })));
    }

    const [sessionId] = values as [string];
    const chunks = chunksBySession[sessionId] ?? [];

    if (text.includes('ORDER BY seq DESC LIMIT 1') && text.includes('byte_end')) {
      const last = chunks[chunks.length - 1];
      return Promise.resolve(last ? [{ byte_end: last.byteEnd }] : []);
    }
    if (text.includes('byte_start < ?')) {
      const [, half] = values as [string, number];
      return Promise.resolve(chunks.filter((c) => c.byteStart < half).map((c) => ({ content: c.content })));
    }
    if (text.includes('byte_end > ?')) {
      const [, threshold] = values as [string, number];
      return Promise.resolve(chunks.filter((c) => c.byteEnd > threshold).map((c) => ({ content: c.content })));
    }
    if (text.includes('SELECT seq FROM sessions.transcript_messages')) {
      const [, uuid] = values as [string, string];
      const row = (messagesBySession[sessionId] ?? []).find((m) => m.uuid === uuid);
      return Promise.resolve(row ? [{ seq: row.seq }] : []);
    }
    if (text.includes('msg_seq_end >=') && text.includes('msg_seq_start <=')) {
      // readAround / find / messageRange / since / messagesSince range fetch.
      const [, seqStart, seqEnd] = values as [string, number, number];
      const filtered = chunks.filter((c) => c.msgSeqEnd >= seqStart && c.msgSeqStart <= (seqEnd ?? Infinity));
      return Promise.resolve(filtered.map((c) => ({ msg_seq_start: c.msgSeqStart, content: c.content })));
    }
    if (text.includes('msg_seq_end >=') && text.includes('ORDER BY seq DESC')) {
      // since()'s newest-first qualifying-chunk fetch.
      const [, afterSeqPlus1] = values as [string, number];
      const filtered = chunks.filter((c) => c.msgSeqEnd >= afterSeqPlus1).slice().reverse();
      return Promise.resolve(filtered.map((c) => ({ msg_seq_start: c.msgSeqStart, content: c.content })));
    }
    if (text.includes('msg_seq_end >=')) {
      // messagesSince: a lower bound only, no upper bound, ORDER BY seq ASC.
      const [, afterSeqPlus1] = values as [string, number];
      const filtered = chunks.filter((c) => c.msgSeqEnd >= afterSeqPlus1);
      return Promise.resolve(filtered.map((c) => ({ msg_seq_start: c.msgSeqStart, content: c.content })));
    }
    if (text.includes('SELECT content FROM sessions.transcript_chunks')) {
      // readFullChunked, or find()'s unbounded fallback
      return Promise.resolve(chunks.map((c) => ({ content: c.content })));
    }

    throw new Error(`fakeSql: unrecognized query: ${text}`);
  }) as unknown as postgres.Sql;
  return fn;
}

function fakeReader(transcript: string, chunkMaxBytes = 10_000_000, ingestedBytes?: number) {
  const chunks = buildChunks(transcript, chunkMaxBytes);
  const messages = [
    { seq: 0, uuid: 'u0' },
    { seq: 1, uuid: 'u1' },
    { seq: 2, uuid: 'u2' },
    { seq: 3, uuid: 'u3' },
  ];
  const sql = fakeSql(
    new Set([KNOWN_ID]),
    { [KNOWN_ID]: chunks },
    { [KNOWN_ID]: messages },
    { [KNOWN_ID]: ingestedBytes ?? Buffer.byteLength(transcript, 'utf8') }
  );
  return new TranscriptReader(sql);
}

describe('TranscriptReader.readFull', () => {
  it('returns the full transcript for an existing session (concatenated from chunks)', async () => {
    const reader = fakeReader(TRANSCRIPT);
    expect(await reader.readFull(KNOWN_ID)).toBe(TRANSCRIPT);
  });

  it('returns null for a session that does not exist', async () => {
    const reader = fakeReader(TRANSCRIPT);
    expect(await reader.readFull(MISSING_ID)).toBeNull();
  });
});

describe('TranscriptReader.readHeadTail', () => {
  it('returns the whole transcript untouched when under budget', async () => {
    const reader = fakeReader(TRANSCRIPT);
    const { raw, fullLength } = await reader.readHeadTail(KNOWN_ID, 1_000_000);
    expect(raw).toBe(TRANSCRIPT);
    expect(fullLength).toBe(Buffer.byteLength(TRANSCRIPT, 'utf8'));
  });

  it('samples head+tail from boundary chunks when the transcript exceeds the budget', async () => {
    const reader = fakeReader(TRANSCRIPT, 40); // tiny cap forces several chunks
    const { raw, fullLength } = await reader.readHeadTail(KNOWN_ID, 20);
    expect(fullLength).toBe(Buffer.byteLength(TRANSCRIPT, 'utf8'));
    expect(raw.length).toBeGreaterThan(0);
  });

  it('returns an empty sample for a missing session', async () => {
    const reader = fakeReader(TRANSCRIPT);
    const { raw, fullLength } = await reader.readHeadTail(MISSING_ID, 100);
    expect(raw).toBe('');
    expect(fullLength).toBe(0);
  });
});

describe('TranscriptReader.serialize', () => {
  it('serializes an existing transcript to the [U]/[A] format', async () => {
    const reader = fakeReader(TRANSCRIPT);
    const text = await reader.serialize(KNOWN_ID);
    expect(text).toContain('[U] first task');
    expect(text).toContain('[A] done');
  });

  it('returns "" for a missing session (no 404 signal — matches cross-session/share callers)', async () => {
    const reader = fakeReader(TRANSCRIPT);
    expect(await reader.serialize(MISSING_ID)).toBe('');
  });
});

describe('TranscriptReader.messageRange and since', () => {
  it('messageRange serializes a bounded range', async () => {
    const reader = fakeReader(TRANSCRIPT);
    const r = await reader.messageRange(KNOWN_ID, 1, 2);
    expect(r.seqStart).toBe(1);
    expect(r.seqEnd).toBe(2);
    expect(r.text).toContain('working on it');
  });

  it('since serializes the delta after a cursor seq', async () => {
    const reader = fakeReader(TRANSCRIPT);
    const delta = await reader.since(KNOWN_ID, 1);
    expect(delta.seqStart).toBe(2);
    expect(delta.seqEnd).toBe(3);
    expect(delta.count).toBe(2);
  });
});

describe('TranscriptReader.readAround', () => {
  it('finds a window around an anchor uuid', async () => {
    const reader = fakeReader(TRANSCRIPT);
    const { sessionFound, window } = await reader.readAround(KNOWN_ID, 'u1', 1, 1);
    expect(sessionFound).toBe(true);
    expect(window?.anchor).toBe('u1');
  });

  it('reports the session missing distinctly from the anchor missing', async () => {
    const reader = fakeReader(TRANSCRIPT);
    const missingAnchor = await reader.readAround(KNOWN_ID, 'does-not-exist', 1, 1);
    expect(missingAnchor.sessionFound).toBe(true);
    expect(missingAnchor.window).toBeNull();

    const missingSession = await reader.readAround(MISSING_ID, 'u1', 1, 1);
    expect(missingSession.sessionFound).toBe(false);
    expect(missingSession.window).toBeNull();
  });
});

describe('TranscriptReader.find', () => {
  it('returns matches for an existing session', async () => {
    const reader = fakeReader(TRANSCRIPT);
    const { sessionFound, matches } = await reader.find(KNOWN_ID, { match: 'second', in: 'text' });
    expect(sessionFound).toBe(true);
    expect(matches).toHaveLength(1);
  });

  it('reports the session missing distinctly from zero matches', async () => {
    const reader = fakeReader(TRANSCRIPT);
    const noMatch = await reader.find(KNOWN_ID, { match: 'nope', in: 'text' });
    expect(noMatch.sessionFound).toBe(true);
    expect(noMatch.matches).toHaveLength(0);

    const missing = await reader.find(MISSING_ID, { match: 'second', in: 'text' });
    expect(missing.sessionFound).toBe(false);
    expect(missing.matches).toHaveLength(0);
  });
});

describe('TranscriptReader.readRawMessages', () => {
  it('parses every JSONL line to a plain object, dropping malformed lines', async () => {
    const raw = TRANSCRIPT + '\nnot json\n' + line({ type: 'custom-title', title: 'x' });
    const reader = fakeReader(raw);
    const messages = await reader.readRawMessages(KNOWN_ID);
    // 4 real messages + the custom-title line; the malformed line is dropped.
    expect(messages).toHaveLength(5);
    expect((messages[4] as { type: string }).type).toBe('custom-title');
  });

  it('returns [] for a missing session', async () => {
    const reader = fakeReader(TRANSCRIPT);
    expect(await reader.readRawMessages(MISSING_ID)).toEqual([]);
  });
});

describe('TranscriptReader.rawByteLength', () => {
  it('returns ingested_bytes without needing the content', async () => {
    const reader = fakeReader(TRANSCRIPT);
    expect(await reader.rawByteLength(KNOWN_ID)).toBe(Buffer.byteLength(TRANSCRIPT, 'utf8'));
  });

  it('returns 0 for a missing session', async () => {
    const reader = fakeReader(TRANSCRIPT);
    expect(await reader.rawByteLength(MISSING_ID)).toBe(0);
  });
});

describe('TranscriptReader.messagesSince', () => {
  it('returns only messages after afterSeq', async () => {
    const reader = fakeReader(TRANSCRIPT);
    const msgs = await reader.messagesSince(KNOWN_ID, 1);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.uuid).toBe('u2');
  });

  it('returns all messages when afterSeq is -1', async () => {
    const reader = fakeReader(TRANSCRIPT);
    const msgs = await reader.messagesSince(KNOWN_ID, -1);
    expect(msgs).toHaveLength(4);
  });

  it('returns [] for a missing session', async () => {
    const reader = fakeReader(TRANSCRIPT);
    expect(await reader.messagesSince(MISSING_ID, -1)).toEqual([]);
  });
});

describe('TranscriptReader.listSessionIdsWithContent', () => {
  it('excludes sessions with no chunk rows', async () => {
    const chunks = buildChunks(TRANSCRIPT, 10_000_000);
    const sql = fakeSql(new Set([KNOWN_ID, 'empty-session']), { [KNOWN_ID]: chunks, 'empty-session': [] });
    const reader = new TranscriptReader(sql);
    const ids = await reader.listSessionIdsWithContent();
    expect(ids).toEqual([KNOWN_ID]);
  });
});

describe('TranscriptReader — multi-chunk ranges', () => {
  it('readFull/serialize/readAround/find agree with a single-chunk fixture on a tiny chunk cap', async () => {
    const reader = fakeReader(TRANSCRIPT, 40); // tiny cap forces several chunks
    expect(await reader.readFull(KNOWN_ID)).toBe(TRANSCRIPT);
    const text = await reader.serialize(KNOWN_ID);
    expect(text).toContain('[U] first task');
    expect(text).toContain('[A] done');

    const around = await reader.readAround(KNOWN_ID, 'u1', 1, 1);
    expect(around.sessionFound).toBe(true);
    expect(around.window?.lines.some((l) => l.includes('first task'))).toBe(true);
    expect(around.window?.lines.some((l) => l.includes('second task'))).toBe(true);

    const found = await reader.find(KNOWN_ID, { match: 'second', in: 'text' });
    expect(found.sessionFound).toBe(true);
    expect(found.matches).toHaveLength(1);
  });
});
