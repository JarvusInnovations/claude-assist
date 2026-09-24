import { describe, expect, it } from 'bun:test';
import { feed, finalize, EMPTY_CHECKPOINT, MAX_OPEN_CHAINS } from './incremental-parser.js';
import { mergeParseDelta, EMPTY_AGGREGATE, type SessionAggregate } from './aggregate-merge.js';
import type { ToolCall } from './types.js';

// ── Synthetic transcript builders ───────────────────────────────────────────

function j(obj: unknown): string {
  return JSON.stringify(obj);
}

let uidCounter = 0;
function uid(): string {
  uidCounter++;
  return `m${uidCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function tsAt(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

function userLine(text: string, ts: string): { line: string; uuid: string } {
  const uuid = uid();
  return { uuid, line: j({ type: 'user', uuid, parentUuid: null, timestamp: ts, message: { role: 'user', content: text } }) };
}

interface AssistantOpts {
  parentUuid: string | null;
  ts: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  text?: string;
  tools?: Array<{ name: string; input: Record<string, unknown> }>;
  isSidechain?: boolean;
}

function assistantLine(opts: AssistantOpts): { line: string; uuid: string } {
  const uuid = uid();
  const content: unknown[] = [];
  if (opts.text) content.push({ type: 'text', text: opts.text });
  for (const t of opts.tools ?? []) content.push({ type: 'tool_use', id: uid(), name: t.name, input: t.input });
  return {
    uuid,
    line: j({
      type: 'assistant',
      uuid,
      parentUuid: opts.parentUuid,
      timestamp: opts.ts,
      isSidechain: opts.isSidechain ?? false,
      message: { role: 'assistant', model: opts.model ?? 'claude-x', content, usage: opts.usage },
    }),
  };
}

function customTitleLine(title: string): string {
  return j({ type: 'custom-title', customTitle: title });
}

/**
 * A realistic-shaped synthetic transcript exercising: multi-message streaming
 * chains (parentUuid walks), a compaction-like context reading (peak exceeds
 * final), a sidechain (subagent) running concurrently with the main chain, a
 * mid-session rename, file-touching tool calls, and malformed/blank lines.
 */
function buildTranscript(turns: number, baseMs = Date.parse('2026-01-01T00:00:00Z')): string[] {
  const lines: string[] = [];
  let t = 0;
  let mainParent: string | null = null;

  for (let i = 0; i < turns; i++) {
    const u = userLine(`turn ${i} question`, tsAt(baseMs, t));
    lines.push(u.line);
    t += 1000;

    if (i === Math.floor(turns / 3)) lines.push(customTitleLine(`renamed at turn ${i}`));
    if (i % 17 === 0) lines.push('not valid json {{{'); // malformed line
    if (i % 23 === 0) lines.push(''); // blank line

    // A 3-message streaming chain for this turn (cumulative output tokens).
    const chainLen = 2 + (i % 3);
    let parent: string | null = u.uuid;
    let lastOutput = 0;
    for (let d = 0; d < chainLen; d++) {
      lastOutput += 15;
      const isLast = d === chainLen - 1;
      const a = assistantLine({
        parentUuid: parent,
        ts: tsAt(baseMs, t),
        model: i % 5 === 0 ? 'claude-big' : 'claude-small',
        usage: {
          input_tokens: d === 0 ? 200 + i : 0,
          cache_read_input_tokens: d === 0 ? 50 : 0,
          output_tokens: lastOutput,
        },
        text: isLast ? `answer for turn ${i}` : undefined,
        tools: isLast
          ? [
              { name: 'Read', input: { file_path: `/repo/file-${i % 7}.ts` } },
              { name: 'Bash', input: { command: `echo ${i}` } },
            ]
          : undefined,
      });
      lines.push(a.line);
      parent = a.uuid;
      t += 200;
    }

    // Every 5th turn, a compaction-like reading: one huge context read
    // immediately followed by a much smaller one on the SAME logical turn's
    // continuation (peak must exceed final).
    if (i % 5 === 0) {
      const big = assistantLine({ parentUuid: null, ts: tsAt(baseMs, t), usage: { input_tokens: 100_000 } });
      lines.push(big.line);
      t += 200;
      const small = assistantLine({ parentUuid: null, ts: tsAt(baseMs, t), usage: { input_tokens: 20_000 } });
      lines.push(small.line);
      t += 200;
    }

    // Every 7th turn, a concurrent sidechain (subagent) with its own short
    // streaming chain, isSidechain: true throughout.
    if (i % 7 === 0) {
      let sideParent: string | null = null;
      for (let d = 0; d < 2; d++) {
        const s = assistantLine({
          parentUuid: sideParent,
          ts: tsAt(baseMs, t),
          usage: { input_tokens: d === 0 ? 500 : 0, output_tokens: (d + 1) * 30 },
          isSidechain: true,
          tools: d === 1 ? [{ name: 'Edit', input: { file_path: `/repo/side-${i}.ts` } }] : undefined,
        });
        lines.push(s.line);
        sideParent = s.uuid;
        t += 100;
      }
    }

    mainParent = parent;
  }
  void mainParent;

  return lines;
}

// ── Full parse vs. N-way split parse, via the shared feed/finalize engine ──

interface RunResult {
  aggregate: SessionAggregate;
  toolCalls: ToolCall[];
  messageIndexRows: Array<{ seq: number; uuid: string }>;
}

function runFull(lines: string[]): RunResult {
  const { checkpoint, delta } = feed(EMPTY_CHECKPOINT, lines);
  let aggregate = mergeParseDelta(EMPTY_AGGREGATE, delta);
  const { delta: finalDelta } = finalize(checkpoint);
  aggregate = mergeParseDelta(aggregate, finalDelta);
  return { aggregate, toolCalls: [...delta.toolCalls], messageIndexRows: [...delta.messageIndexRows] };
}

function runSplit(lines: string[], splitPoints: number[]): RunResult {
  let checkpoint = EMPTY_CHECKPOINT;
  let aggregate = EMPTY_AGGREGATE;
  const toolCalls: ToolCall[] = [];
  const messageIndexRows: Array<{ seq: number; uuid: string }> = [];

  const boundaries = [...new Set(splitPoints)].filter((p) => p > 0 && p < lines.length).sort((a, b) => a - b);
  boundaries.push(lines.length);

  let start = 0;
  for (const end of boundaries) {
    if (end <= start) continue;
    const slice = lines.slice(start, end);
    const { checkpoint: next, delta } = feed(checkpoint, slice);
    checkpoint = next;
    aggregate = mergeParseDelta(aggregate, delta);
    toolCalls.push(...delta.toolCalls);
    messageIndexRows.push(...delta.messageIndexRows);
    start = end;
  }

  const { delta: finalDelta } = finalize(checkpoint);
  aggregate = mergeParseDelta(aggregate, finalDelta);
  return { aggregate, toolCalls, messageIndexRows };
}

/** Deterministic PRNG (mulberry32) so split points are reproducible. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSplitPoints(rand: () => number, lineCount: number, count: number): number[] {
  const points = new Set<number>();
  for (let i = 0; i < count; i++) points.add(1 + Math.floor(rand() * (lineCount - 1)));
  return [...points];
}

describe('incremental-parser: split parse equals full parse', () => {
  const lines = buildTranscript(60);

  it('a single-call full parse is internally consistent (sanity)', () => {
    const result = runFull(lines);
    expect(result.aggregate.messageCount).toBeGreaterThan(0);
    // 'claude-x' is the default model on the untagged compaction/sidechain messages.
    expect(result.aggregate.modelsUsed.sort()).toEqual(['claude-big', 'claude-small', 'claude-x'].sort());
    expect(result.aggregate.parseErrors).toBeGreaterThan(0); // the injected malformed lines
  });

  it('captures a compaction-like reading (peak exceeds final)', () => {
    const result = runFull(lines);
    expect(result.aggregate.contextPeakTokens).toBeGreaterThan(result.aggregate.contextFinalTokens ?? 0);
    expect(result.aggregate.contextPeakTokens).toBeGreaterThanOrEqual(100_000);
  });

  it('the mid-session rename wins (last custom-title line)', () => {
    const result = runFull(lines);
    expect(result.aggregate.sessionName).toContain('renamed at turn');
  });

  for (let trial = 0; trial < 25; trial++) {
    it(`random split #${trial} (line boundaries only) equals the full parse`, () => {
      const rand = prng(1000 + trial);
      const splitCount = 1 + Math.floor(rand() * 8);
      const splitPoints = randomSplitPoints(rand, lines.length, splitCount);

      const full = runFull(lines);
      const split = runSplit(lines, splitPoints);

      expect(split.aggregate).toEqual(full.aggregate);
      expect(split.toolCalls).toEqual(full.toolCalls);
      expect(split.messageIndexRows).toEqual(full.messageIndexRows);
    });
  }

  it('every-line-is-its-own-chunk (the extreme split) still equals the full parse', () => {
    const splitPoints = Array.from({ length: lines.length - 1 }, (_, i) => i + 1);
    const full = runFull(lines);
    const split = runSplit(lines, splitPoints);
    expect(split.aggregate).toEqual(full.aggregate);
    expect(split.toolCalls).toEqual(full.toolCalls);
    expect(split.messageIndexRows).toEqual(full.messageIndexRows);
  });
});

