/**
 * Database side of chunked transcript ingest (specs/behaviors/
 * session-transcript-storage.md). `chunked-ingest.ts` reads the right bytes
 * off disk or out of a push payload; this module writes them — one
 * transaction per cycle covering the chunk rows, the message index, the
 * append-only `tool_calls` index, and the session row's aggregate fields and
 * ingest bookkeeping.
 */

import type postgres from 'postgres';
import type { ToolCall } from './types.js';
import type { ChunkPiece } from './chunked-ingest.js';
import type { ParseCheckpoint } from './incremental-parser.js';
import { EMPTY_CHECKPOINT } from './incremental-parser.js';
import type { SessionAggregate } from './aggregate-merge.js';
import { EMPTY_AGGREGATE, boundedSearchText } from './aggregate-merge.js';

/**
 * Rows per batched INSERT. Bulk inserts here use `INSERT ... SELECT ... FROM
 * unnest($1::type[], $2::type[], ...)` — each column is ONE bind parameter
 * (the whole array), not one per row, so this is no longer bounded by
 * Postgres's 65,534-bind-parameter ceiling the way a `VALUES (...), (...),
 * ...` statement would be. The batch still exists to cap how much a single
 * statement/transaction buffers and sends at once, per specs/behaviors/
 * session-transcript-storage.md's "statement size never depends on session
 * length" — a very large per-cycle delta (a satellite that fell far behind)
 * shouldn't turn into one unbounded array payload.
 *
 * (`sql(rows, ...columns)` — postgres.js's row-object bulk-insert helper — is
 * used elsewhere in this codebase in its bare form, `` INSERT INTO t ${sql(rows,
 * ...cols)} `` (no literal column list, no explicit `VALUES` keyword; see the
 * original `SyncService.writeToolCalls` in this file's git history), which
 * works fine and is how postgres.js expects it to be invoked — it internally
 * generates both the column list and the `VALUES (...), (...)` text via its
 * `insert` builder. Combining that helper with an explicit `VALUES` keyword
 * of our own — `` INSERT INTO t (a, b, ...) VALUES ${sql(rows, ...cols)} ``,
 * which is what an early draft of this function did — throws `UNDEFINED_VALUE`
 * even for fully-defined rows (reproduced in isolation with explicit `null`s,
 * no undefined fields: the bare form succeeds, the explicit-`VALUES` form
 * fails, same row objects, same connection — this is a different failure
 * than #243's, which was a transcript line missing an expected field
 * yielding a genuine runtime `undefined` despite a `string | null` type;
 * see the defensive `?? null`/`?? ''` normalization below, added for that
 * class of bug specifically). `unnest` sidesteps needing to choose between
 * the two `sql(rows, ...)` forms at all, and is the standard efficient
 * bulk-insert shape besides.)
 */
const MESSAGE_INDEX_INSERT_BATCH = 20_000;
const TOOL_CALL_INSERT_BATCH = 20_000;

export interface LastChunkInfo {
  seq: number;
  byteStart: number;
  byteEnd: number;
  contentHash: string;
}

export interface ChunkState {
  exists: boolean;
  ingestedBytes: number;
  parseCheckpoint: ParseCheckpoint;
  lastChunk: LastChunkInfo | null;
  aggregate: SessionAggregate;
  machineId: number;
  /** Existing `transcript_path` column value — round-tripped unchanged
   * (`writeIngestCycle`'s UPDATE assigns it directly, not via COALESCE,
   * unlike `project_path`). */
  transcriptPath: string | null;
}

/** A `postgres.Sql` usable inside `sql.begin`'s callback (the tagged-template
 * call signature the transaction object actually has at runtime). */
type Tx = postgres.Sql;

interface ChunkStateRow {
  machine_id: number;
  ingested_bytes: string | number;
  parse_checkpoint: unknown;
  transcript_path: string | null;
  user_messages: unknown;
  tools_used: unknown;
  files_touched: unknown;
  input_tokens: string | number;
  output_tokens: string | number;
  cache_read_tokens: string | number;
  context_final_tokens: number | null;
  context_peak_tokens: number | null;
  context_model: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  message_count: number;
  git_branch: string | null;
  claude_version: string | null;
  project_path: string | null;
  models_used: unknown;
  model_tokens: unknown;
  activity_ranges: unknown;
  session_name: string | null;
}

