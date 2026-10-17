import { describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { applyOpenChainOutput, getChunkState, writeIngestCycle, type WriteCycleParams } from './chunk-store.js';
import { EMPTY_CHECKPOINT, type ParseCheckpoint } from './incremental-parser.js';
import { EMPTY_AGGREGATE } from './aggregate-merge.js';
import type { ToolCall, ContextReading, ContextCompaction } from './types.js';

/** A recording sql double, in the shape `LedgerStore.test.ts` uses: captures
 * every tagged-template query's text + interpolated values, and models
 * `sql.begin` as "call the callback with the same fake sql". */
function recordingSql(rows: Record<string, unknown[]> = {}) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });
    for (const [marker, result] of Object.entries(rows)) {
      if (text.includes(marker)) return Promise.resolve(result);
    }
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  (fn as unknown as { begin: (cb: (tx: postgres.Sql) => Promise<void>) => Promise<void> }).begin = (cb) => cb(fn);
  return { sql: fn, calls };
}

const SESSION_ID = '00000000-0000-0000-0000-0000000000a1';

function baseParams(overrides: Partial<WriteCycleParams> = {}): WriteCycleParams {
  return {
    sessionId: SESSION_ID,
    machineId: 1,
    projectPath: '/repo',
    transcriptPath: '/home/user/.claude/projects/x/session.jsonl',
    startedAtFallback: new Date('2026-01-01T00:00:00Z'),
    chunks: [],
    aggregate: EMPTY_AGGREGATE,
    toolCalls: [],
    messageIndexRows: [],
    contextReadings: [],
    compactions: [],
    promptEvents: [],
    checkpoint: EMPTY_CHECKPOINT,
    ingestedBytes: 0,
    isNew: true,
    fresh: true,
    nextChunkSeq: 0,
    ...overrides,
  };
}

