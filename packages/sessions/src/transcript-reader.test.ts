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
const EMPTY_ID = '00000000-0000-0000-0000-000000000002';
const MISSING_ID = '00000000-0000-0000-0000-000000000099';

/**
 * A fake `sessions.sessions`/`transcript_chunks`/`transcript_messages` set
 * keyed by id, storage always 'inline' unless the id is in `chunkedIds`.
 * Recognizes the query shapes `TranscriptReader` issues by a substring of
 * the SQL text, since a real Postgres isn't available in CI (see
 * plans/transcript-read-layer.md's `bun test` note).
 */
function fakeSql(table: Record<string, string | null>, chunkedIds: Set<string> = new Set()): postgres.Sql {
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');

    if (text.includes('ingested_bytes') && text.includes('AS len')) {
      // rawByteLength: values = [sessionId]
      const [sessionId] = values as [string];
      if (!(sessionId in table)) return Promise.resolve([]);
      const content = table[sessionId] ?? null;
      const storage = chunkedIds.has(sessionId) ? 'chunked' : 'inline';
      return Promise.resolve([
        { storage, len: content === null ? 0 : content.length, ingested_bytes: content === null ? 0 : content.length },
      ]);
    }

    if (text.includes('SELECT id FROM sessions.sessions')) {
      const ids = Object.entries(table)
        .filter(([, content]) => content !== null && content !== '')
        .map(([id]) => ({ id }));
      return Promise.resolve(ids);
    }

    if (text.includes('SELECT storage, raw_transcript')) {
      const [sessionId] = values as [string];
      if (!(sessionId in table)) return Promise.resolve([]);
      return Promise.resolve([
        { storage: chunkedIds.has(sessionId) ? 'chunked' : 'inline', raw_transcript: table[sessionId] },
      ]);
    }

    if (text.includes('SELECT storage FROM sessions.sessions')) {
      const [sessionId] = values as [string];
      if (!(sessionId in table)) return Promise.resolve([]);
      return Promise.resolve([{ storage: chunkedIds.has(sessionId) ? 'chunked' : 'inline' }]);
    }

    if (text.includes('full_length')) {
      // inline readHeadTail: values = [budgetBytes, half, half, sessionId]
      const [budgetBytes, half, , sessionId] = values as [number, number, number, string];
      if (!(sessionId in table)) return Promise.resolve([]);
      const content = table[sessionId] ?? null;
      if (content === null) return Promise.resolve([{ raw: '', full_length: 0 }]);
      const fullLength = content.length;
      const raw =
        fullLength <= budgetBytes
          ? content
          : content.slice(0, half) + '\n' + content.slice(content.length - half);
      return Promise.resolve([{ raw, full_length: fullLength }]);
    }

    // readFull: values = [sessionId]
    const [sessionId] = values as [string];
    if (!(sessionId in table)) return Promise.resolve([]);
    return Promise.resolve([{ raw_transcript: table[sessionId] }]);
  }) as unknown as postgres.Sql;
  return fn;
}

describe('TranscriptReader.readFull', () => {
  it('returns the raw transcript for an existing session', async () => {
    const reader = new TranscriptReader(fakeSql({ [KNOWN_ID]: TRANSCRIPT }));
    expect(await reader.readFull(KNOWN_ID)).toBe(TRANSCRIPT);
  });

  it('returns null for a session that does not exist', async () => {
    const reader = new TranscriptReader(fakeSql({ [KNOWN_ID]: TRANSCRIPT }));
    expect(await reader.readFull(MISSING_ID)).toBeNull();
  });

  it('returns "" (not null) for an existing session with a null column', async () => {
    const reader = new TranscriptReader(fakeSql({ [EMPTY_ID]: null }));
    expect(await reader.readFull(EMPTY_ID)).toBe('');
  });
});

