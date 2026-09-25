import { describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { getChunkState, writeIngestCycle, type WriteCycleParams } from './chunk-store.js';
import { EMPTY_CHECKPOINT } from './incremental-parser.js';
import { EMPTY_AGGREGATE } from './aggregate-merge.js';
import type { ToolCall } from './types.js';

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
    checkpoint: EMPTY_CHECKPOINT,
    ingestedBytes: 0,
    storage: 'chunked',
    catchupThresholdBytes: null,
    clearRawTranscript: false,
    isNew: true,
    fresh: true,
    nextChunkSeq: 0,
    ...overrides,
  };
}

describe('writeIngestCycle', () => {
  it('a fresh cycle deletes existing chunk/message/tool_calls rows first', async () => {
    const { sql, calls } = recordingSql();
    await writeIngestCycle(sql, baseParams({ fresh: true, isNew: false }));
    const deletes = calls.filter((c) => c.text.startsWith('DELETE FROM'));
    expect(deletes).toHaveLength(3);
    expect(deletes.some((c) => c.text.includes('transcript_chunks'))).toBe(true);
    expect(deletes.some((c) => c.text.includes('transcript_messages'))).toBe(true);
    expect(deletes.some((c) => c.text.includes('tool_calls'))).toBe(true);
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

  it('clearRawTranscript nulls raw_transcript in the same UPDATE (the catching_up -> chunked flip)', async () => {
    const { sql, calls } = recordingSql();
    await writeIngestCycle(
      sql,
      baseParams({ isNew: false, fresh: false, storage: 'chunked', catchupThresholdBytes: null, clearRawTranscript: true })
    );
    const update = calls.find((c) => c.text.includes('UPDATE sessions.sessions'))!;
    expect(update.text).toContain('raw_transcript = ?');
    // NULL is spliced in as a raw SQL fragment (not a bound value), so the
    // interpolated value for that slot is the postgres.js NULL fragment
    // object our fake just echoes back — the important thing is the clause
    // text itself resolves to NULL rather than the no-op `raw_transcript`.
  });

  it('a not-yet-caught-up cycle leaves raw_transcript untouched', async () => {
    const { sql, calls } = recordingSql();
    await writeIngestCycle(
      sql,
      baseParams({ isNew: false, fresh: false, storage: 'catching_up', catchupThresholdBytes: 5_000_000, clearRawTranscript: false })
    );
    const update = calls.find((c) => c.text.includes('UPDATE sessions.sessions'))!;
    expect(update.values).toContain(null); // catchup_threshold_bytes bound value
    expect(update.text).toContain('storage = ?');
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
          storage: 'chunked',
          ingested_bytes: '12345',
          parse_checkpoint: { v: 1, msgIndex: 10, openChains: [], lastActivityEnd: null },
          catchup_threshold_bytes: null,
          raw_transcript_length: null,
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
    expect(state!.storage).toBe('chunked');
    expect(state!.ingestedBytes).toBe(12345);
    expect(state!.lastChunk).toEqual({ seq: 3, byteStart: 1000, byteEnd: 2000, contentHash: 'abc123' });
    expect(state!.aggregate.userMessages).toEqual(['hi']);
    expect(state!.aggregate.filesTouched.reads).toEqual(['/a.ts']);
    expect(state!.parseCheckpoint.msgIndex).toBe(10);
  });
});
