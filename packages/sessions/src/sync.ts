import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import { hostname as getHostname } from 'node:os';
import { SessionScanner, type ScannerConfig, type LocalTranscriptFile } from './scanner.js';
import {
  DEFAULT_SESSION_IGNORE_MARKERS,
} from './ignore.js';
import {
  readBoundedTail,
  readByteRange,
  hashChunkContent,
  checkContinuity,
  checkContinuityInPayload,
  cutAtLastNewline,
  chunkLines,
  splitLinesWithTerminators,
  sliceByBytes,
  DEFAULT_CHUNK_MAX_BYTES,
  DEFAULT_INGEST_BUDGET_BYTES,
} from './chunked-ingest.js';
import { feed, finalize, EMPTY_CHECKPOINT } from './incremental-parser.js';
import { mergeParseDelta, EMPTY_AGGREGATE } from './aggregate-merge.js';
import { getChunkState, writeIngestCycle, type ChunkState } from './chunk-store.js';
import type {
  SyncResult,
  MachineRecord,
  PushPayload,
  SessionSignal,
  SessionPushData,
  InventoryPayload,
  InventoryResponse,
  InventoryBaseline,
} from './types.js';

export interface SyncServiceConfig extends ScannerConfig {
  machineId?: string;
  /** Disable local filesystem scanning */
  disableLocalIngest?: boolean;
  /** Per-chunk row size cap (specs/behaviors/session-transcript-storage.md; default 8 MiB). */
  chunkMaxBytes?: number;
  /** Per-cycle ingest budget, local sync and push alike (default 64 MiB). */
  ingestBudgetBytes?: number;
}

type IngestOutcome = 'ingested' | 'updated' | 'skipped';

/**
 * Service for syncing Claude Code sessions to the database — chunked,
 * incremental ingest (specs/behaviors/session-transcript-storage.md). Each
 * cycle reads only a session's new bytes (capped by `ingestBudgetBytes`),
 * parses them incrementally against a persisted checkpoint, and writes chunk
 * rows + an updated aggregate in one transaction (`chunk-store.ts`).
 */
export class SyncService {
  private sql: postgres.Sql;
  private log: FastifyBaseLogger;
  private scanner: SessionScanner;
  private machineId: string;
  private hostname: string;
  private disableLocalIngest: boolean;
  private ignoreContentMarkers: readonly string[];
  private chunkMaxBytes: number;
  private ingestBudgetBytes: number;

  constructor(
    sql: postgres.Sql,
    log: FastifyBaseLogger,
    config: SyncServiceConfig = {}
  ) {
    this.sql = sql;
    this.log = log;
    this.scanner = new SessionScanner(config);
    this.machineId = config.machineId ?? 'localhost';
    this.hostname = getHostname();
    this.disableLocalIngest = config.disableLocalIngest ?? false;
    this.ignoreContentMarkers =
      config.ignoreContentMarkers ?? DEFAULT_SESSION_IGNORE_MARKERS;
    this.chunkMaxBytes = config.chunkMaxBytes ?? DEFAULT_CHUNK_MAX_BYTES;
    this.ingestBudgetBytes = config.ingestBudgetBytes ?? DEFAULT_INGEST_BUDGET_BYTES;
  }