describe('writeIngestCycle', () => {
  it('a fresh cycle deletes existing chunk/message/tool_calls/context_events rows first', async () => {
    const { sql, calls } = recordingSql();
    await writeIngestCycle(sql, baseParams({ fresh: true, isNew: false }));
    const deletes = calls.filter((c) => c.text.startsWith('DELETE FROM'));
    expect(deletes).toHaveLength(5);
    expect(deletes.some((c) => c.text.includes('transcript_chunks'))).toBe(true);
    expect(deletes.some((c) => c.text.includes('transcript_messages'))).toBe(true);
    expect(deletes.some((c) => c.text.includes('tool_calls'))).toBe(true);
    expect(deletes.some((c) => c.text.includes('context_events'))).toBe(true);
    expect(deletes.some((c) => c.text.includes('prompt_events'))).toBe(true);
  });

  it('an ordinary append (fresh: false) never deletes — tool_calls stays append-only', async () => {
    const { sql, calls } = recordingSql();
    await writeIngestCycle(
      sql,
      baseParams({
        fresh: false,
        isNew: false,
        toolCalls: [{ msgUuid: 'u1', msgIndex: 0, ts: null, toolName: 'Read', target: '/a.ts', isSidechain: false }],
      })
    );
    expect(calls.some((c) => c.text.startsWith('DELETE FROM'))).toBe(false);
    expect(calls.some((c) => c.text.includes('INSERT INTO sessions.tool_calls'))).toBe(true);
  });

  it('isNew inserts a new session row; otherwise it updates the existing one', async () => {
    const { sql: insertSql, calls: insertCalls } = recordingSql();
    await writeIngestCycle(insertSql, baseParams({ isNew: true }));
    expect(insertCalls.some((c) => c.text.includes('INSERT INTO sessions.sessions'))).toBe(true);
    expect(insertCalls.some((c) => c.text.includes('UPDATE sessions.sessions'))).toBe(false);

    const { sql: updateSql, calls: updateCalls } = recordingSql();
    await writeIngestCycle(updateSql, baseParams({ isNew: false, fresh: false }));
    expect(updateCalls.some((c) => c.text.includes('UPDATE sessions.sessions'))).toBe(true);
    expect(updateCalls.some((c) => c.text.includes('INSERT INTO sessions.sessions'))).toBe(false);
  });

  it('an empty chunk set (e.g. a fresh re-ingest of a now-empty file) still writes the session row', async () => {
    const { sql, calls } = recordingSql();
    await writeIngestCycle(sql, baseParams({ chunks: [], fresh: true, isNew: false }));
    expect(calls.some((c) => c.text.includes('INSERT INTO sessions.transcript_chunks'))).toBe(false);
    expect(calls.some((c) => c.text.includes('UPDATE sessions.sessions'))).toBe(true);
  });

  it('batches tool_calls inserts so no single statement holds an unbounded row count', async () => {
    const { sql, calls } = recordingSql();
    const manyToolCalls: ToolCall[] = Array.from({ length: 45_000 }, (_, i) => ({
      msgUuid: `u${i}`,
      msgIndex: i,
      ts: null,
      toolName: 'Bash',
      target: `cmd ${i}`,
      isSidechain: false,
    }));
    await writeIngestCycle(sql, baseParams({ toolCalls: manyToolCalls, fresh: false, isNew: false }));
    const inserts = calls.filter((c) => c.text.includes('INSERT INTO sessions.tool_calls'));
    // 45,000 rows / 20,000-row batches = 3 statements (matches TOOL_CALL_INSERT_BATCH in chunk-store.ts).
    expect(inserts).toHaveLength(3);
  });

  const oneReading: ContextReading[] = [{ seq: 1, ts: new Date('2026-01-01T00:00:00Z'), tokens: 1000 }];
  const oneCompaction: ContextCompaction[] = [
    { seq: 2, ts: new Date('2026-01-01T00:01:00Z'), trigger: 'auto', preTokens: 900_000, postTokens: 20_000 },
  ];

  describe('timeline live-ingest/backfill handoff', () => {
    it('a brand-new session (isNew) writes context_events without checking the flag', async () => {
      const { sql, calls } = recordingSql();
      await writeIngestCycle(
        sql,
        baseParams({ isNew: true, fresh: true, contextReadings: oneReading, compactions: oneCompaction })
      );
      expect(calls.some((c) => c.text.includes('SELECT timeline_backfill_done'))).toBe(false);
      expect(calls.some((c) => c.text.includes('INSERT INTO sessions.context_events') && c.text.includes("'reading'"))).toBe(true);
      expect(calls.some((c) => c.text.includes('INSERT INTO sessions.context_events') && c.text.includes("'compaction'"))).toBe(true);
      // The new-session INSERT marks the row caught up (no backlog to backfill).
      const insert = calls.find((c) => c.text.includes('INSERT INTO sessions.sessions'))!;
      expect(insert.values.at(-1)).toBe(true);
    });

    it('a fresh re-ingest of an existing session writes events and resets the backfill cursor', async () => {
      const { sql, calls } = recordingSql();
      await writeIngestCycle(
        sql,
        baseParams({ isNew: false, fresh: true, contextReadings: oneReading, compactions: oneCompaction })
      );
      expect(calls.some((c) => c.text.includes('SELECT timeline_backfill_done'))).toBe(false);
      expect(calls.some((c) => c.text.includes('INSERT INTO sessions.context_events'))).toBe(true);
      expect(
        calls.some(
          (c) =>
            c.text.includes('UPDATE sessions.sessions') &&
            c.text.includes('timeline_backfill_done') &&
            c.text.includes('timeline_backfill_next_chunk_seq')
        )
      ).toBe(true);
    });

    it('an ordinary append checks the flag first and skips writing events when backfill is not yet done', async () => {
      const { sql, calls } = recordingSql({ 'SELECT timeline_backfill_done': [{ timeline_backfill_done: false }] });
      await writeIngestCycle(
        sql,
        baseParams({ isNew: false, fresh: false, contextReadings: oneReading, compactions: oneCompaction })
      );
      expect(calls.some((c) => c.text.includes('SELECT timeline_backfill_done'))).toBe(true);
      expect(calls.some((c) => c.text.includes('INSERT INTO sessions.context_events'))).toBe(false);
      // The flag-check must be the FIRST statement touching the session row —
      // ordering is what makes the handoff race-free (see writeIngestCycle's
      // doc comment).
      expect(calls[0]!.text).toContain('SELECT timeline_backfill_done');
    });

    it('an ordinary append writes events once backfill has already finished', async () => {
      const { sql, calls } = recordingSql({ 'SELECT timeline_backfill_done': [{ timeline_backfill_done: true }] });
      await writeIngestCycle(
        sql,
        baseParams({ isNew: false, fresh: false, contextReadings: oneReading, compactions: oneCompaction })
      );
      expect(calls.some((c) => c.text.includes('INSERT INTO sessions.context_events') && c.text.includes("'reading'"))).toBe(true);
      expect(calls.some((c) => c.text.includes('INSERT INTO sessions.context_events') && c.text.includes("'compaction'"))).toBe(true);
    });
  });
});

