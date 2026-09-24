/**
 * File-system and pure-content primitives for chunked transcript ingest
 * (specs/behaviors/session-transcript-storage.md). No database access here —
 * `SyncService` (sync.ts) owns the transaction; this module owns reading the
 * right bytes off disk and turning them into chunk rows.
 */

import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** Default per-chunk row size cap (8 MiB). */
export const DEFAULT_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
/** Default per-cycle ingest budget (64 MiB). */
export const DEFAULT_INGEST_BUDGET_BYTES = 64 * 1024 * 1024;

/** sha256 of the UTF-8 bytes of `content` — the chunk content hash. */
export function hashChunkContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface ChunkPiece {
  byteStart: number;
  byteEnd: number;
  content: string;
  contentHash: string;
  /** Message-seq range contained in this piece, or `-1, -1` if it happens to
   * contain no seq'd line (all blank/parse-error/custom-title — rare). */
  msgSeqStart: number;
  msgSeqEnd: number;
}

/**
 * Split complete `content` (guaranteed to end at a line boundary — see
 * `cutAtLastNewline`) into individual lines, each with its trailing `\n`
 * reattached so a caller can sum byte lengths and reconstruct exact byte
 * ranges. `JSON.parse` tolerates the trailing whitespace, so these lines feed
 * `incremental-parser.ts#feed` directly.
 */
export function splitLinesWithTerminators(content: string): string[] {
  if (content.length === 0) return [];
  const parts = content.split('\n');
  // content is guaranteed to end with '\n', so the final split part is ''.
  if (parts[parts.length - 1] === '') parts.pop();
  else {
    // Tolerate a missing trailing newline (e.g. true EOF of an ended
    // session) rather than silently dropping the last line.
    return parts.map((l, i) => (i === parts.length - 1 ? l : l + '\n'));
  }
  return parts.map((l) => l + '\n');
}

/**
 * Split `lines` (as produced by `splitLinesWithTerminators`, in the same
 * order fed to `feed()`) into pieces of at most `maxChunkBytes` (UTF-8 byte
 * length), splitting only at line boundaries. `lineSeqs` (from the matching
 * `feed()` call) is what lets each piece carry an exact message-seq range
 * without chunking and parsing needing to independently agree on anything
 * beyond "same lines, same order". `baseByteOffset` is where `lines` begins
 * in the source file, so each piece's byte range is absolute. A single line
 * longer than `maxChunkBytes` becomes its own oversized piece rather than
 * being split mid-line (chunks split only at line boundaries — see the
 * storage spec's "Chunk shape").
 */
export function chunkLines(
  lines: readonly string[],
  lineSeqs: readonly (number | null)[],
  baseByteOffset: number,
  maxChunkBytes: number = DEFAULT_CHUNK_MAX_BYTES
): ChunkPiece[] {
  const pieces: ChunkPiece[] = [];
  let bufLines: string[] = [];
  let bufBytes = 0;
  let bufByteStart = baseByteOffset;
  let bufSeqStart: number | null = null;
  let bufSeqEnd: number | null = null;

  const flush = () => {
    if (bufLines.length === 0) return;
    const content = bufLines.join('');
    const bytes = Buffer.byteLength(content, 'utf8');
    pieces.push({
      byteStart: bufByteStart,
      byteEnd: bufByteStart + bytes,
      content,
      contentHash: hashChunkContent(content),
      msgSeqStart: bufSeqStart ?? -1,
      msgSeqEnd: bufSeqEnd ?? -1,
    });
    bufByteStart += bytes;
    bufLines = [];
    bufBytes = 0;
    bufSeqStart = null;
    bufSeqEnd = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const seq = lineSeqs[i] ?? null;
    bufLines.push(line);
    bufBytes += Buffer.byteLength(line, 'utf8');
    if (seq !== null) {
      if (bufSeqStart === null) bufSeqStart = seq;
      bufSeqEnd = seq;
    }
    if (bufBytes >= maxChunkBytes) flush();
  }
  flush();
  return pieces;
}

/**
 * Cut a freshly read buffer at its last newline, decoding only the complete
 * portion. `0x0A` never appears as a continuation byte of a multi-byte UTF-8
 * sequence, so slicing at a byte-exact newline index never splits a
 * character. Returns `content: ''` (0 bytes consumed) when the buffer has no
 * newline at all — the caller should defer to the next cycle rather than
 * guess at a partial line.
 */
