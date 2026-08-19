import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import { hostname as getHostname } from 'node:os';
import { createHash } from 'node:crypto';
import { SessionScanner, type ScannerConfig } from './scanner.js';
import { parseTranscript } from './parser.js';
import { sanitizeText } from './sanitize.js';
import {
  DEFAULT_SESSION_IGNORE_MARKERS,
  matchesIgnoreMarker,
} from './ignore.js';
import type {
  SyncResult,
  MachineRecord,
  PushPayload,
  SessionSignal,
  DiscoveredSession,
  InventoryPayload,
  InventoryResponse,
  ToolCall,
} from './types.js';

export interface SyncServiceConfig extends ScannerConfig {
  machineId?: string;
  /** Disable local filesystem scanning */
  disableLocalIngest?: boolean;
}

/**
 * Service for syncing Claude Code sessions to the database
 */
export class SyncService {
  private sql: postgres.Sql;
  private log: FastifyBaseLogger;
  private scanner: SessionScanner;
  private machineId: string;
  private hostname: string;
  private disableLocalIngest: boolean;
  private ignoreContentMarkers: readonly string[];

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
  }

  /**
   * Run a full sync for localhost
   * @param forceReparse - If true, re-parse all sessions even if hash matches (for parser upgrades)
   */
  async syncLocal(forceReparse = false): Promise<SyncResult> {
    // Check if local ingest is disabled
    if (this.disableLocalIngest) {
      this.log.info('Local session ingest disabled via disableLocalIngest config');
      return {
        sessionsScanned: 0,
        sessionsIngested: 0,
        sessionsUpdated: 0,
        sessionsSkipped: 0,
        errors: [],
      };
    }

    const result: SyncResult = {
      sessionsScanned: 0,
      sessionsIngested: 0,
      sessionsUpdated: 0,
      sessionsSkipped: 0,
      errors: [],
    };

    try {
      // Ensure machine record exists
      const machine = await this.ensureMachine(
        this.machineId,
        this.hostname,
        true
      );

      // Get known content hashes for this machine (empty set if forcing reparse)
      const knownHashes = forceReparse
        ? new Set<string>()
        : await this.getKnownHashes(machine.id);

      // Discover new/changed sessions (scans projects directory for all sessions)
      const discovered = await this.scanner.discoverAllSessions(knownHashes);
      result.sessionsScanned = discovered.length;

      // Process each discovered session
      for (const session of discovered) {
        try {
          const isNew = await this.ingestSession(machine.id, session);
          if (isNew) {
            result.sessionsIngested++;
          } else {
            result.sessionsUpdated++;
          }
        } catch (error) {
          const message = `Failed to ingest ${session.sessionId}: ${error}`;
          result.errors.push(message);
          this.log.error({ error, sessionId: session.sessionId }, message);
        }
      }

      // Update machine sync timestamp
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

  /**
   * Process a push from a satellite machine
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
      const machine = await this.ensureMachine(
        payload.machineId,
        payload.hostname ?? null,
        false
      );

      // Get known hashes to detect duplicates (empty set if forcing reparse)
      const knownHashes = forceReparse
        ? new Set<string>()
        : await this.getKnownHashes(machine.id);

      for (const sessionData of payload.sessions) {
        try {
          // Skip suppressed sessions (e.g. automated triage runners).
          // Server-side net for satellites running an older push CLI that
          // doesn't yet filter these out before sending. Match against parsed
          // user messages (the automation's prompt), not raw transcript text.
          if (this.ignoreContentMarkers.length > 0) {
            const { userMessages } = parseTranscript(
              sessionData.sessionId,
              sessionData.transcript
            );
            if (matchesIgnoreMarker(userMessages, this.ignoreContentMarkers)) {
              result.sessionsSkipped++;
              continue;
            }
          }

          // Compute hash for change detection
          const transcriptHash = createHash('md5')
            .update(sessionData.transcript)
            .digest('hex');

          // Skip if already have this exact content (unless force reparse)
          if (knownHashes.has(transcriptHash)) {
            result.sessionsSkipped++;
            continue;
          }

          const discovered: DiscoveredSession = {
            signal: sessionData.signal,
            sessionId: sessionData.sessionId,
            transcriptPath: sessionData.transcriptPath,
            transcriptContent: sessionData.transcript,
            transcriptHash,
          };

          const isNew = await this.ingestSession(machine.id, discovered);
          if (isNew) {
            result.sessionsIngested++;
          } else {
            result.sessionsUpdated++;
          }
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
   * Process inventory from a satellite machine and return needed session IDs
   * This is Phase 1 of the two-phase sync protocol
   */
  async processInventory(payload: InventoryPayload): Promise<InventoryResponse> {
    const machine = await this.ensureMachine(
      payload.machineId,
      payload.hostname ?? null,
      false
    );

    const forceReparse = payload.forceReparse ?? false;

    // If forcing reparse, return all session IDs as needed
    if (forceReparse) {
      this.log.info(
        {
          machineId: payload.machineId,
          total: payload.inventory.length,
        },
        `Inventory processed with force reparse: all ${payload.inventory.length} sessions needed`
      );

      return {
        neededSessionIds: payload.inventory.map((item) => item.sessionId),
        upToDateCount: 0,
      };
    }

    const knownHashes = await this.getKnownHashes(machine.id);

    const neededSessionIds: string[] = [];
    let upToDateCount = 0;

    for (const item of payload.inventory) {
      if (knownHashes.has(item.transcriptHash)) {
        upToDateCount++;
      } else {
        neededSessionIds.push(item.sessionId);
      }
    }

    this.log.info(
      {
        machineId: payload.machineId,
        total: payload.inventory.length,
        needed: neededSessionIds.length,
        upToDate: upToDateCount,
      },
      `Inventory processed: ${neededSessionIds.length} sessions needed, ${upToDateCount} up-to-date`
    );

    return {
      neededSessionIds,
      upToDateCount,
    };
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
   * Get all known content hashes for a machine
   */
  private async getKnownHashes(machineId: number): Promise<Set<string>> {
    const rows = await this.sql<{ transcript_hash: string }[]>`
      SELECT transcript_hash FROM sessions.sessions WHERE machine_id = ${machineId}
    `;
    return new Set(rows.map((r) => r.transcript_hash));
  }

  /**
   * Ingest a discovered session into the database
   * Handles sessions with or without signal files
   */
  private async ingestSession(
    machineId: number,
    discovered: DiscoveredSession
  ): Promise<boolean> {
    const { signal, sessionId, transcriptContent: rawTranscriptContent, transcriptHash, transcriptPath } = discovered;

    // Parse transcript to extract structured data
    const parsed = parseTranscript(sessionId, rawTranscriptContent);

    // raw_transcript is TEXT NOT NULL - Postgres rejects an embedded NUL byte
    // there too (a different error path than the jsonb columns parseTranscript
    // already sanitizes, but the same underlying constraint). No real-world
    // transcript has needed this yet - the two failing sessions carried their
    // NUL only as a \u0000 escape inside a JSON string, which parseTranscript
    // handles - but it's a cheap, defensive pass over content we don't control.
    const transcriptContent = sanitizeText(rawTranscriptContent);

    // Compute ended_at: prefer signal, then parsed data
    const endedAt = signal?.ended_at
      ? new Date(parseFloat(signal.ended_at) * 1000)
      : parsed.endedAt;

    // Compute started_at: prefer parsed value, fall back to ended_at for historical sessions
    // Per lessons learned: derive missing started_at from ended_at, not new Date()
    let startedAt = parsed.startedAt ?? endedAt;
    if (!startedAt) {
      this.log.warn(
        { sessionId },
        'Session has no valid timestamp - using current time as fallback'
      );
      startedAt = new Date();
    }

    // Get project path: prefer signal cwd, fall back to parsed cwd from transcript
    const projectPath = signal?.cwd ?? parsed.cwd;

    // Build search text from user messages (Kuato pattern)
    const searchText = parsed.userMessages.join(' ');

    // Check if session already exists
    const existing = await this.sql<{ id: string }[]>`
      SELECT id FROM sessions.sessions
      WHERE id = ${sessionId}::uuid AND machine_id = ${machineId}
    `;

    if (existing.length > 0) {
      // Update existing session
      await this.sql`
        UPDATE sessions.sessions SET
          project_path = ${projectPath},
          git_branch = ${parsed.gitBranch},
          started_at = ${startedAt},
          ended_at = ${endedAt},
          user_messages = ${this.sql.json(parsed.userMessages)},
          tools_used = ${this.sql.json(parsed.toolsUsed)},
          files_touched = ${this.sql.json(parsed.filesTouched as any)},
          input_tokens = ${parsed.inputTokens},
          output_tokens = ${parsed.outputTokens},
          cache_read_tokens = ${parsed.cacheReadTokens},
          transcript_path = ${transcriptPath},
          transcript_hash = ${transcriptHash},
          raw_transcript = ${transcriptContent},
          search_text = ${searchText},
          message_count = ${parsed.messageCount},
          user_message_count = ${parsed.userMessages.length},
          claude_version = ${parsed.claudeVersion},
          models_used = ${this.sql.json(parsed.modelsUsed)},
          model_tokens = ${this.sql.json(parsed.modelTokens as any)},
          activity_ranges = ${this.sql.json(parsed.activityRanges as any)},
          session_name = ${parsed.sessionName},
          context_final_tokens = ${parsed.contextFinalTokens},
          context_peak_tokens = ${parsed.contextPeakTokens},
          context_limit_tokens = ${parsed.contextLimitTokens},
          context_model = ${parsed.contextModel},
          synced_at = NOW()
        WHERE id = ${sessionId}::uuid AND machine_id = ${machineId}
      `;
      await this.writeToolCalls(sessionId, parsed.toolCalls);
      return false;
    }

    // Insert new session
    await this.sql`
      INSERT INTO sessions.sessions (
        id, machine_id, project_path, git_branch,
        started_at, ended_at,
        user_messages, tools_used, files_touched,
        input_tokens, output_tokens, cache_read_tokens,
        transcript_path, transcript_hash, raw_transcript,
        search_text, message_count, user_message_count, claude_version,
        models_used, model_tokens, activity_ranges, session_name,
        context_final_tokens, context_peak_tokens, context_limit_tokens, context_model
      ) VALUES (
        ${sessionId}::uuid,
        ${machineId},
        ${projectPath},
        ${parsed.gitBranch},
        ${startedAt},
        ${endedAt},
        ${this.sql.json(parsed.userMessages)},
        ${this.sql.json(parsed.toolsUsed)},
        ${this.sql.json(parsed.filesTouched as any)},
        ${parsed.inputTokens},
        ${parsed.outputTokens},
        ${parsed.cacheReadTokens},
        ${transcriptPath},
        ${transcriptHash},
        ${transcriptContent},
        ${searchText},
        ${parsed.messageCount},
        ${parsed.userMessages.length},
        ${parsed.claudeVersion},
        ${this.sql.json(parsed.modelsUsed)},
        ${this.sql.json(parsed.modelTokens as any)},
        ${this.sql.json(parsed.activityRanges as any)},
        ${parsed.sessionName},
        ${parsed.contextFinalTokens},
        ${parsed.contextPeakTokens},
        ${parsed.contextLimitTokens},
        ${parsed.contextModel}
      )
    `;

    await this.writeToolCalls(sessionId, parsed.toolCalls);
    return true;
  }

  /**
   * Backfill context-window readings for sessions ingested before the columns
   * existed (specs/behaviors/session-context-window.md).
   *
   * Re-parses the stored raw_transcript rather than the file on disk: Claude
   * prunes transcripts after ~a month, so the archive is the only copy for
   * older sessions. Batched because raw_transcript totals multiple GB — a
   * single SELECT would pull the whole corpus into memory.
   */
  async backfillContextWindow(batchSize = 25): Promise<{ scanned: number; measured: number }> {
    let scanned = 0;
    let measured = 0;

    for (;;) {
      const rows = await this.sql<{ id: string; raw_transcript: string }[]>`
        SELECT id, raw_transcript
        FROM sessions.sessions
        WHERE context_final_tokens IS NULL
          AND context_backfilled_at IS NULL
          AND raw_transcript IS NOT NULL
        ORDER BY started_at DESC
        LIMIT ${batchSize}
      `;
      if (rows.length === 0) break;

      for (const row of rows) {
        scanned++;
        let parsed;
        try {
          parsed = parseTranscript(row.id, row.raw_transcript);
        } catch {
          // A transcript we cannot parse stays unmeasured, but gets stamped so
          // the next pass does not retry it forever.
          await this.sql`
            UPDATE sessions.sessions SET context_backfilled_at = NOW()
            WHERE id = ${row.id}::uuid
          `;
          continue;
        }
        if (parsed.contextFinalTokens !== null) measured++;
        await this.sql`
          UPDATE sessions.sessions SET
            context_final_tokens = ${parsed.contextFinalTokens},
            context_peak_tokens = ${parsed.contextPeakTokens},
            context_limit_tokens = ${parsed.contextLimitTokens},
            context_model = ${parsed.contextModel},
            context_backfilled_at = NOW()
          WHERE id = ${row.id}::uuid
        `;
      }
    }

    return { scanned, measured };
  }

  /**
   * Replace the tool_calls index rows for a session (#48). Called on every
   * ingest/update so the index tracks the current transcript; a force re-parse
   * backfills it for sessions ingested before the index existed.
   */
  private async writeToolCalls(sessionId: string, toolCalls: ToolCall[]): Promise<void> {
    await this.sql`DELETE FROM sessions.tool_calls WHERE session_id = ${sessionId}::uuid`;
    if (toolCalls.length === 0) return;
    const rows = toolCalls.map((tc) => ({
      session_id: sessionId,
      msg_uuid: tc.msgUuid,
      msg_index: tc.msgIndex,
      ts: tc.ts,
      tool_name: tc.toolName,
      target: tc.target,
      is_sidechain: tc.isSidechain,
    }));
    await this.sql`
      INSERT INTO sessions.tool_calls ${this.sql(
        rows,
        'session_id',
        'msg_uuid',
        'msg_index',
        'ts',
        'tool_name',
        'target',
        'is_sidechain'
      )}
    `;
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
