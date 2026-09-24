import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashChunkContent,
  chunkLines,
  splitLinesWithTerminators,
  cutAtLastNewline,
  readBoundedTail,
  readByteRange,
  checkContinuity,
  checkContinuityInPayload,
  sliceByBytes,
} from './chunked-ingest.js';
import { feed, EMPTY_CHECKPOINT } from './incremental-parser.js';

function line(text: string): string {
  return JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } }) + '\n';
}

describe('splitLinesWithTerminators', () => {
  it('reattaches the newline to every complete line', () => {
    const content = line('a') + line('b');
    const lines = splitLinesWithTerminators(content);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.endsWith('\n')).toBe(true);
    expect(lines.join('')).toBe(content);
  });

  it('tolerates a missing trailing newline', () => {
    const content = 'a\nb'; // no trailing \n
    const lines = splitLinesWithTerminators(content);
    expect(lines).toEqual(['a\n', 'b']);
  });

  it('returns [] for empty content', () => {
    expect(splitLinesWithTerminators('')).toEqual([]);
  });
});

describe('cutAtLastNewline', () => {
  it('keeps everything up to and including the last newline', () => {
    const buf = Buffer.from('a\nb\nc'); // trailing partial line "c"
    const { content, consumedBytes } = cutAtLastNewline(buf);
    expect(content).toBe('a\nb\n');
    expect(consumedBytes).toBe(4);
  });

  it('returns empty when there is no newline at all', () => {
    const { content, consumedBytes } = cutAtLastNewline(Buffer.from('no newline here'));
    expect(content).toBe('');
    expect(consumedBytes).toBe(0);
  });

  it('never splits a multi-byte character at the newline boundary', () => {
    const emoji = '🎉'.repeat(3);
    const buf = Buffer.from(`${emoji}\n${emoji}`, 'utf8');
    const { content } = cutAtLastNewline(buf);
    expect(content).toBe(`${emoji}\n`);
    // Round-trips cleanly — no replacement characters from a split codepoint.
    expect(content).not.toContain('�');
  });
});

describe('chunkLines', () => {
  it('splits only at line boundaries, never mid-line', () => {
    const content = line('aaaa') + line('bbbb') + line('cccc');
    const lines = splitLinesWithTerminators(content);
    const { lineSeqs } = feed(EMPTY_CHECKPOINT, lines);
    // Cap small enough that each line becomes (at least) its own boundary.
    const pieces = chunkLines(lines, lineSeqs, 0, 30);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.content.endsWith('\n')).toBe(true);
    }
    expect(pieces.map((p) => p.content).join('')).toBe(content);
  });

  it('produces contiguous, non-overlapping byte ranges', () => {
    const content = line('x'.repeat(100)) + line('y'.repeat(100)) + line('z'.repeat(100));
    const lines = splitLinesWithTerminators(content);
    const { lineSeqs } = feed(EMPTY_CHECKPOINT, lines);
    const pieces = chunkLines(lines, lineSeqs, 1000, 80);
    expect(pieces[0]!.byteStart).toBe(1000);
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i]!.byteStart).toBe(pieces[i - 1]!.byteEnd);
    }
    const last = pieces[pieces.length - 1]!;
    expect(last.byteEnd).toBe(1000 + Buffer.byteLength(content, 'utf8'));
  });

  it('assigns each piece an exact msgSeq range from the matching feed() lineSeqs', () => {
    const content = line('a') + line('b') + line('c') + line('d');
    const lines = splitLinesWithTerminators(content);
    const { lineSeqs } = feed(EMPTY_CHECKPOINT, lines);
    const pieces = chunkLines(lines, lineSeqs, 0, 40); // small cap: several pieces
    const allSeqs = pieces.flatMap((p) => Array.from({ length: p.msgSeqEnd - p.msgSeqStart + 1 }, (_, i) => p.msgSeqStart + i));
    expect(allSeqs).toEqual([0, 1, 2, 3]);
  });

  it('a single line larger than the cap becomes its own oversized piece', () => {
    const content = line('x'.repeat(1000));
    const lines = splitLinesWithTerminators(content);
    const { lineSeqs } = feed(EMPTY_CHECKPOINT, lines);
    const pieces = chunkLines(lines, lineSeqs, 0, 10);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.content).toBe(content);
  });
});

describe('hashChunkContent', () => {
  it('is deterministic and content-sensitive', () => {
    expect(hashChunkContent('abc')).toBe(hashChunkContent('abc'));
    expect(hashChunkContent('abc')).not.toBe(hashChunkContent('abd'));
  });
});

describe('sliceByBytes', () => {
  it('slices on byte offsets, not UTF-16 code units', () => {
    const s = 'a'.repeat(5) + '🎉' + 'b'.repeat(5); // emoji is 4 bytes, 2 UTF-16 units
    const full = Buffer.byteLength(s, 'utf8');
    expect(sliceByBytes(s, 0, 5)).toBe('aaaaa');
    expect(sliceByBytes(s, 5, 9)).toBe('🎉');
    expect(sliceByBytes(s, 9, full)).toBe('bbbbb');
  });
});

