import { describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { MAX_TRANSCRIPT_CHARS, serializeTranscript, truncateTranscriptTail } from './transcript.js';
import { TranscriptReader } from './transcript-reader.js';

function userLine(text: string, i: number): string {
  return (
    JSON.stringify({
      type: 'user',
      uuid: `u-${i}`,
      parentUuid: null,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      message: { role: 'user', content: text },
    }) + '\n'
  );
}

describe('truncateTranscriptTail', () => {
  it('leaves a transcript under the cap untouched', () => {
    expect(truncateTranscriptTail('a\nb')).toBe('a\nb');
  });

  it('keeps the most recent content, cut at a line boundary, with a marker at the top', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(500)}`);
    const out = truncateTranscriptTail(lines.join('\n'));
    expect(out.startsWith('[...earlier transcript truncated...]\n')).toBe(true);
    expect(out.endsWith(lines.at(-1)!)).toBe(true);
    const body = out.slice(out.indexOf('\n') + 1);
    expect(body.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
    // First kept line is whole, not a fragment.
    expect(body.split('\n')[0]).toMatch(/^line \d+ x+$/);
  });

  it('serializeTranscript over an oversized transcript ends with its latest message', () => {
    const raw = Array.from({ length: 30 }, (_, i) => userLine(`message ${i} ${'y'.repeat(40_000)}`, i)).join('');
    const out = serializeTranscript(raw);
    expect(out).toContain('message 29');
    expect(out).not.toContain('message 0 ');
  });
});

describe('TranscriptReader.serialize (no time window)', () => {
  // 20 chunks, one ~100K-char user message each: the most recent
  // MAX_TRANSCRIPT_CHARS (680K) spans ~7 chunks, i.e. 2 backwards batches of 4.
  const chunks = Array.from({ length: 20 }, (_, i) => userLine(`message ${i} ${'z'.repeat(100_000)}`, i));
  const batchReads: Array<[number, number]> = [];

  const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('SELECT id FROM sessions.sessions')) return Promise.resolve([{ id: 's' }]);
    if (text.includes('max(seq) AS max_seq')) return Promise.resolve([{ max_seq: chunks.length - 1 }]);
    if (text.includes('seq BETWEEN')) {
      const [, low, high] = values as [string, number, number];
      batchReads.push([low, high]);
      return Promise.resolve(chunks.slice(low, high + 1).map((content) => ({ content })));
    }
    throw new Error(`unexpected query: ${text}`);
  }) as unknown as postgres.Sql;

  it('returns the latest messages and reads only the chunks it needs, newest first', async () => {
    const out = await new TranscriptReader(fakeSql).serialize('s');
    expect(out.startsWith('[...earlier transcript truncated...]\n')).toBe(true);
    expect(out).toContain('message 19');
    expect(out).not.toContain('message 0 ');
    expect(batchReads).toEqual([
      [16, 19],
      [12, 15],
    ]);
  });
});