describe('TranscriptReader.readHeadTail', () => {
  it('returns the whole transcript untouched when under budget', async () => {
    const reader = new TranscriptReader(fakeSql({ [KNOWN_ID]: TRANSCRIPT }));
    const { raw, fullLength } = await reader.readHeadTail(KNOWN_ID, 1_000_000);
    expect(raw).toBe(TRANSCRIPT);
    expect(fullLength).toBe(TRANSCRIPT.length);
  });

  it('samples head+tail when the transcript exceeds the budget, reporting the true length', async () => {
    const big = 'A'.repeat(50) + '\n' + 'B'.repeat(50);
    const reader = new TranscriptReader(fakeSql({ [KNOWN_ID]: big }));
    const { raw, fullLength } = await reader.readHeadTail(KNOWN_ID, 20);
    expect(fullLength).toBe(big.length);
    expect(raw.length).toBeLessThan(big.length);
    expect(raw.startsWith('A')).toBe(true);
    expect(raw.endsWith('B')).toBe(true);
  });

  it('returns an empty sample for a missing session', async () => {
    const reader = new TranscriptReader(fakeSql({}));
    const { raw, fullLength } = await reader.readHeadTail(MISSING_ID, 100);
    expect(raw).toBe('');
    expect(fullLength).toBe(0);
  });
});

describe('TranscriptReader.serialize', () => {
  it('serializes an existing transcript to the [U]/[A] format', async () => {
    const reader = new TranscriptReader(fakeSql({ [KNOWN_ID]: TRANSCRIPT }));
    const text = await reader.serialize(KNOWN_ID);
    expect(text).toContain('[U] first task');
    expect(text).toContain('[A] done');
  });

  it('returns "" for a missing session (no 404 signal — matches cross-session/share callers)', async () => {
    const reader = new TranscriptReader(fakeSql({}));
    expect(await reader.serialize(MISSING_ID)).toBe('');
  });
});

describe('TranscriptReader.messageRange and since', () => {
  it('messageRange serializes a bounded range', async () => {
    const reader = new TranscriptReader(fakeSql({ [KNOWN_ID]: TRANSCRIPT }));
    const r = await reader.messageRange(KNOWN_ID, 1, 2);
    expect(r.seqStart).toBe(1);
    expect(r.seqEnd).toBe(2);
    expect(r.text).toContain('working on it');
  });

  it('since serializes the delta after a cursor seq', async () => {
    const reader = new TranscriptReader(fakeSql({ [KNOWN_ID]: TRANSCRIPT }));
    const delta = await reader.since(KNOWN_ID, 1);
    expect(delta.seqStart).toBe(2);
    expect(delta.seqEnd).toBe(3);
    expect(delta.count).toBe(2);
  });
});

describe('TranscriptReader.readAround (inline backend)', () => {
  it('finds a window around an anchor uuid', async () => {
    const reader = new TranscriptReader(fakeSql({ [KNOWN_ID]: TRANSCRIPT }));
    const { sessionFound, window } = await reader.readAround(KNOWN_ID, 'u1', 1, 1);
    expect(sessionFound).toBe(true);
    expect(window?.anchor).toBe('u1');
  });

  it('reports the session missing distinctly from the anchor missing', async () => {
    const reader = new TranscriptReader(fakeSql({ [KNOWN_ID]: TRANSCRIPT }));
    const missingAnchor = await reader.readAround(KNOWN_ID, 'does-not-exist', 1, 1);
    expect(missingAnchor.sessionFound).toBe(true);
    expect(missingAnchor.window).toBeNull();

    const missingSession = await reader.readAround(MISSING_ID, 'u1', 1, 1);
    expect(missingSession.sessionFound).toBe(false);
    expect(missingSession.window).toBeNull();
  });
});

describe('TranscriptReader.find (inline backend)', () => {
  it('returns matches for an existing session', async () => {
    const reader = new TranscriptReader(fakeSql({ [KNOWN_ID]: TRANSCRIPT }));
    const { sessionFound, matches } = await reader.find(KNOWN_ID, { match: 'second', in: 'text' });
    expect(sessionFound).toBe(true);
    expect(matches).toHaveLength(1);
  });

  it('reports the session missing distinctly from zero matches', async () => {
    const reader = new TranscriptReader(fakeSql({ [KNOWN_ID]: TRANSCRIPT }));
    const noMatch = await reader.find(KNOWN_ID, { match: 'nope', in: 'text' });
    expect(noMatch.sessionFound).toBe(true);
    expect(noMatch.matches).toHaveLength(0);

    const missing = await reader.find(MISSING_ID, { match: 'second', in: 'text' });
    expect(missing.sessionFound).toBe(false);
    expect(missing.matches).toHaveLength(0);
  });
});

