import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import { hostname as getHostname } from 'node:os';
import { createHash } from 'node:crypto';
import { SessionScanner, type ScannerConfig } from './scanner.js';
import { parseTranscript } from './parser.js';
import type {
  SyncResult,
  MachineRecord,
  PushPayload,
  SessionSignal,
  DiscoveredSession,
  InventoryPayload,
  InventoryResponse,
} from './types.js';

export interface SyncServiceConfig extends ScannerConfig {
  machineId?: string;
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
  }

  /**
   * Run a full sync for localhost
   */
  async syncLocal(): Promise<SyncResult> {
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

      // Get known content hashes for this machine
      const knownHashes = await this.getKnownHashes(machine.id);

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

    try {
      const machine = await this.ensureMachine(
        payload.machineId,
        payload.hostname ?? null,
        false
      );

      // Get known hashes to detect duplicates
      const knownHashes = await this.getKnownHashes(machine.id);

      for (const sessionData of payload.sessions) {
        try {
          // Compute hash for change detection
          const transcriptHash = createHash('md5')
            .update(sessionData.transcript)
            .digest('hex');

          // Skip if already have this exact content
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
    const { signal, sessionId, transcriptContent, transcriptHash, transcriptPath } = discovered;

    // Parse transcript to extract structured data
    const parsed = parseTranscript(sessionId, transcriptContent);

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
          files_touched = ${this.sql.json(parsed.filesTouched)},
          input_tokens = ${parsed.inputTokens},
          output_tokens = ${parsed.outputTokens},
          cache_read_tokens = ${parsed.cacheReadTokens},
          transcript_path = ${transcriptPath},
          transcript_hash = ${transcriptHash},
          raw_transcript = ${transcriptContent},
          search_text = ${searchText},
          message_count = ${parsed.messageCount},
          claude_version = ${parsed.claudeVersion},
          synced_at = NOW()
        WHERE id = ${sessionId}::uuid AND machine_id = ${machineId}
      `;
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
        search_text, message_count, claude_version
      ) VALUES (
        ${sessionId}::uuid,
        ${machineId},
        ${projectPath},
        ${parsed.gitBranch},
        ${startedAt},
        ${endedAt},
        ${this.sql.json(parsed.userMessages)},
        ${this.sql.json(parsed.toolsUsed)},
        ${this.sql.json(parsed.filesTouched)},
        ${parsed.inputTokens},
        ${parsed.outputTokens},
        ${parsed.cacheReadTokens},
        ${transcriptPath},
        ${transcriptHash},
        ${transcriptContent},
        ${searchText},
        ${parsed.messageCount},
        ${parsed.claudeVersion}
      )
    `;

    return true;
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