describe('getChunkState', () => {
  it('returns null when no session row exists', async () => {
    const { sql } = recordingSql();
    const state = await getChunkState(sql, SESSION_ID);
    expect(state).toBeNull();
  });

  it('parses a chunked session row plus its last chunk', async () => {
    const { sql } = recordingSql({
      'FROM sessions.sessions': [
        {
          machine_id: 1,
          ingested_bytes: '12345',
          parse_checkpoint: { v: 1, msgIndex: 10, openChains: [], lastActivityEnd: null },
          user_messages: JSON.stringify(['hi']),
          tools_used: JSON.stringify(['Read']),
          files_touched: JSON.stringify({ reads: ['/a.ts'], writes: [] }),
          input_tokens: '100',
          output_tokens: '50',
          cache_read_tokens: '0',
          context_final_tokens: null,
          context_peak_tokens: null,
          context_model: null,
          started_at: new Date('2026-01-01T00:00:00Z'),
          ended_at: new Date('2026-01-01T01:00:00Z'),
          message_count: 4,
          git_branch: 'main',
          claude_version: '1.0.0',
          project_path: '/repo',
          models_used: JSON.stringify(['claude-x']),
          model_tokens: JSON.stringify({}),
          activity_ranges: JSON.stringify([]),
          session_name: null,
        },
      ],
      'FROM sessions.transcript_chunks': [{ seq: 3, byte_start: '1000', byte_end: '2000', content_hash: 'abc123' }],
    });

    const state = await getChunkState(sql, SESSION_ID);
    expect(state).not.toBeNull();
    expect(state!.ingestedBytes).toBe(12345);
    expect(state!.lastChunk).toEqual({ seq: 3, byteStart: 1000, byteEnd: 2000, contentHash: 'abc123' });
    expect(state!.aggregate.userMessages).toEqual(['hi']);
    expect(state!.aggregate.filesTouched.reads).toEqual(['/a.ts']);
    expect(state!.parseCheckpoint.msgIndex).toBe(10);
  });
});

