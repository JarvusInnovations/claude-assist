import { describe, expect, it } from 'bun:test';
import { mergeParseDelta, boundedSearchText, EMPTY_AGGREGATE } from './aggregate-merge.js';
import type { ParseDelta } from './incremental-parser.js';

function emptyDelta(overrides: Partial<ParseDelta> = {}): ParseDelta {
  return {
    userMessages: [],
    toolsUsed: [],
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    messageIndexRows: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    contextFinalTokens: null,
    contextPeakCandidate: null,
    contextModel: null,
    startedAt: null,
    endedAt: null,
    messageCount: 0,
    gitBranch: null,
    claudeVersion: null,
    cwd: null,
    parseErrors: 0,
    modelsUsed: [],
    modelTokens: {},
    newActivityRanges: [],
    extendLastRangeEnd: null,
    sessionNameChanged: false,
    sessionName: null,
    ...overrides,
  };
}

describe('mergeParseDelta', () => {
  it('accumulates scalar token counts additively', () => {
    const a = mergeParseDelta(EMPTY_AGGREGATE, emptyDelta({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 }));
    const b = mergeParseDelta(a, emptyDelta({ inputTokens: 3, outputTokens: 7, cacheReadTokens: 1 }));
    expect(b.inputTokens).toBe(13);
    expect(b.outputTokens).toBe(12);
    expect(b.cacheReadTokens).toBe(3);
  });

  it('unions toolsUsed/modelsUsed/filesTouched without duplicates', () => {
    const a = mergeParseDelta(EMPTY_AGGREGATE, emptyDelta({ toolsUsed: ['Read', 'Bash'], modelsUsed: ['m1'], filesRead: ['/a.ts'] }));
    const b = mergeParseDelta(a, emptyDelta({ toolsUsed: ['Bash', 'Edit'], modelsUsed: ['m1', 'm2'], filesWritten: ['/a.ts', '/b.ts'] }));
    expect(b.toolsUsed.sort()).toEqual(['Bash', 'Edit', 'Read'].sort());
    expect(b.modelsUsed.sort()).toEqual(['m1', 'm2'].sort());
    expect(b.filesTouched.reads).toEqual(['/a.ts']);
    expect(b.filesTouched.writes.sort()).toEqual(['/a.ts', '/b.ts'].sort());
  });

  it('appends user messages in order across merges', () => {
    const a = mergeParseDelta(EMPTY_AGGREGATE, emptyDelta({ userMessages: ['first'] }));
    const b = mergeParseDelta(a, emptyDelta({ userMessages: ['second', 'third'] }));
    expect(b.userMessages).toEqual(['first', 'second', 'third']);
  });

  it('contextFinalTokens overwrites; contextPeakTokens tracks the running max', () => {
    const a = mergeParseDelta(EMPTY_AGGREGATE, emptyDelta({ contextFinalTokens: 100_000, contextPeakCandidate: 100_000, contextModel: 'big' }));
    const b = mergeParseDelta(a, emptyDelta({ contextFinalTokens: 20_000, contextPeakCandidate: 20_000, contextModel: 'small' }));
    expect(b.contextFinalTokens).toBe(20_000); // last one wins
    expect(b.contextPeakTokens).toBe(100_000); // peak survives (compaction)
    expect(b.contextModel).toBe('small');
  });

  it('a feed with no context reading leaves contextFinalTokens/contextModel untouched', () => {
    const a = mergeParseDelta(EMPTY_AGGREGATE, emptyDelta({ contextFinalTokens: 500, contextModel: 'm' }));
    const b = mergeParseDelta(a, emptyDelta()); // no reading this cycle
    expect(b.contextFinalTokens).toBe(500);
    expect(b.contextModel).toBe('m');
  });

  it('startedAt takes the min, endedAt takes the max, across merges', () => {
    const t1 = new Date('2026-01-01T10:00:00Z');
    const t2 = new Date('2026-01-01T09:00:00Z'); // earlier, arrives second
    const t3 = new Date('2026-01-01T11:00:00Z'); // later
    const a = mergeParseDelta(EMPTY_AGGREGATE, emptyDelta({ startedAt: t1, endedAt: t1 }));
    const b = mergeParseDelta(a, emptyDelta({ startedAt: t2, endedAt: t3 }));
    expect(b.startedAt).toEqual(t2);
    expect(b.endedAt).toEqual(t3);
  });

  it('gitBranch/claudeVersion/cwd are set-once (first non-null wins)', () => {
    const a = mergeParseDelta(EMPTY_AGGREGATE, emptyDelta({ gitBranch: 'main' }));
    const b = mergeParseDelta(a, emptyDelta({ gitBranch: 'other-branch' }));
    expect(b.gitBranch).toBe('main');
  });

  it('sessionName only changes when the delta says a custom-title line appeared', () => {
    const a = mergeParseDelta(EMPTY_AGGREGATE, emptyDelta({ sessionNameChanged: true, sessionName: 'Alpha' }));
    const untouched = mergeParseDelta(a, emptyDelta({ sessionNameChanged: false, sessionName: null }));
    expect(untouched.sessionName).toBe('Alpha');
    const cleared = mergeParseDelta(a, emptyDelta({ sessionNameChanged: true, sessionName: null }));
    expect(cleared.sessionName).toBeNull(); // an empty rename clears it
  });

  it('activity ranges: extends the last range or appends new ones', () => {
    const a = mergeParseDelta(
      EMPTY_AGGREGATE,
      emptyDelta({ newActivityRanges: [{ start: '2026-01-01T10:00:00.000Z', end: '2026-01-01T10:05:00.000Z' }] })
    );
    const extended = mergeParseDelta(a, emptyDelta({ extendLastRangeEnd: '2026-01-01T10:10:00.000Z' }));
    expect(extended.activityRanges).toEqual([{ start: '2026-01-01T10:00:00.000Z', end: '2026-01-01T10:10:00.000Z' }]);

    const withNewRange = mergeParseDelta(
      extended,
      emptyDelta({ newActivityRanges: [{ start: '2026-01-01T12:00:00.000Z', end: '2026-01-01T12:01:00.000Z' }] })
    );
    expect(withNewRange.activityRanges).toHaveLength(2);
  });

  it('model tokens accumulate per model additively', () => {
    const a = mergeParseDelta(EMPTY_AGGREGATE, emptyDelta({ modelTokens: { m1: { input: 10, output: 5, cacheRead: 1 } } }));
    const b = mergeParseDelta(a, emptyDelta({ modelTokens: { m1: { input: 2, output: 3, cacheRead: 0 }, m2: { input: 1, output: 1, cacheRead: 1 } } }));
    expect(b.modelTokens).toEqual({
      m1: { input: 12, output: 8, cacheRead: 1 },
      m2: { input: 1, output: 1, cacheRead: 1 },
    });
  });
});

describe('boundedSearchText', () => {
  it('joins all messages with spaces when under budget', () => {
    expect(boundedSearchText(['a', 'b', 'c'])).toBe('a b c');
  });

  it('keeps only the most recent messages within the byte budget', () => {
    const messages = ['first message is old', 'second message', 'third and most recent'];
    const text = boundedSearchText(messages, 25);
    expect(text).not.toContain('first message');
    expect(text).toContain('most recent');
  });

  it('returns "" for no messages', () => {
    expect(boundedSearchText([])).toBe('');
  });

  it('never exceeds the budget by more than one message boundary', () => {
    const messages = Array.from({ length: 50 }, (_, i) => `message number ${i} `.repeat(50));
    const text = boundedSearchText(messages, 1024);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(1024 + 3000); // one message's worth of slack
  });
});