  /**
   * Run a full sync for localhost
   * @param forceReparse - re-ingest every touched session from byte zero this
   *   cycle (and successive cycles for anything bigger than one budget),
   *   rather than only on a continuity failure — for parser upgrades.
   */
  async syncLocal(forceReparse = false): Promise<SyncResult> {
    if (this.disableLocalIngest) {
      this.log.info('Local session ingest disabled via disableLocalIngest config');
      return { sessionsScanned: 0, sessionsIngested: 0, sessionsUpdated: 0, sessionsSkipped: 0, errors: [] };
    }

    const result: SyncResult = {
      sessionsScanned: 0,
      sessionsIngested: 0,
      sessionsUpdated: 0,
      sessionsSkipped: 0,
      errors: [],
    };

    try {
      const machine = await this.ensureMachine(this.machineId, this.hostname, true);

      for await (const file of this.scanner.listLocalTranscripts()) {
        result.sessionsScanned++;
        try {
          const outcome = await this.ingestLocalFile(machine.id, file, forceReparse);
          if (outcome === 'ingested') result.sessionsIngested++;
          else if (outcome === 'updated') result.sessionsUpdated++;
          else result.sessionsSkipped++;
        } catch (error) {
          const message = `Failed to ingest ${file.sessionId}: ${error}`;
          result.errors.push(message);
          this.log.error({ error, sessionId: file.sessionId }, message);
        }
      }

      await this.updateMachineSync(machine.id);

      this.log.info(
        { result },
        `Sync completed: ${result.sessionsIngested} new, ${result.sessionsUpdated} updated`
      );
    } catch (error) {
      const message = `Sync failed: ${error}`;
      result.errors.push(message);
      this.log.error({ error }, message);
    }

    return result;
  }

  /** One local-transcript file's ingest decision: unchanged / append / re-ingest. */
  private async ingestLocalFile(
    machineId: number,
    file: LocalTranscriptFile,
    forceReparse: boolean
  ): Promise<IngestOutcome> {
    const state = await getChunkState(this.sql, file.sessionId);

    if (!state) {
      const { content } = await readBoundedTail(file.transcriptPath, 0, this.ingestBudgetBytes);
      if (content.length === 0) return 'skipped';
      if (this.ignoreContentMarkers.length > 0 && this.scanner.isIgnoredTranscript(file.sessionId, content)) {
        return 'skipped';
      }
      await this.runCycle({
        sessionId: file.sessionId,
        machineId,
        transcriptPath: file.transcriptPath,
        signal: file.signal,
        isNewSession: true,
        priorState: null,
        fresh: true,
        newContent: content,
        baseByteOffset: 0,
      });
      return 'ingested';
    }

    // Cheap change signal: compare on-disk size to what's already archived —
    // no read (specs/behaviors/session-sync-memory-bounds.md: "Unchanged
    // transcripts cost a stat").
    if (!forceReparse && file.size === state.ingestedBytes) return 'skipped';

    let fresh = forceReparse;
    if (!fresh && state.lastChunk) {
      const cont = await checkContinuity(file.transcriptPath, state.ingestedBytes, state.lastChunk);
      if (cont === 'mismatch') {
        // Transcripts are append-only, so this should be rare; when it fires,
        // the stored chunks are replaced and any content no longer in the
        // file is gone from the archive — make that visible.
        this.log.warn(
          { sessionId: file.sessionId, ingestedBytes: state.ingestedBytes, fileSize: file.size },
          'Transcript continuity mismatch; re-ingesting from byte 0'
        );
        fresh = true;
      }
    }

    const fromByte = fresh ? 0 : state.ingestedBytes;
    const { content } = await readBoundedTail(file.transcriptPath, fromByte, this.ingestBudgetBytes);
    if (!fresh && content.length === 0) return 'skipped';

    await this.runCycle({
      sessionId: file.sessionId,
      machineId,
      transcriptPath: file.transcriptPath,
      signal: file.signal,
      isNewSession: false,
      priorState: fresh ? null : state,
      fresh,
      newContent: content,
      baseByteOffset: fromByte,
    });
    return 'updated';
  }