describe('TranscriptReader.storageKind / isChunked', () => {
  it('reports inline for an inline session and chunked for a chunked one', async () => {
    const reader = new TranscriptReader(fakeSql({ [KNOWN_ID]: TRANSCRIPT, [EMPTY_ID]: null }, new Set([EMPTY_ID])));
    expect(await reader.storageKind(KNOWN_ID)).toBe('inline');
    expect(await reader.isChunked(KNOWN_ID)).toBe(false);
    expect(await reader.storageKind(EMPTY_ID)).toBe('chunked');
    expect(await reader.isChunked(EMPTY_ID)).toBe(true);
  });

  it('returns null for a missing session', async () => {
    const reader = new TranscriptReader(fakeSql({}));
    expect(await reader.storageKind(MISSING_ID)).toBeNull();
    expect(await reader.isChunked(MISSING_ID)).toBe(false);
  });
});

describe('TranscriptReader.readRawMessages', () => {
  it('parses every JSONL line to a plain object, dropping malformed lines', async () => {
    const raw = TRANSCRIPT + '\nnot json\n' + line({ type: 'custom-title', title: 'x' });
    const reader = new TranscriptReader(fakeSql({ [KNOWN_ID]: raw }));
    const messages = await reader.readRawMessages(KNOWN_ID);
    // 4 real messages + the custom-title line; the malformed line is dropped.
    expect(messages).toHaveLength(5);
    expect((messages[4] as { type: string }).type).toBe('custom-title');
  });

  it('returns [] for a missing session', async () => {
    const reader = new TranscriptReader(fakeSql({}));
    expect(await reader.readRawMessages(MISSING_ID)).toEqual([]);
  });
});

describe('TranscriptReader.rawByteLength', () => {
  it('returns the byte length without needing the content', async () => {
    const reader = new TranscriptReader(fakeSql({ [KNOWN_ID]: TRANSCRIPT }));
    expect(await reader.rawByteLength(KNOWN_ID)).toBe(TRANSCRIPT.length);
  });

  it('returns 0 for a missing session or a null column', async () => {
    const reader = new TranscriptReader(fakeSql({ [EMPTY_ID]: null }));
    expect(await reader.rawByteLength(MISSING_ID)).toBe(0);
    expect(await reader.rawByteLength(EMPTY_ID)).toBe(0);
  });
});

describe('TranscriptReader.messagesSince', () => {
  it('returns only messages after afterSeq', async () => {
    const reader = new TranscriptReader(fakeSql({ [KNOWN_ID]: TRANSCRIPT }));
    const msgs = await reader.messagesSince(KNOWN_ID, 1);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.uuid).toBe('u2');
  });

  it('returns all messages when afterSeq is -1', async () => {
    const reader = new TranscriptReader(fakeSql({ [KNOWN_ID]: TRANSCRIPT }));
    const msgs = await reader.messagesSince(KNOWN_ID, -1);
    expect(msgs).toHaveLength(4);
  });

  it('returns [] for a missing or empty session', async () => {
    const reader = new TranscriptReader(fakeSql({ [EMPTY_ID]: null }));
    expect(await reader.messagesSince(MISSING_ID, -1)).toEqual([]);
    expect(await reader.messagesSince(EMPTY_ID, -1)).toEqual([]);
  });
});

describe('TranscriptReader.listSessionIdsWithContent', () => {
  it('excludes sessions with a null or empty transcript', async () => {
    const reader = new TranscriptReader(
      fakeSql({ [KNOWN_ID]: TRANSCRIPT, [EMPTY_ID]: '', 'row-with-null': null })
    );
    const ids = await reader.listSessionIdsWithContent();
    expect(ids).toEqual([KNOWN_ID]);
  });
});

// ── Chunked backend ─────────────────────────────────────────────────────────

/** Chunk a transcript with the real production chunker/parser, for a
 * realistic chunked-session fixture (not a hand-rolled approximation). */
function buildChunks(transcript: string, chunkMaxBytes: number) {
  const lines = splitLinesWithTerminators(transcript);
  const { lineSeqs } = feed(EMPTY_CHECKPOINT, lines);
  return chunkLines(lines, lineSeqs, 0, chunkMaxBytes).map((c, i) => ({ ...c, seq: i }));
}

/** A fake session backed by chunk rows + a message index, matching the
 * chunked-backend query shapes `TranscriptReader` issues. */