function toChunkState(
  row: ChunkStateRow,
  lastChunk: { seq: number; byte_start: string | number; byte_end: string | number; content_hash: string } | undefined
): ChunkState {
  const asArray = (v: unknown): string[] => (typeof v === 'string' ? JSON.parse(v) : ((v ?? []) as string[]));
  const asObj = (v: unknown): Record<string, unknown> =>
    typeof v === 'string' ? JSON.parse(v) : ((v as Record<string, unknown>) ?? {});

  const filesTouched = asObj(row.files_touched) as { reads?: string[]; writes?: string[] };

  return {
    exists: true,
    ingestedBytes: Number(row.ingested_bytes),
    parseCheckpoint: (row.parse_checkpoint as ParseCheckpoint | null) ?? EMPTY_CHECKPOINT,
    transcriptPath: row.transcript_path,
    lastChunk: lastChunk
      ? {
          seq: lastChunk.seq,
          byteStart: Number(lastChunk.byte_start),
          byteEnd: Number(lastChunk.byte_end),
          contentHash: lastChunk.content_hash,
        }
      : null,
    machineId: row.machine_id,
    aggregate: {
      userMessages: asArray(row.user_messages),
      toolsUsed: asArray(row.tools_used),
      filesTouched: { reads: filesTouched.reads ?? [], writes: filesTouched.writes ?? [] },
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      contextFinalTokens: row.context_final_tokens,
      contextPeakTokens: row.context_peak_tokens,
      contextModel: row.context_model,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      messageCount: row.message_count,
      gitBranch: row.git_branch,
      claudeVersion: row.claude_version,
      cwd: row.project_path,
      parseErrors: 0,
      modelsUsed: asArray(row.models_used),
      modelTokens: asObj(row.model_tokens) as SessionAggregate['modelTokens'],
      activityRanges: asArray(row.activity_ranges) as unknown as SessionAggregate['activityRanges'],
      sessionName: row.session_name,
    },
  };
}

const CHUNK_STATE_COLUMNS = (q: postgres.Sql) => q`
      machine_id, ingested_bytes, parse_checkpoint,
      user_messages, tools_used, files_touched,
      input_tokens, output_tokens, cache_read_tokens,
      context_final_tokens, context_peak_tokens, context_model,
      started_at, ended_at, message_count, git_branch, claude_version, project_path,
      transcript_path,
      models_used, model_tokens, activity_ranges, session_name`;

/** Read a session's current chunk-ingest state, or `null` if no row exists yet. */
export async function getChunkState(sql: postgres.Sql, sessionId: string): Promise<ChunkState | null> {
  const [row] = await sql<ChunkStateRow[]>`
    SELECT ${CHUNK_STATE_COLUMNS(sql)}
    FROM sessions.sessions
    WHERE id = ${sessionId}::uuid
  `;
  if (!row) return null;

  const [lastChunk] = await sql<
    { seq: number; byte_start: string | number; byte_end: string | number; content_hash: string }[]
  >`
    SELECT seq, byte_start, byte_end, content_hash
    FROM sessions.transcript_chunks
    WHERE session_id = ${sessionId}::uuid
    ORDER BY seq DESC
    LIMIT 1
  `;

  return toChunkState(row, lastChunk);
}

export interface WriteCycleParams {
  sessionId: string;
  machineId: number;
  projectPath: string | null;
  transcriptPath: string | null;
  startedAtFallback: Date;
  /** Chunk rows to append, in order, covering the newly-accepted byte range. */
  chunks: ChunkPiece[];
  aggregate: SessionAggregate;
  toolCalls: ToolCall[];
  messageIndexRows: Array<{ seq: number; uuid: string }>;
  checkpoint: ParseCheckpoint;
  ingestedBytes: number;
  /** `true` for a brand-new session (INSERT); `false` to UPDATE an existing row. */
  isNew: boolean;
  /** `true` when this cycle replaces the chunk series from scratch (continuity
   * failure) — deletes existing chunks/messages/tool_calls first. */
  fresh: boolean;
  nextChunkSeq: number;
}

async function forEachBatch<T>(rows: T[], batchSize: number, run: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    await run(rows.slice(i, i + batchSize));
  }
}

/**
 * Write one ingest cycle in a single transaction: chunk rows, message index
 * rows, append-only tool_calls, and the session row (aggregate fields +
 * ingest bookkeeping). `fresh` is the only path that deletes existing
 * chunk/message/tool_calls rows (a continuity-failure re-ingest); an ordinary
 * append only ever inserts.
 */