  /**
   * Process a push from a satellite machine. Accepts both the tail-only
   * payload a chunked-ingest-aware CLI sends (`sinceBytes` set) and the whole
   * file an older CLI still sends (`sinceBytes` absent) — see
   * `ingestPushedSession`.
   */
  async processPush(payload: PushPayload): Promise<SyncResult> {
    const result: SyncResult = {
      sessionsScanned: payload.sessions.length,
      sessionsIngested: 0,
      sessionsUpdated: 0,
      sessionsSkipped: 0,
      errors: [],
    };

    const forceReparse = payload.forceReparse ?? false;

    try {
      const machine = await this.ensureMachine(payload.machineId, payload.hostname ?? null, false);

      for (const sessionData of payload.sessions) {
        try {
          const outcome = await this.ingestPushedSession(machine.id, sessionData, forceReparse);
          if (outcome === 'ingested') result.sessionsIngested++;
          else if (outcome === 'updated') result.sessionsUpdated++;
          else result.sessionsSkipped++;
        } catch (error) {
          const message = `Failed to ingest ${sessionData.sessionId}: ${error}`;
          result.errors.push(message);
          this.log.error({ error, sessionId: sessionData.sessionId }, message);
        }
      }

      await this.updateMachineSync(machine.id);
    } catch (error) {
      const message = `Push processing failed: ${error}`;
      result.errors.push(message);
      this.log.error({ error }, message);
    }

    return result;
  }

  /**
   * Cut a push payload's content to the ingest budget, at the last complete
   * line — the same "complete lines only, cut at the last newline" rule
   * local sync's `readBoundedTail` applies, so a payload without a trailing
   * newline (an in-progress last line) defers that line to the next cycle
   * rather than archiving a partial JSON line.
   */
  private capToBudget(content: string): string {
    const buf = Buffer.from(content, 'utf8');
    const capped = buf.length > this.ingestBudgetBytes ? buf.subarray(0, this.ingestBudgetBytes) : buf;
    const { content: cut } = cutAtLastNewline(capped);
    return cut;
  }

  /**
   * Process one satellite-pushed session. A session the server has never
   * seen is a fresh chunked ingest, same as local sync's first cycle. An
   * already-known session accepts a tail-only payload from a chunked-ingest-
   * aware CLI (`sinceBytes` matches `ingestedBytes`) or a legacy whole-file
   * payload from an older CLI (`sinceBytes` absent) — see the splice-in-tail
   * logic below, which re-verifies continuity against the payload itself
   * (no disk access on this side) before trusting either shape.
   */
  private async ingestPushedSession(
    machineId: number,
    sessionData: SessionPushData,
    forceReparse: boolean
  ): Promise<IngestOutcome> {
    const { signal, sessionId, transcriptPath, transcript } = sessionData;
    const payloadStartByte = sessionData.sinceBytes ?? 0;

    // Suppression only applies when the payload starts at byte zero — a
    // continuation tail can't carry the initiating-prompt marker in a way
    // that changes admission; the session was already admitted (or not) when
    // its first bytes arrived.
    if (payloadStartByte === 0 && this.ignoreContentMarkers.length > 0) {
      if (this.scanner.isIgnoredTranscript(sessionId, transcript)) return 'skipped';
    }

    const state = await getChunkState(this.sql, sessionId);

    if (!state) {
      const content = this.capToBudget(transcript);
      if (content.length === 0) return 'skipped';
      await this.runCycle({
        sessionId,
        machineId,
        transcriptPath,
        signal,
        isNewSession: true,
        priorState: null,
        fresh: true,
        newContent: content,
        baseByteOffset: 0,
      });
      return 'ingested';
    }

    let fresh = forceReparse;
    let effectiveStart = payloadStartByte;
    let effectiveContent = transcript;

    if (!fresh) {
      if (payloadStartByte === state.ingestedBytes) {
        // Matches exactly — the common case for a chunked-ingest-aware CLI.
      } else if (payloadStartByte <= (state.lastChunk?.byteStart ?? 0)) {
        // A legacy whole-file payload, or one with a stale offset that still
        // covers our last archived chunk: re-verify continuity against the
        // payload itself (no disk access on this side).
        const cont = checkContinuityInPayload(transcript, payloadStartByte, state.lastChunk);
        if (cont === 'mismatch') {
          this.log.warn({ sessionId, ingestedBytes: state.ingestedBytes }, 'Pushed transcript continuity mismatch; re-ingesting from byte 0');
          fresh = true;
        } else {
          effectiveStart = state.ingestedBytes;
          effectiveContent = sliceByBytes(
            transcript,
            state.ingestedBytes - payloadStartByte,
            Buffer.byteLength(transcript, 'utf8')
          );
        }
      } else {
        // Starts after our recorded ingestedBytes with nothing to verify
        // against — can't safely splice this in. Skip; the next
        // inventory-driven cycle will hand the satellite the right offset.
        return 'skipped';
      }
    }

    if (fresh) {
      effectiveStart = 0;
      effectiveContent = transcript;
    }

    const content = this.capToBudget(effectiveContent);
    if (!fresh && content.length === 0) return 'skipped';

    await this.runCycle({
      sessionId,
      machineId,
      transcriptPath,
      signal,
      isNewSession: false,
      priorState: fresh ? null : state,
      fresh,
      newContent: content,
      baseByteOffset: effectiveStart,
    });
    return 'updated';
  }

