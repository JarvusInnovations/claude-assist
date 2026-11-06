import { describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { TranscriptReader } from './transcript-reader.js';
import {
  findInTranscript,
  parseMessages,
  serializeTranscript,
  serializeTranscriptUntruncated,
  TranscriptSerializer,
} from './transcript.js';
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

/** What the fake served, so tests can assert a read stayed within its chunks. */
type QueryLogEntry = { kind: 'index' } | { kind: 'head'; seq: number } | { kind: 'content'; seqs: number[] };
const queryLog: QueryLogEntry[] = [];

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

    if (text.includes('SELECT seq, msg_seq_start, msg_seq_end FROM sessions.transcript_chunks')) {
      // chunkIndex: every chunk's seq and message range, no content.
      queryLog.push({ kind: 'index' });
      return Promise.resolve(
        chunks.map((c) => ({ seq: c.seq, msg_seq_start: c.msgSeqStart, msg_seq_end: c.msgSeqEnd }))
      );
    }
    if (text.includes('AS head')) {
      // chunkFirstTimestamp: a bounded head of one chunk.
      // The head length is the query's first parameter, ahead of the session id.
      const [headChars, headSessionId, seq] = values as [number, string, number];
      queryLog.push({ kind: 'head', seq });
      const chunk = (chunksBySession[headSessionId] ?? []).find((c) => c.seq === seq);
      return Promise.resolve(chunk ? [{ head: chunk.content.slice(0, headChars) }] : []);
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
    if (text.includes('max(seq) AS max_seq')) {
      // serializeRecent: the last chunk's seq (the fake's array index is its seq).
      return Promise.resolve([{ max_seq: chunks.length > 0 ? chunks.length - 1 : null }]);
    }
    if (text.includes('seq BETWEEN')) {
      // serializeRecent's backwards batch, or chunkContents: chunks
      // [low, high] in ascending seq order.
      const [, low, high] = values as [string, number, number];
      const slice = chunks.slice(low, high + 1);
      queryLog.push({ kind: 'content', seqs: slice.map((c) => c.seq) });
      return Promise.resolve(slice.map((c) => ({ msg_seq_start: c.msgSeqStart, content: c.content })));
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

/** A long session: one user/assistant exchange per minute for `minutes`
 * minutes from 2026-07-02T00:00Z, every 7th prompt mentioning "needle", and a
 * question asked at minute 20 and answered at minute 21. */
function longTranscript(minutes: number): string {
  const lines: string[] = [];
  const at = (m: number, s: number) => new Date(Date.UTC(2026, 6, 2, 0, m, s)).toISOString();
  for (let m = 0; m < minutes; m++) {
    lines.push(userMsg(`q${m}`, at(m, 0), m % 7 === 0 ? `needle task ${m}` : `task ${m}`));
    if (m === 20) {
      lines.push(line({
        type: 'assistant', uuid: `a${m}`, parentUuid: null, timestamp: at(m, 5),
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ask1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which way?', options: ['left', 'right'] }] } }] },
      }));
    } else if (m === 21) {
      lines.push(line({
        type: 'user', uuid: `a${m}`, parentUuid: null, timestamp: at(m, 5),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ask1', content: 'left' }] },
      }));
    } else {
      lines.push(assistantMsg(`a${m}`, at(m, 5), `reply ${m}`));
    }
  }
  return lines.join('\n');
}

function longReader(transcript: string, chunkMaxBytes: number) {
  const chunks = buildChunks(transcript, chunkMaxBytes);
  const messages = parseMessages(transcript).map((m, seq) => ({ seq, uuid: m.uuid ?? '' }));
  const sql = fakeSql(new Set([KNOWN_ID]), { [KNOWN_ID]: chunks }, { [KNOWN_ID]: messages });
  return { reader: new TranscriptReader(sql), chunks };
}

describe('TranscriptReader — bounded-memory reads', () => {
  const transcript = longTranscript(120);
  // ~600-byte cap: a couple of exchanges per chunk, so ~100 chunks
  const { reader, chunks } = longReader(transcript, 600);
  const at = (m: number) => new Date(Date.UTC(2026, 6, 2, 0, m, 0));

  it('splits the fixture into many chunks', () => {
    expect(chunks.length).toBeGreaterThan(40);
  });

  it.each([
    ['start', { after: at(0), before: at(10) }],
    ['middle', { after: at(55), before: at(65) }],
    ['end', { after: at(110) }],
    ['before only', { before: at(5) }],
    ['spanning the question and answer', { after: at(19), before: at(23) }],
  ])('a time window at the %s equals filtering the whole transcript, reading only its chunks', async (_, window) => {
    const opts = { ...window, includeTools: true };
    queryLog.length = 0;
    const text = await reader.serialize(KNOWN_ID, opts);
    expect(text).toBe(serializeTranscript(transcript, opts));

    const read = queryLog.flatMap((q) => (q.kind === 'content' ? q.seqs : []));
    const probes = queryLog.filter((q) => q.kind === 'head').length;
    // The window's ~10 minutes fit in well under a fifth of the chunks; a
    // probe per binary-search step, never a whole-chunk read
    expect(read.length).toBeLessThan(chunks.length / 5);
    expect(probes).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(chunks.length)) + 2);
  });

  it('pairs a question with its answer when they land in different chunks', async () => {
    const opts = { after: at(19), before: at(23) };
    const text = await reader.serialize(KNOWN_ID, opts);
    expect(text).toContain('[?]');
    expect(text).toContain('[>] left');
  });

  it('find returns the same matches and windows as a whole-transcript search', async () => {
    const opts = { match: 'needle', in: 'text' as const, context: 2, limit: 50 };
    queryLog.length = 0;
    const found = await reader.find(KNOWN_ID, opts);
    const expected = findInTranscript(transcript, opts);
    expect(found.matches.length).toBe(expected.length);
    expect(found.matches).toEqual(expected);

    // Each chunk is fetched once as the walk slides, not once per neighbour
    const fetched = queryLog.flatMap((q) => (q.kind === 'content' ? q.seqs : []));
    expect(fetched.length).toBe(new Set(fetched).size);
  });

  it('find stops reading once it has its limit', async () => {
    queryLog.length = 0;
    const found = await reader.find(KNOWN_ID, { match: 'needle', in: 'text', limit: 2 });
    expect(found.matches.map((m) => m.anchor)).toEqual(['q0', 'q7']);
    const read = new Set(queryLog.flatMap((q) => (q.kind === 'content' ? q.seqs : [])));
    expect(read.size).toBeLessThan(chunks.length / 4);
  });
});

describe('TranscriptSerializer', () => {
  const transcript = longTranscript(60);
  const parts = buildChunks(transcript, 600).map((c) => c.content);

  it('renders batches fed in order exactly as the concatenation', () => {
    const serializer = new TranscriptSerializer({ includeTools: true });
    for (const part of parts) serializer.push(part);
    expect(serializer.text()).toBe(serializeTranscriptUntruncated(transcript, { includeTools: true }));
  });

  it('keeps only the tail when bounded, flagging what it dropped', () => {
    const full = serializeTranscriptUntruncated(transcript);
    const serializer = new TranscriptSerializer(undefined, 500);
    for (const part of parts) serializer.push(part);
    expect(serializer.earlierOmitted).toBe(true);
    expect(serializer.text().length).toBeLessThanOrEqual(1000);
    expect(full.endsWith(serializer.text())).toBe(true);
  });
});
