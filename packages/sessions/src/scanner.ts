import { readdir, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type {
  SessionSignal,
  DiscoveredSession,
  SessionInventoryItem,
} from './types.js';
import {
  DEFAULT_SESSION_IGNORE_MARKERS,
  matchesIgnoreMarker,
} from './ignore.js';
import { parseTranscript } from './parser.js';

export interface ScannerConfig {
  claudeDir?: string;
  /** Original claude dir path to translate from (for Docker path mapping) */
  originalClaudeDir?: string;
  /** Minimum transcript file size in bytes (default 500) */
  minFileSize?: number;
  /**
   * Maximum transcript file size in bytes (default 128 MiB). Larger files are
   * skipped without being read: ingest holds a transcript, its parse and its
   * row in memory at once, so one runaway session can exhaust the host.
   */
  maxFileSize?: number;
  /**
   * Transcript content substrings that mark a session for suppression.
   * Defaults to DEFAULT_SESSION_IGNORE_MARKERS (e.g. M87 triage runner).
   */
  ignoreContentMarkers?: readonly string[];
}

export const DEFAULT_MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;

export interface OversizedTranscript {
  sessionId: string;
  transcriptPath: string;
  bytes: number;
}

/**
 * Scanner for discovering Claude Code sessions from the local filesystem
 */
export class SessionScanner {
  /** Transcripts skipped for exceeding maxFileSize on the most recent scan */
  oversized: OversizedTranscript[] = [];

  private claudeDir: string;
  private signalsDir: string;
  private projectsDir: string;
  private originalClaudeDir: string | null;
  private minFileSize: number;
  private maxFileSize: number;
  private ignoreContentMarkers: readonly string[];

  constructor(config: ScannerConfig = {}) {
    this.claudeDir = config.claudeDir ?? join(homedir(), '.claude');
    this.signalsDir = join(this.claudeDir, 'session-signals');
    this.projectsDir = join(this.claudeDir, 'projects');
    this.originalClaudeDir = config.originalClaudeDir ?? null;
    this.minFileSize = config.minFileSize ?? 500;
    this.maxFileSize = config.maxFileSize ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
    this.ignoreContentMarkers =
      config.ignoreContentMarkers ?? DEFAULT_SESSION_IGNORE_MARKERS;
  }

  /**
   * Decide whether a transcript should be suppressed from ingest.
   * Matches ignore markers against parsed user messages (the automation's
   * initiating prompt), not raw transcript text — so legitimate sessions that
   * merely quote a marker in tool output or assistant prose are not dropped.
   */
  /**
   * MD5 a transcript without holding it in memory.
   *
   * Streamed rather than readFile()'d because this runs over every transcript
   * on disk on each sync, and a long-lived session can reach hundreds of MB -
   * enough that materializing one as a string spikes the heap on its own.
   *
   * Hashing the bytes matches what .update(string) produced for the UTF-8
   * content this reads, so stored transcript_hash values stay comparable and
   * a sync does not see every session as changed.
   */
  private async hashTranscriptFile(transcriptPath: string): Promise<string> {
    const hash = createHash('md5');
    await pipeline(createReadStream(transcriptPath), hash);
    return hash.digest('hex');
  }

  private isIgnoredTranscript(
    sessionId: string,
    transcriptContent: string
  ): boolean {
    if (this.ignoreContentMarkers.length === 0) {
      return false;
    }
    const { userMessages } = parseTranscript(sessionId, transcriptContent);
    return matchesIgnoreMarker(userMessages, this.ignoreContentMarkers);
  }

  /**
   * Record and reject a transcript too large to ingest safely.
   */
  private isOversized(sessionId: string, transcriptPath: string, bytes: number): boolean {
    if (bytes <= this.maxFileSize) {
      return false;
    }
    this.oversized.push({ sessionId, transcriptPath, bytes });
    return true;
  }

  /**
   * Translate a path from the original location to the current claudeDir
   * This handles Docker path mapping (e.g., /Users/<user>/.claude -> /root/.claude)
   */
  private translatePath(originalPath: string): string {
    if (!this.originalClaudeDir) {
      return originalPath;
    }
    if (originalPath.startsWith(this.originalClaudeDir)) {
      return originalPath.replace(this.originalClaudeDir, this.claudeDir);
    }
    return originalPath;
  }

  /**
   * Discover all ended sessions that haven't been synced (or have changed)
   * Uses session-signals/*.ended.json as the source of truth
   */
  async discoverSessions(
    knownHashes: Set<string>
  ): Promise<DiscoveredSession[]> {
    this.oversized = [];
    const discovered: DiscoveredSession[] = [];

    let signalFiles: string[];
    try {
      signalFiles = await readdir(this.signalsDir);
    } catch {
      // No session-signals directory means no sessions
      return discovered;
    }

    const endedFiles = signalFiles.filter((f) => f.endsWith('.ended.json'));

    for (const file of endedFiles) {
      try {
        const session = await this.processSignalFile(file, knownHashes);
        if (session) {
          discovered.push(session);
        }
      } catch {
        // Skip files that can't be processed
        continue;
      }
    }

    return discovered;
  }

  /**
   * Process a single signal file and return discovered session if new/changed
   */
  private async processSignalFile(
    filename: string,
    knownHashes: Set<string>
  ): Promise<DiscoveredSession | null> {
    const signalPath = join(this.signalsDir, filename);
    const signalContent = await readFile(signalPath, 'utf-8');
    const signal: SessionSignal = JSON.parse(signalContent);

    // Check if transcript exists (translate path for Docker environments)
    const transcriptPath = this.translatePath(signal.transcript_path);
    const transcriptStat = await stat(transcriptPath).catch(() => null);

    if (!transcriptStat) {
      return null;
    }
    if (this.isOversized(signal.session_id, transcriptPath, transcriptStat.size)) {
      return null;
    }

    // Read transcript content
    const transcriptContent = await readFile(transcriptPath, 'utf-8');

    // Compute MD5 hash for change detection (Kuato pattern)
    const transcriptHash = createHash('md5')
      .update(transcriptContent)
      .digest('hex');

    // Skip if we already have this exact content — before the ignore check,
    // which parses the whole transcript
    if (knownHashes.has(transcriptHash)) {
      return null;
    }

    // Skip suppressed sessions (e.g. automated triage runners)
    if (this.isIgnoredTranscript(signal.session_id, transcriptContent)) {
      return null;
    }

    return {
      signal,
      sessionId: signal.session_id,
      transcriptPath,
      transcriptContent,
      transcriptHash,
    };
  }

  /**
   * Discover ALL sessions by scanning the projects directory
   * This finds sessions regardless of whether they have a .ended.json signal
   * Skips subagent sessions (files in /subagents/ directories)
   */
  async discoverAllSessions(
    knownHashes: Set<string>
  ): Promise<DiscoveredSession[]> {
    this.oversized = [];
    const discovered: DiscoveredSession[] = [];

    // First, build a map of session IDs to their signal files (if any)
    const signalMap = await this.loadSignalMap();

    // Scan projects directory for all .jsonl files
    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.projectsDir);
    } catch {
      // No projects directory means no sessions
      return discovered;
    }

    for (const projectDir of projectDirs) {
      const projectPath = join(this.projectsDir, projectDir);
      const projectStat = await stat(projectPath).catch(() => null);

      if (!projectStat?.isDirectory()) {
        continue;
      }

      // Read files in project directory (depth 2, skips subagents)
      let files: string[];
      try {
        files = await readdir(projectPath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) {
          continue;
        }

        const transcriptPath = join(projectPath, file);
        const session = await this.processTranscriptFile(
          transcriptPath,
          signalMap,
          knownHashes
        );

        if (session) {
          discovered.push(session);
        }
      }
    }

    return discovered;
  }

  /**
   * Load all signal files into a map keyed by session_id
   */
  private async loadSignalMap(): Promise<Map<string, SessionSignal>> {
    const signalMap = new Map<string, SessionSignal>();

    let signalFiles: string[];
    try {
      signalFiles = await readdir(this.signalsDir);
    } catch {
      return signalMap;
    }

    for (const file of signalFiles) {
      // Process all signal types (.ended.json, .stop.json, .working.json)
      if (!file.endsWith('.json')) {
        continue;
      }

      try {
        const signalPath = join(this.signalsDir, file);
        const signalContent = await readFile(signalPath, 'utf-8');
        const signal = JSON.parse(signalContent) as SessionSignal;

        // Prefer .ended.json signals, but keep others as fallback
        const existing = signalMap.get(signal.session_id);
        if (!existing || file.endsWith('.ended.json')) {
          signalMap.set(signal.session_id, signal);
        }
      } catch {
        // Skip malformed signal files
        continue;
      }
    }

    return signalMap;
  }

  /**
   * Check if a string is a valid UUID v4 format
   */
  private isValidUuid(str: string): boolean {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }

  /**
   * Process a transcript file directly (without requiring a signal file)
   */
  private async processTranscriptFile(
    transcriptPath: string,
    signalMap: Map<string, SessionSignal>,
    knownHashes: Set<string>
  ): Promise<DiscoveredSession | null> {
    // Extract session ID from filename (e.g., "abc123-def4-...jsonl" -> "abc123-def4-...")
    const filename = transcriptPath.split('/').pop() ?? '';
    const sessionId = filename.replace('.jsonl', '');

    // Skip subagent files (they have names like "agent-a078a45", not UUIDs)
    if (!this.isValidUuid(sessionId)) {
      return null;
    }

    // Check file size
    const transcriptStat = await stat(transcriptPath).catch(() => null);
    if (!transcriptStat || transcriptStat.size < this.minFileSize) {
      return null;
    }
    if (this.isOversized(sessionId, transcriptPath, transcriptStat.size)) {
      return null;
    }

    // Read transcript content
    const transcriptContent = await readFile(transcriptPath, 'utf-8');

    // Compute MD5 hash for change detection
    const transcriptHash = createHash('md5')
      .update(transcriptContent)
      .digest('hex');

    // Skip if we already have this exact content — before the ignore check,
    // which parses the whole transcript
    if (knownHashes.has(transcriptHash)) {
      return null;
    }

    // Skip suppressed sessions (e.g. automated triage runners)
    if (this.isIgnoredTranscript(sessionId, transcriptContent)) {
      return null;
    }

    // Look up signal if available
    const signal = signalMap.get(sessionId);

    return {
      signal,
      sessionId,
      transcriptPath,
      transcriptContent,
      transcriptHash,
    };
  }

  /**
   * Get lightweight inventory of all sessions (computes hash without keeping transcript in memory)
   * Returns session ID, hash, path, and optional signal - but NOT transcript content
   */
  async getSessionInventory(): Promise<SessionInventoryItem[]> {
    this.oversized = [];
    const inventory: SessionInventoryItem[] = [];
    const signalMap = await this.loadSignalMap();

    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.projectsDir);
    } catch {
      return inventory;
    }

    for (const projectDir of projectDirs) {
      const projectPath = join(this.projectsDir, projectDir);
      const projectStat = await stat(projectPath).catch(() => null);

      if (!projectStat?.isDirectory()) {
        continue;
      }

      let files: string[];
      try {
        files = await readdir(projectPath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) {
          continue;
        }

        const transcriptPath = join(projectPath, file);
        const sessionId = file.replace('.jsonl', '');

        // Skip non-UUID filenames (subagent files)
        if (!this.isValidUuid(sessionId)) {
          continue;
        }

        // Check file size
        const transcriptStat = await stat(transcriptPath).catch(() => null);
        if (!transcriptStat || transcriptStat.size < this.minFileSize) {
          continue;
        }
        if (this.isOversized(sessionId, transcriptPath, transcriptStat.size)) {
          continue;
        }

        // Skip suppressed sessions (e.g. automated triage runners). This is
        // the one check here that needs the transcript body, so it only reads
        // the file when markers are actually configured - otherwise the
        // inventory pass never materializes a transcript at all.
        if (this.ignoreContentMarkers.length > 0) {
          const transcriptContent = await readFile(transcriptPath, 'utf-8');
          if (this.isIgnoredTranscript(sessionId, transcriptContent)) {
            continue;
          }
        }

        const transcriptHash = await this.hashTranscriptFile(transcriptPath);

        inventory.push({
          sessionId,
          transcriptHash,
          transcriptPath,
          signal: signalMap.get(sessionId),
        });
      }
    }

    return inventory;
  }

  /**
   * Load specific sessions by ID (for selective push after inventory check)
   */
  async getSessionsByIds(sessionIds: Set<string>): Promise<DiscoveredSession[]> {
    this.oversized = [];
    const sessions: DiscoveredSession[] = [];
    const signalMap = await this.loadSignalMap();

    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.projectsDir);
    } catch {
      return sessions;
    }

    for (const projectDir of projectDirs) {
      const projectPath = join(this.projectsDir, projectDir);
      const projectStat = await stat(projectPath).catch(() => null);

      if (!projectStat?.isDirectory()) {
        continue;
      }

      let files: string[];
      try {
        files = await readdir(projectPath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) {
          continue;
        }

        const sessionId = file.replace('.jsonl', '');

        // Only load sessions in the requested set
        if (!sessionIds.has(sessionId)) {
          continue;
        }

        const transcriptPath = join(projectPath, file);
        const transcriptStat = await stat(transcriptPath).catch(() => null);
        if (!transcriptStat) {
          continue;
        }
        if (this.isOversized(sessionId, transcriptPath, transcriptStat.size)) {
          continue;
        }
        const transcriptContent = await readFile(transcriptPath, 'utf-8');

        // Skip suppressed sessions (e.g. automated triage runners)
        if (this.isIgnoredTranscript(sessionId, transcriptContent)) {
          continue;
        }

        const transcriptHash = createHash('md5')
          .update(transcriptContent)
          .digest('hex');

        sessions.push({
          sessionId,
          transcriptPath,
          transcriptContent,
          transcriptHash,
          signal: signalMap.get(sessionId),
        });
      }
    }

    return sessions;
  }
}