  /**
   * The shared write path for one ingest cycle, local or pushed: feed the new
   * lines through the incremental parser, fold the delta onto the existing
   * aggregate, chunk the same lines for storage, and write everything in one
   * transaction (`chunk-store.ts#writeIngestCycle`).
   */
  private async runCycle(params: {
    sessionId: string;
    machineId: number;
    transcriptPath: string;
    signal?: SessionSignal;
    isNewSession: boolean;
    /** Non-null only when `fresh` is false — the state to resume from. */
    priorState: ChunkState | null;
    /** True to replace the chunk series from scratch (continuity failure or
     * a forced reparse). */
    fresh: boolean;
    newContent: string;
    baseByteOffset: number;
  }): Promise<void> {
    const startCheckpoint = params.fresh ? EMPTY_CHECKPOINT : params.priorState!.parseCheckpoint;
    const priorAggregate = params.fresh ? EMPTY_AGGREGATE : params.priorState!.aggregate;
    const nextChunkSeq = params.fresh ? 0 : (params.priorState?.lastChunk?.seq ?? -1) + 1;

    const lines = splitLinesWithTerminators(params.newContent);
    const { checkpoint: fedCheckpoint, delta: feedDelta, lineSeqs } = feed(startCheckpoint, lines);

    let aggregate = mergeParseDelta(priorAggregate, feedDelta);
    let finalCheckpoint = fedCheckpoint;

    const hasEnded = !!params.signal?.ended_at;
    if (hasEnded) {
      const { checkpoint: fc, delta: finDelta } = finalize(fedCheckpoint);
      finalCheckpoint = fc;
      aggregate = mergeParseDelta(aggregate, finDelta);
    }

    if (params.signal?.ended_at) {
      aggregate = { ...aggregate, endedAt: new Date(parseFloat(params.signal.ended_at) * 1000) };
    }
    const startedAtFallback = aggregate.endedAt ?? new Date();

    const chunks = chunkLines(lines, lineSeqs, params.baseByteOffset, this.chunkMaxBytes);
    const consumedBytes = Buffer.byteLength(params.newContent, 'utf8');
    const ingestedBytes = params.baseByteOffset + consumedBytes;

    const projectPath = params.signal?.cwd ?? aggregate.cwd ?? null;

    await writeIngestCycle(this.sql, {
      sessionId: params.sessionId,
      machineId: params.machineId,
      projectPath,
      transcriptPath: params.transcriptPath,
      startedAtFallback,
      chunks,
      aggregate,
      toolCalls: feedDelta.toolCalls,
      messageIndexRows: feedDelta.messageIndexRows,
      checkpoint: finalCheckpoint,
      ingestedBytes,
      isNew: params.isNewSession,
      fresh: params.fresh,
      nextChunkSeq,
    });
  }