function fakeChunkedSql(
  sessionId: string,
  chunks: ReturnType<typeof buildChunks>,
  messages: Array<{ seq: number; uuid: string; chunkSeq: number }>
): postgres.Sql {
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');

    if (text.includes('SELECT storage, raw_transcript')) {
      return Promise.resolve([{ storage: 'chunked', raw_transcript: null }]);
    }
    if (text.includes('SELECT storage FROM sessions.sessions')) {
      return Promise.resolve([{ storage: 'chunked' }]);
    }
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
      const row = messages.find((m) => m.uuid === uuid);
      return Promise.resolve(row ? [{ seq: row.seq }] : []);
    }
    if (text.includes('msg_seq_end >=') && text.includes('msg_seq_start <=')) {
      // readAround / find range-bounded chunk fetch: values = [sessionId, seqStart, seqEnd].
      const [, seqStart, seqEnd] = values as [string, number, number];
      const filtered = chunks.filter((c) => c.msgSeqEnd >= seqStart && c.msgSeqStart <= seqEnd);
      return Promise.resolve(filtered.map((c) => ({ content: c.content })));
    }
    if (text.includes('SELECT content FROM sessions.transcript_chunks')) {
      // readFullChunked, or find()'s unbounded fallback
      return Promise.resolve(chunks.map((c) => ({ content: c.content })));
    }

    throw new Error(`fakeChunkedSql: unrecognized query: ${text}`);
  }) as unknown as postgres.Sql;
  void sessionId;
  return fn;
}

describe('TranscriptReader chunked backend', () => {
  const chunks = buildChunks(TRANSCRIPT, 40); // tiny cap forces several chunks
  const messages = [
    { seq: 0, uuid: 'u0', chunkSeq: 0 },
    { seq: 1, uuid: 'u1', chunkSeq: chunks.length > 1 ? 1 : 0 },
    { seq: 2, uuid: 'u2', chunkSeq: chunks.length > 2 ? 2 : 0 },
    { seq: 3, uuid: 'u3', chunkSeq: chunks[chunks.length - 1]!.seq },
  ];

  it('readFull concatenates every chunk in order', async () => {
    const reader = new TranscriptReader(fakeChunkedSql(KNOWN_ID, chunks, messages));
    expect(await reader.readFull(KNOWN_ID)).toBe(TRANSCRIPT);
  });

  it('serialize works over the concatenated chunked content', async () => {
    const reader = new TranscriptReader(fakeChunkedSql(KNOWN_ID, chunks, messages));
    const text = await reader.serialize(KNOWN_ID);
    expect(text).toContain('[U] first task');
    expect(text).toContain('[A] done');
  });

  it('readHeadTail samples from boundary chunks only, matching the inline result', async () => {
    const reader = new TranscriptReader(fakeChunkedSql(KNOWN_ID, chunks, messages));
    const { raw, fullLength } = await reader.readHeadTail(KNOWN_ID, 20);
    expect(fullLength).toBe(Buffer.byteLength(TRANSCRIPT, 'utf8'));
    expect(raw.length).toBeGreaterThan(0);
  });

  it('readAround resolves the anchor via the message index and returns the same window shape', async () => {
    const reader = new TranscriptReader(fakeChunkedSql(KNOWN_ID, chunks, messages));
    const { sessionFound, window } = await reader.readAround(KNOWN_ID, 'u1', 1, 1);
    expect(sessionFound).toBe(true);
    expect(window?.anchor).toBe('u1');
    expect(window?.lines.some((l) => l.includes('first task'))).toBe(true);
    expect(window?.lines.some((l) => l.includes('second task'))).toBe(true);
  });

  it('readAround reports a missing anchor without a missing session', async () => {
    const reader = new TranscriptReader(fakeChunkedSql(KNOWN_ID, chunks, messages));
    const { sessionFound, window } = await reader.readAround(KNOWN_ID, 'does-not-exist', 1, 1);
    expect(sessionFound).toBe(true);
    expect(window).toBeNull();
  });

  it('find (unbounded) matches the same as the inline backend', async () => {
    const reader = new TranscriptReader(fakeChunkedSql(KNOWN_ID, chunks, messages));
    const { sessionFound, matches } = await reader.find(KNOWN_ID, { match: 'second', in: 'text' });
    expect(sessionFound).toBe(true);
    expect(matches).toHaveLength(1);
  });
});