// plans/live-session-output-tokens.md — the row reports settled + open-chain
// output; the parser resumes from settled only.
describe('open-chain output on the session row', () => {
  const openCheckpoint: ParseCheckpoint = {
    ...EMPTY_CHECKPOINT,
    msgIndex: 7,
    openChains: [
      { chainRoot: 'r1', tipUuid: 't1', model: 'claude-x', maxOutput: 40 },
      { chainRoot: 'r2', tipUuid: 't2', model: undefined, maxOutput: 2 },
    ],
  };
  const settled = {
    ...EMPTY_AGGREGATE,
    outputTokens: 100,
    modelTokens: { 'claude-x': { input: 1, output: 100, cacheRead: 0 } },
  };

  function sessionRow(overrides: Record<string, unknown>) {
    return {
      machine_id: 1,
      ingested_bytes: '10',
      parse_checkpoint: openCheckpoint,
      user_messages: '[]',
      tools_used: '[]',
      files_touched: '{}',
      input_tokens: '1',
      output_tokens: '142',
      cache_read_tokens: '0',
      context_final_tokens: null,
      context_peak_tokens: null,
      context_model: null,
      started_at: null,
      ended_at: null,
      message_count: 7,
      git_branch: null,
      claude_version: null,
      project_path: null,
      models_used: '["claude-x"]',
      model_tokens: { 'claude-x': { input: 1, output: 140, cacheRead: 0 } },
      activity_ranges: '[]',
      session_name: null,
      ...overrides,
    };
  }

  it('adding then removing open-chain output round-trips the aggregate', () => {
    const reported = applyOpenChainOutput(settled, openCheckpoint, 1);
    expect(reported.outputTokens).toBe(142);
    expect(reported.modelTokens['claude-x']!.output).toBe(140);
    expect(applyOpenChainOutput(reported, openCheckpoint, -1)).toEqual(settled);
  });

  it('writeIngestCycle stores settled + open output and marks the checkpoint', async () => {
    const { sql, calls } = recordingSql();
    await writeIngestCycle(sql, baseParams({ aggregate: settled, checkpoint: openCheckpoint }));
    const insert = calls.find((c) => c.text.includes('INSERT INTO sessions.sessions'))!;
    expect(insert.values).toContain(142);
    expect(insert.values).toContainEqual({ 'claude-x': { input: 1, output: 140, cacheRead: 0 } });
    expect(insert.values).toContainEqual({ ...openCheckpoint, rowIncludesOpenChains: true });
  });

  it('getChunkState strips open-chain output from a marked row', async () => {
    const { sql } = recordingSql({
      'FROM sessions.sessions': [
        sessionRow({ parse_checkpoint: { ...openCheckpoint, rowIncludesOpenChains: true } }),
      ],
    });
    const state = await getChunkState(sql, SESSION_ID);
    expect(state!.aggregate.outputTokens).toBe(100);
    expect(state!.aggregate.modelTokens['claude-x']!.output).toBe(100);
    expect(state!.parseCheckpoint).toEqual(openCheckpoint);
  });

  it('getChunkState loads an unmarked (pre-change) row as settled', async () => {
    const { sql } = recordingSql({
      'FROM sessions.sessions': [
        sessionRow({ output_tokens: '100', model_tokens: { 'claude-x': { input: 1, output: 100, cacheRead: 0 } } }),
      ],
    });
    const state = await getChunkState(sql, SESSION_ID);
    expect(state!.aggregate.outputTokens).toBe(100);
    expect(state!.aggregate.modelTokens['claude-x']!.output).toBe(100);
  });
});

describe('context limit on the session row', () => {
  it('writeIngestCycle resolves the limit from the context model on insert and update', async () => {
    const aggregate = { ...EMPTY_AGGREGATE, contextFinalTokens: 5000, contextPeakTokens: 6000, contextModel: 'claude-opus-4-5-20251101' };
    for (const isNew of [true, false]) {
      const { sql, calls } = recordingSql({ timeline_backfill_done: [{ timeline_backfill_done: true, prompt_backfill_done: true, activity_ranges: [] }] });
      await writeIngestCycle(sql, baseParams({ aggregate, isNew, fresh: isNew }));
      const write = calls.find((c) => c.text.includes(isNew ? 'INSERT INTO sessions.sessions' : 'UPDATE sessions.sessions SET'))!;
      expect(write.text).toContain('context_limit_tokens');
      expect(write.values).toContain(200_000);
    }
  });
});