  /**
   * Process inventory from a satellite machine — Phase 1 of two-phase sync.
   * Returns which sessions the server needs plus, for each, a baseline
   * (`ingestedBytes` + last-chunk hash) so a chunked-ingest-aware CLI sends
   * only the tail.
   */
  async processInventory(payload: InventoryPayload): Promise<InventoryResponse> {
    const machine = await this.ensureMachine(payload.machineId, payload.hostname ?? null, false);
    const forceReparse = payload.forceReparse ?? false;

    const known = await this.getMachineChunkSummary(machine.id);

    const neededSessionIds: string[] = [];
    const baselines: Record<string, InventoryBaseline> = {};
    let upToDateCount = 0;

    for (const item of payload.inventory) {
      const k = known.get(item.sessionId);

      if (forceReparse) {
        neededSessionIds.push(item.sessionId);
        if (k) baselines[item.sessionId] = { ingestedBytes: 0, lastChunkHash: null };
        continue;
      }

      if (!k) {
        neededSessionIds.push(item.sessionId); // unknown to the server; no baseline => whole file
        continue;
      }

      if (item.size === undefined) {
        // Legacy inventory item — no cheap comparison available; always ask.
        neededSessionIds.push(item.sessionId);
        baselines[item.sessionId] = { ingestedBytes: k.ingestedBytes, lastChunkHash: k.lastChunkHash };
        continue;
      }

      if (item.size !== k.ingestedBytes) {
        neededSessionIds.push(item.sessionId);
        baselines[item.sessionId] = { ingestedBytes: k.ingestedBytes, lastChunkHash: k.lastChunkHash };
      } else {
        upToDateCount++;
      }
    }

    this.log.info(
      { machineId: payload.machineId, total: payload.inventory.length, needed: neededSessionIds.length, upToDate: upToDateCount },
      `Inventory processed: ${neededSessionIds.length} sessions needed, ${upToDateCount} up-to-date`
    );

    return { neededSessionIds, upToDateCount, baselines };
  }

  /** One row per session on a machine: current archived-bytes signal + last chunk hash. */
  private async getMachineChunkSummary(
    machineId: number
  ): Promise<Map<string, { ingestedBytes: number; lastChunkHash: string | null }>> {
    const rows = await this.sql<
      { id: string; ingested_bytes: string | number; last_chunk_hash: string | null }[]
    >`
      SELECT s.id, s.ingested_bytes, lc.content_hash AS last_chunk_hash
      FROM sessions.sessions s
      LEFT JOIN LATERAL (
        SELECT content_hash FROM sessions.transcript_chunks tc
        WHERE tc.session_id = s.id ORDER BY tc.seq DESC LIMIT 1
      ) lc ON true
      WHERE s.machine_id = ${machineId}
    `;
    const map = new Map<string, { ingestedBytes: number; lastChunkHash: string | null }>();
    for (const r of rows) {
      map.set(r.id, {
        ingestedBytes: Number(r.ingested_bytes),
        lastChunkHash: r.last_chunk_hash,
      });
    }
    return map;
  }

  /**
   * Ensure machine record exists, creating if needed
   */
  private async ensureMachine(
    machineId: string,
    hostname: string | null,
    isLocalhost: boolean
  ): Promise<MachineRecord> {
    // The local machine is identified by its is_localhost flag, never by its
    // label. machine_id is a display name the operator can change
    // (SESSIONS_MACHINE_ID) — matching on it would fork a second machine and
    // strand every session already attributed to the old label, splitting one
    // machine's history in two. Remote machines have no such flag and are
    // still matched by the id their ingest call supplies.
    if (isLocalhost) {
      const local = await this.sql<MachineRecord[]>`
        SELECT * FROM sessions.machines WHERE is_localhost = TRUE ORDER BY id LIMIT 1
      `;
      const row = local[0];
      if (row) {
        if (row.machine_id === machineId && row.hostname === hostname) return row;
        const renamed = await this.sql<MachineRecord[]>`
          UPDATE sessions.machines
          SET machine_id = ${machineId}, hostname = ${hostname}
          WHERE id = ${row.id}
          RETURNING *
        `;
        this.log.info(
          { from: row.machine_id, to: machineId, hostname },
          'Relabelled local machine — existing sessions follow it'
        );
        return renamed[0]!;
      }
    }

    const existing = await this.sql<MachineRecord[]>`
      SELECT * FROM sessions.machines WHERE machine_id = ${machineId}
    `;

    if (existing.length > 0) {
      return existing[0]!;
    }

    const inserted = await this.sql<MachineRecord[]>`
      INSERT INTO sessions.machines (machine_id, hostname, is_localhost)
      VALUES (${machineId}, ${hostname}, ${isLocalhost})
      RETURNING *
    `;

    this.log.info({ machineId, isLocalhost }, 'Registered new machine');
    return inserted[0]!;
  }