describe('incremental-parser: checkpoint size stays bounded', () => {
  it('open-chain count never exceeds MAX_OPEN_CHAINS, and checkpoint JSON stays small on a large transcript', () => {
    const lines = buildTranscript(3000); // many sequential turns/chains
    let checkpoint = EMPTY_CHECKPOINT;
    let maxOpenChains = 0;
    // Feed in randomly-sized slices to simulate real sync cycles rather than
    // one giant call.
    const rand = prng(42);
    let i = 0;
    while (i < lines.length) {
      const size = 5 + Math.floor(rand() * 40);
      const slice = lines.slice(i, i + size);
      const { checkpoint: next } = feed(checkpoint, slice);
      checkpoint = next;
      maxOpenChains = Math.max(maxOpenChains, checkpoint.openChains.length);
      i += size;
    }

    expect(maxOpenChains).toBeLessThanOrEqual(MAX_OPEN_CHAINS);

    const checkpointBytes = Buffer.byteLength(JSON.stringify(checkpoint), 'utf8');
    // eslint-disable-next-line no-console
    console.log(
      `[incremental-parser] checkpoint after ${lines.length} lines: ${checkpointBytes} bytes, ${checkpoint.openChains.length} open chains, msgIndex=${checkpoint.msgIndex}`
    );
    // Bounded by MAX_OPEN_CHAINS regardless of transcript length — a few KB,
    // not proportional to the 3000-turn transcript that produced it.
    expect(checkpointBytes).toBeLessThan(50_000);
  });
});