export function cutAtLastNewline(buf: Buffer): { content: string; consumedBytes: number } {
  let lastNewline = -1;
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] === 0x0a) {
      lastNewline = i;
      break;
    }
  }
  if (lastNewline === -1) return { content: '', consumedBytes: 0 };
  return { content: buf.subarray(0, lastNewline + 1).toString('utf8'), consumedBytes: lastNewline + 1 };
}

/**
 * Read `[fromByte, fromByte + min(maxBytes, EOF - fromByte))` from a file
 * without loading the whole thing, then cut to the last complete line. This
 * is the one read local sync and push issue per session per cycle.
 */
export async function readBoundedTail(
  path: string,
  fromByte: number,
  maxBytes: number
): Promise<{ content: string; consumedBytes: number; fileSize: number }> {
  const st = await stat(path);
  const fileSize = st.size;
  if (fileSize <= fromByte) {
    return { content: '', consumedBytes: 0, fileSize };
  }
  const toRead = Math.min(maxBytes, fileSize - fromByte);
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await handle.read(buf, 0, toRead, fromByte);
    const { content, consumedBytes } = cutAtLastNewline(buf.subarray(0, bytesRead));
    return { content, consumedBytes, fileSize };
  } finally {
    await handle.close();
  }
}

/** Read an exact byte range `[start, end)` from a file — for continuity checks
 * and nightly verification, never the whole file. */
export async function readByteRange(path: string, start: number, end: number): Promise<Buffer> {
  const length = end - start;
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Byte-exact slice of a UTF-8 string (string indices are UTF-16 code units,
 * not bytes, so this goes through a Buffer). Used only for push payloads,
 * which are bounded by the ingest budget already — never the whole corpus. */
export function sliceByBytes(content: string, byteStart: number, byteEnd: number): string {
  return Buffer.from(content, 'utf8').subarray(byteStart, byteEnd).toString('utf8');
}

export type ContinuityResult = 'ok' | 'mismatch';

/**
 * Confirm the file still begins with what was archived: at least
 * `ingestedBytes` long, and the last archived chunk's bytes still hash to
 * what's stored. `null` lastChunk means nothing has been archived yet
 * (trivially continuous). Reads only the last chunk's range, never the whole
 * file (specs/behaviors/session-transcript-storage.md: "Continuity check").
 */
export async function checkContinuity(
  path: string,
  ingestedBytes: number,
  lastChunk: { byteStart: number; byteEnd: number; contentHash: string } | null
): Promise<ContinuityResult> {
  const st = await stat(path).catch(() => null);
  if (!st) return 'mismatch';
  if (st.size < ingestedBytes) return 'mismatch';
  if (!lastChunk) return 'ok';
  const buf = await readByteRange(path, lastChunk.byteStart, lastChunk.byteEnd);
  if (buf.length !== lastChunk.byteEnd - lastChunk.byteStart) return 'mismatch';
  return hashChunkContent(buf.toString('utf8')) === lastChunk.contentHash ? 'ok' : 'mismatch';
}

/**
 * The push-payload analogue of `checkContinuity`: no file on this side, only
 * whatever content the satellite sent. Confirms the payload's claimed overlap
 * with what's already archived is consistent, by hashing the corresponding
 * byte range out of the payload itself instead of reading disk.
 * `payloadStartByte` is where `content` begins in the file (0 for a legacy
 * whole-file payload, `sinceBytes` for a tail-only one).
 */
export function checkContinuityInPayload(
  content: string,
  payloadStartByte: number,
  lastChunk: { byteStart: number; byteEnd: number; contentHash: string } | null
): ContinuityResult {
  if (!lastChunk) return payloadStartByte === 0 ? 'ok' : 'mismatch';
  // The payload must actually cover the last archived chunk's range for us
  // to re-verify it; if it starts after that range began, we can't confirm
  // continuity from this payload alone.
  if (payloadStartByte > lastChunk.byteStart) return 'mismatch';
  const payloadByteLength = Buffer.byteLength(content, 'utf8');
  if (payloadStartByte + payloadByteLength < lastChunk.byteEnd) return 'mismatch';
  const overlap = sliceByBytes(
    content,
    lastChunk.byteStart - payloadStartByte,
    lastChunk.byteEnd - payloadStartByte
  );
  return hashChunkContent(overlap) === lastChunk.contentHash ? 'ok' : 'mismatch';
}