  /**
   * Nightly full verification (specs/behaviors/session-transcript-storage.md:
   * "Continuity check" — the full-verification companion to the per-cycle
   * tail-only check). Walks every locally-ingested session active in the
   * last day and compares each stored chunk's hash against the same byte
   * range on disk, streaming — never more than one chunk's bytes in memory
   * at a time. A mismatch triggers the same full re-ingest a per-cycle
   * continuity failure does.
   *
   * Scoped to `is_localhost` machines only: a satellite-pushed session's
   * transcript lives on a different host's filesystem, which this process
   * has no access to verify against.
   */
  async verifyRecentSessions(activeWithin = '1 day'): Promise<{ checked: number; mismatches: number }> {
    const rows = await this.sql<{ id: string; transcript_path: string | null }[]>`
      SELECT s.id, s.transcript_path
      FROM sessions.sessions s
      JOIN sessions.machines m ON s.machine_id = m.id
      WHERE m.is_localhost = TRUE
        AND s.transcript_path IS NOT NULL
        AND s.synced_at > NOW() - ${activeWithin}::interval
    `;

    let checked = 0;
    let mismatches = 0;

    for (const row of rows) {
      checked++;
      try {
        const ok = await this.verifySessionChunks(row.id, row.transcript_path!);
        if (!ok) {
          mismatches++;
          this.log.warn({ sessionId: row.id }, 'Nightly verification found a chunk mismatch; re-ingesting from zero');
          await this.reingestFromZero(row.id, row.transcript_path!);
        }
      } catch (error) {
        this.log.error({ error, sessionId: row.id }, 'Nightly transcript verification failed');
      }
    }

    return { checked, mismatches };
  }

  /** Compare every chunk's stored hash against the same byte range on disk. */
  private async verifySessionChunks(sessionId: string, transcriptPath: string): Promise<boolean> {
    const chunks = await this.sql<
      { byte_start: string | number; byte_end: string | number; content_hash: string }[]
    >`
      SELECT byte_start, byte_end, content_hash FROM sessions.transcript_chunks
      WHERE session_id = ${sessionId}::uuid
      ORDER BY seq ASC
    `;
    for (const c of chunks) {
      const start = Number(c.byte_start);
      const end = Number(c.byte_end);
      const buf = await readByteRange(transcriptPath, start, end);
      if (buf.length !== end - start) return false;
      if (hashChunkContent(buf.toString('utf8')) !== c.content_hash) return false;
    }
    return true;
  }

  /** Full re-ingest from byte zero (the same path a per-cycle continuity
   * failure takes), used by nightly verification on a hash mismatch. */
  private async reingestFromZero(sessionId: string, transcriptPath: string): Promise<void> {
    const [row] = await this.sql<{ machine_id: number }[]>`
      SELECT machine_id FROM sessions.sessions WHERE id = ${sessionId}::uuid
    `;
    if (!row) return;
    const { content } = await readBoundedTail(transcriptPath, 0, this.ingestBudgetBytes);
    await this.runCycle({
      sessionId,
      machineId: row.machine_id,
      transcriptPath,
      signal: undefined,
      isNewSession: false,
      priorState: null,
      fresh: true,
      newContent: content,
      baseByteOffset: 0,
    });
  }

  /**
   * Update machine's last sync timestamp and session count
   */
  private async updateMachineSync(machineId: number): Promise<void> {
    await this.sql`
      UPDATE sessions.machines SET
        last_sync_at = NOW(),
        session_count = (
          SELECT COUNT(*) FROM sessions.sessions WHERE machine_id = ${machineId}
        )
      WHERE id = ${machineId}
    `;
  }
}
