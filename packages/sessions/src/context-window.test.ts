import { describe, test, expect } from 'bun:test';
import { parseTranscript } from './parser.js';
import { contextWindowFor } from './context-window.js';

/** One assistant message carrying usage, as Claude Code writes it. */
function assistantMsg(opts: {
  uuid: string;
  parentUuid: string | null;
  input?: number;
  cacheCreation?: number;
  cacheRead?: number;
  model?: string;
  isSidechain?: boolean;
}) {
  return JSON.stringify({
    type: 'assistant',
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    timestamp: '2026-08-19T12:00:00.000Z',
    isSidechain: opts.isSidechain ?? false,
    message: {
      model: opts.model ?? 'claude-opus-5',
      content: [],
      usage: {
        input_tokens: opts.input ?? 0,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        output_tokens: 500,
      },
    },
  });
}

const SESSION = '00000000-0000-4000-8000-000000000001';

describe('contextWindowFor', () => {
  test('resolves current models', () => {
    expect(contextWindowFor('claude-opus-5')).toBe(1_000_000);
    expect(contextWindowFor('claude-fable-5')).toBe(1_000_000);
    expect(contextWindowFor('claude-sonnet-4-6')).toBe(1_000_000);
  });

  test('strips a dated snapshot suffix', () => {
    expect(contextWindowFor('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(contextWindowFor('claude-opus-4-5-20251101')).toBe(200_000);
  });

  test('returns null rather than guessing for unknown models', () => {
    expect(contextWindowFor('<synthetic>')).toBeNull();
    expect(contextWindowFor('claude-opus-9')).toBeNull();
    expect(contextWindowFor(null)).toBeNull();
    expect(contextWindowFor(undefined)).toBeNull();
  });
});

describe('parseTranscript context readings', () => {
  test('sums the three input components of one call', () => {
    const jsonl = assistantMsg({
      uuid: 'a',
      parentUuid: null,
      input: 2,
      cacheCreation: 136_884,
      cacheRead: 24_101,
    });
    const parsed = parseTranscript(SESSION, jsonl);
    // Output tokens excluded — they are not resident in the next prompt.
    expect(parsed.contextFinalTokens).toBe(160_987);
    expect(parsed.contextPeakTokens).toBe(160_987);
    expect(parsed.contextLimitTokens).toBe(1_000_000);
    expect(parsed.contextModel).toBe('claude-opus-5');
  });

  test('peak exceeds final when the prompt shrinks (compaction)', () => {
    const jsonl = [
      assistantMsg({ uuid: 'a', parentUuid: null, cacheRead: 100_000 }),
      assistantMsg({ uuid: 'b', parentUuid: 'u1', cacheRead: 976_348 }),
      assistantMsg({ uuid: 'c', parentUuid: 'u2', cacheRead: 749_194 }),
    ].join('\n');
    const parsed = parseTranscript(SESSION, jsonl);
    expect(parsed.contextPeakTokens).toBe(976_348);
    expect(parsed.contextFinalTokens).toBe(749_194);
  });

  test('a streamed chain counts once, not per message', () => {
    // b and c chain off a, which itself has usage — only a is first-in-chain.
    const jsonl = [
      assistantMsg({ uuid: 'a', parentUuid: null, cacheRead: 50_000 }),
      assistantMsg({ uuid: 'b', parentUuid: 'a', cacheRead: 50_000 }),
      assistantMsg({ uuid: 'c', parentUuid: 'b', cacheRead: 50_000 }),
    ].join('\n');
    const parsed = parseTranscript(SESSION, jsonl);
    expect(parsed.contextFinalTokens).toBe(50_000);
    expect(parsed.contextPeakTokens).toBe(50_000);
  });

  test('sidechain (subagent) messages never move the readings', () => {
    const jsonl = [
      assistantMsg({ uuid: 'a', parentUuid: null, cacheRead: 40_000 }),
      assistantMsg({ uuid: 's', parentUuid: 'u9', cacheRead: 900_000, isSidechain: true }),
    ].join('\n');
    const parsed = parseTranscript(SESSION, jsonl);
    expect(parsed.contextPeakTokens).toBe(40_000);
    expect(parsed.contextFinalTokens).toBe(40_000);
  });

  test('a transcript with no main-chain usage measures null, not zero', () => {
    const jsonl = JSON.stringify({
      type: 'user',
      uuid: 'u',
      parentUuid: null,
      timestamp: '2026-08-19T12:00:00.000Z',
      message: { content: 'hi' },
    });
    const parsed = parseTranscript(SESSION, jsonl);
    expect(parsed.contextFinalTokens).toBeNull();
    expect(parsed.contextPeakTokens).toBeNull();
    expect(parsed.contextLimitTokens).toBeNull();
  });

  test('an unknown model yields figures with no limit', () => {
    const jsonl = assistantMsg({
      uuid: 'a',
      parentUuid: null,
      cacheRead: 12_345,
      model: '<synthetic>',
    });
    const parsed = parseTranscript(SESSION, jsonl);
    expect(parsed.contextFinalTokens).toBe(12_345);
    expect(parsed.contextLimitTokens).toBeNull();
  });
});
