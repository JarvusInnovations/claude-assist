import { describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { TranscriptReader } from './transcript-reader.js';

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
 * A fake `sessions.sessions` table keyed by id: `raw_transcript` string,
 * `null` (row exists, no content — never happens in practice, TEXT NOT NULL,
 * but the reader is written to tolerate it), or absent (no such session).
 * Recognizes the three query shapes `TranscriptReader` issues by a substring
 * of the SQL text, since a real Postgres isn't available in CI (see
 * plans/transcript-read-layer.md's `bun test` note).
 */
function fakeSql(table: Record<string, string | null>): postgres.Sql {
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');

    if (text.includes('AS len')) {
      // rawByteLength: values = [sessionId]
      const [sessionId] = values as [string];
      if (!(sessionId in table)) return Promise.resolve([{ len: 0 }]);
      const content = table[sessionId] ?? null;
      return Promise.resolve([{ len: content === null ? 0 : content.length }]);
    }

    if (text.includes('full_length')) {
      // readHeadTail: values = [budgetBytes, half, half, sessionId]
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

    if (text.includes('SELECT id FROM sessions.sessions')) {
      // listSessionIdsWithContent: no interpolated values.
      const ids = Object.entries(table)
        .filter(([, content]) => content !== null && content !== '')
        .map(([id]) => ({ id }));
      return Promise.resolve(ids);
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

describe('TranscriptReader.readAround', () => {
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

describe('TranscriptReader.find', () => {
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