export async function writeIngestCycle(sql: postgres.Sql, p: WriteCycleParams): Promise<void> {
  await sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as Tx;

    if (p.fresh) {
      await tx`DELETE FROM sessions.transcript_chunks WHERE session_id = ${p.sessionId}::uuid`;
      await tx`DELETE FROM sessions.transcript_messages WHERE session_id = ${p.sessionId}::uuid`;
      await tx`DELETE FROM sessions.tool_calls WHERE session_id = ${p.sessionId}::uuid`;
    }

    const a = p.aggregate;
    const searchText = boundedSearchText(a.userMessages);
    const startedAt = a.startedAt ?? p.startedAtFallback;

    // The session row must exist before chunk/message/tool_calls rows can
    // reference it (all three FK-reference sessions.sessions.id) — write it
    // first, always, whether this cycle inserts a new row or updates one.
    if (p.isNew) {
      await tx`
        INSERT INTO sessions.sessions (
          id, machine_id, project_path, git_branch, started_at, ended_at,
          user_messages, tools_used, files_touched,
          input_tokens, output_tokens, cache_read_tokens,
          transcript_path, transcript_hash,
          search_text, message_count, user_message_count, claude_version,
          models_used, model_tokens, activity_ranges, session_name,
          context_final_tokens, context_peak_tokens, context_model,
          ingested_bytes, parse_checkpoint
        ) VALUES (
          ${p.sessionId}::uuid, ${p.machineId}, ${p.projectPath}, ${a.gitBranch},
          ${startedAt}, ${a.endedAt},
          ${tx.json(a.userMessages)}, ${tx.json(a.toolsUsed)}, ${tx.json(a.filesTouched as any)},
          ${a.inputTokens}, ${a.outputTokens}, ${a.cacheReadTokens},
          -- transcript_hash is vestigial for a chunked session (change
          -- detection is size + last-chunk hash, not a whole-content hash);
          -- left empty rather than dropping the NOT NULL column.
          ${p.transcriptPath}, ${''},
          ${searchText}, ${a.messageCount}, ${a.userMessages.length}, ${a.claudeVersion},
          ${tx.json(a.modelsUsed)}, ${tx.json(a.modelTokens as any)}, ${tx.json(a.activityRanges as any)}, ${a.sessionName},
          ${a.contextFinalTokens}, ${a.contextPeakTokens}, ${a.contextModel},
          ${p.ingestedBytes}, ${tx.json(p.checkpoint as any)}
        )
      `;
    } else {
      await tx`
        UPDATE sessions.sessions SET
          project_path = COALESCE(project_path, ${p.projectPath}),
          git_branch = COALESCE(git_branch, ${a.gitBranch}),
          started_at = LEAST(started_at, ${startedAt}),
          -- GREATEST/LEAST ignore NULL operands in Postgres (only NULL if
          -- every operand is), so a cycle with no new timestamps (a.endedAt
          -- null) leaves the existing value untouched.
          ended_at = GREATEST(ended_at, ${a.endedAt}),
          user_messages = ${tx.json(a.userMessages)},
          tools_used = ${tx.json(a.toolsUsed)},
          files_touched = ${tx.json(a.filesTouched as any)},
          input_tokens = ${a.inputTokens},
          output_tokens = ${a.outputTokens},
          cache_read_tokens = ${a.cacheReadTokens},
          transcript_path = ${p.transcriptPath},
          search_text = ${searchText},
          message_count = ${a.messageCount},
          user_message_count = ${a.userMessages.length},
          claude_version = COALESCE(claude_version, ${a.claudeVersion}),
          models_used = ${tx.json(a.modelsUsed)},
          model_tokens = ${tx.json(a.modelTokens as any)},
          activity_ranges = ${tx.json(a.activityRanges as any)},
          session_name = ${a.sessionName},
          context_final_tokens = ${a.contextFinalTokens},
          context_peak_tokens = ${a.contextPeakTokens},
          context_model = ${a.contextModel},
          ingested_bytes = ${p.ingestedBytes},
          parse_checkpoint = ${tx.json(p.checkpoint as any)},
          synced_at = NOW()
        WHERE id = ${p.sessionId}::uuid
      `;
    }

    if (p.chunks.length > 0) {
      // Each piece already carries its own [msgSeqStart, msgSeqEnd] — computed
      // by chunkLines() from the SAME lineSeqs feed() produced, so chunking
      // and parsing never have to independently agree on a byte<->seq mapping.
      const chunkRows = p.chunks.map((c, i) => ({
        seq: p.nextChunkSeq + i,
        byteStart: c.byteStart,
        byteEnd: c.byteEnd,
        msgSeqStart: c.msgSeqStart,
        msgSeqEnd: c.msgSeqEnd,
        content: c.content,
        contentHash: c.contentHash,
      }));

      await tx`
        INSERT INTO sessions.transcript_chunks
          (session_id, seq, byte_start, byte_end, msg_seq_start, msg_seq_end, content, content_hash)
        SELECT ${p.sessionId}::uuid, * FROM unnest(
          ${chunkRows.map((c) => c.seq)}::int[],
          ${chunkRows.map((c) => c.byteStart)}::bigint[],
          ${chunkRows.map((c) => c.byteEnd)}::bigint[],
          ${chunkRows.map((c) => c.msgSeqStart)}::int[],
          ${chunkRows.map((c) => c.msgSeqEnd)}::int[],
          ${chunkRows.map((c) => c.content)}::text[],
          ${chunkRows.map((c) => c.contentHash)}::text[]
        )
      `;

      // Map each message seq to the chunk seq that contains it, by the
      // [msgSeqStart, msgSeqEnd] range each chunk row carries above.
      const chunkSeqForMsgSeq = (seq: number): number => {
        for (const c of chunkRows) {
          if (c.msgSeqStart === -1) continue; // chunk with no seq'd lines
          if (seq >= c.msgSeqStart && seq <= c.msgSeqEnd) return c.seq;
        }
        return chunkRows[chunkRows.length - 1]!.seq;
      };

      if (p.messageIndexRows.length > 0) {
        await forEachBatch(p.messageIndexRows, MESSAGE_INDEX_INSERT_BATCH, (batch) => {
          const seqs = batch.map((m) => m.seq);
          const uuids = batch.map((m) => m.uuid);
          const chunkSeqs = batch.map((m) => chunkSeqForMsgSeq(m.seq));
          return tx`
            INSERT INTO sessions.transcript_messages (session_id, seq, uuid, chunk_seq)
            SELECT ${p.sessionId}::uuid, * FROM unnest(${seqs}::int[], ${uuids}::text[], ${chunkSeqs}::int[])
          `;
        });
      }
    }

    if (p.toolCalls.length > 0) {
      // Append-only: never DELETE first (outside the `fresh` branch above),
      // so tool_calls.id stays stable and the ledger's ascending-id scan
      // never re-sees an already-derived row.
      await forEachBatch(p.toolCalls, TOOL_CALL_INSERT_BATCH, (batch) => {
        // `?? ''`/`?? null` on every field here, even though ToolCall's
        // fields are typed non-optional: a sibling module hit UNDEFINED_VALUE
        // in production from a transcript line missing an expected field
        // (e.g. no `timestamp`) yielding `undefined` at runtime despite a
        // `string | null` type, bound straight into postgres.js (PR #243).
        // Normalizing defensively here costs nothing and closes off that
        // whole class of failure regardless of what upstream parsing
        // guarantees. `msg_uuid`/`msg_index`/`tool_name` are NOT NULL
        // columns, so they fall back to a value that can't violate that.
        const msgUuids = batch.map((tc) => tc.msgUuid ?? '');
        const msgIndexes = batch.map((tc) => tc.msgIndex ?? 0);
        // ISO strings, not raw Date objects: a bound parameter that is a JS
        // array of Date objects gets its type inferred from the first
        // element and sent as a scalar `timestamptz`, so the explicit
        // `::timestamptz[]` cast then fails with "cannot cast type timestamp
        // with time zone to timestamp with time zone[]" (reproduced in
        // isolation: `${[new Date(), new Date()]}::timestamptz[]` errors;
        // `${[iso, iso]}::timestamptz[]` with the same values as ISO strings
        // does not). ISO strings infer as a text array and cast cleanly.
        const tsValues = batch.map((tc) => tc.ts?.toISOString() ?? null);
        const toolNames = batch.map((tc) => tc.toolName ?? '');
        const targets = batch.map((tc) => tc.target ?? null);
        // 0/1 ints, not booleans: the same scalar-inference issue hits a
        // bound array of JS booleans — `${[true, false]}::bool[]` errors
        // with "cannot cast type boolean to boolean[]" for the same reason
        // (reproduced in isolation). Binding ints and casting back to
        // boolean in the SELECT list sidesteps it.
        const isSidechainInts = batch.map((tc) => (tc.isSidechain ? 1 : 0));
        return tx`
          INSERT INTO sessions.tool_calls (session_id, msg_uuid, msg_index, ts, tool_name, target, is_sidechain)
          SELECT ${p.sessionId}::uuid, msg_uuid, msg_index, ts, tool_name, target, (is_sidechain_int <> 0)
          FROM unnest(
            ${msgUuids}::text[], ${msgIndexes}::int[], ${tsValues}::timestamptz[],
            ${toolNames}::text[], ${targets}::text[], ${isSidechainInts}::int[]
          ) AS u(msg_uuid, msg_index, ts, tool_name, target, is_sidechain_int)
        `;
      });
    }
  });
}