describe('file-backed reads', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chunked-ingest-test-'));
    filePath = join(dir, 'transcript.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('readBoundedTail reads only [fromByte, fromByte+budget), cut at the last newline', async () => {
    const l1 = line('one');
    const l2 = line('two');
    const l3 = line('three');
    await writeFile(filePath, l1 + l2 + l3);

    const first = await readBoundedTail(filePath, 0, Buffer.byteLength(l1, 'utf8'));
    expect(first.content).toBe(l1);
    expect(first.consumedBytes).toBe(Buffer.byteLength(l1, 'utf8'));

    const rest = await readBoundedTail(filePath, first.consumedBytes, 1_000_000);
    expect(rest.content).toBe(l2 + l3);
    expect(rest.fileSize).toBe(Buffer.byteLength(l1 + l2 + l3, 'utf8'));
  });

  it('readBoundedTail defers a partial trailing line to the next cycle', async () => {
    const complete = line('complete');
    await writeFile(filePath, complete + '{"partial": tr');
    const { content, consumedBytes } = await readBoundedTail(filePath, 0, 1_000_000);
    expect(content).toBe(complete);
    expect(consumedBytes).toBe(Buffer.byteLength(complete, 'utf8'));
  });

  it('readBoundedTail returns nothing once at EOF', async () => {
    const content = line('one');
    await writeFile(filePath, content);
    const size = Buffer.byteLength(content, 'utf8');
    const result = await readBoundedTail(filePath, size, 1000);
    expect(result.content).toBe('');
    expect(result.consumedBytes).toBe(0);
  });

  it('readByteRange reads an exact slice', async () => {
    await writeFile(filePath, 'abcdefghij');
    const buf = await readByteRange(filePath, 2, 5);
    expect(buf.toString('utf8')).toBe('cde');
  });

  describe('checkContinuity', () => {
    it('is ok with no prior chunk (nothing to verify)', async () => {
      await writeFile(filePath, line('a'));
      expect(await checkContinuity(filePath, 0, null)).toBe('ok');
    });

    it('is ok when the last chunk still hashes the same', async () => {
      const content = line('a') + line('b');
      await writeFile(filePath, content);
      const lastChunk = { byteStart: 0, byteEnd: Buffer.byteLength(content, 'utf8'), contentHash: hashChunkContent(content) };
      expect(await checkContinuity(filePath, lastChunk.byteEnd, lastChunk)).toBe('ok');
    });

    it('detects a rewritten file (hash mismatch)', async () => {
      const original = line('a') + line('b');
      await writeFile(filePath, original);
      const lastChunk = { byteStart: 0, byteEnd: Buffer.byteLength(original, 'utf8'), contentHash: hashChunkContent(original) };
      await writeFile(filePath, line('DIFFERENT') + line('CONTENT'));
      expect(await checkContinuity(filePath, lastChunk.byteEnd, lastChunk)).toBe('mismatch');
    });

    it('detects truncation (file now shorter than ingestedBytes)', async () => {
      const content = line('a') + line('b') + line('c');
      await writeFile(filePath, content);
      await writeFile(filePath, line('a'));
      expect(await checkContinuity(filePath, Buffer.byteLength(content, 'utf8'), null)).toBe('mismatch');
    });

    it('is ok across a legitimate append', async () => {
      const original = line('a');
      await writeFile(filePath, original);
      const lastChunk = { byteStart: 0, byteEnd: Buffer.byteLength(original, 'utf8'), contentHash: hashChunkContent(original) };
      await appendFile(filePath, line('b'));
      expect(await checkContinuity(filePath, lastChunk.byteEnd, lastChunk)).toBe('ok');
    });
  });
});

describe('checkContinuityInPayload', () => {
  it('ok when the payload is a fresh (offset 0) session with no prior chunk', () => {
    expect(checkContinuityInPayload('anything', 0, null)).toBe('ok');
  });

  it('mismatch when a nonzero-offset payload claims no prior chunk exists', () => {
    expect(checkContinuityInPayload('tail only', 500, null)).toBe('mismatch');
  });

  it('ok when the payload covers and matches the last chunk range', () => {
    const a = line('a');
    const b = line('b');
    const c = line('c');
    const full = a + b + c;
    const lastChunk = {
      byteStart: Buffer.byteLength(a, 'utf8'),
      byteEnd: Buffer.byteLength(a + b, 'utf8'),
      contentHash: hashChunkContent(b),
    };
    expect(checkContinuityInPayload(full, 0, lastChunk)).toBe('ok');
  });

  it('mismatch when the payload does not cover the last chunk range', () => {
    const lastChunk = { byteStart: 100, byteEnd: 200, contentHash: hashChunkContent('whatever') };
    expect(checkContinuityInPayload('short payload', 0, lastChunk)).toBe('mismatch');
  });

  it('mismatch when the overlapping bytes differ from the stored hash', () => {
    const lastChunk = {
      byteStart: 0,
      byteEnd: Buffer.byteLength(line('a'), 'utf8'),
      contentHash: hashChunkContent(line('a')),
    };
    expect(checkContinuityInPayload(line('DIFFERENT'), 0, lastChunk)).toBe('mismatch');
  });
});
