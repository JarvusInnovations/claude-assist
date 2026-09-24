import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SessionSignal, SessionInventoryItem, SessionPushData, InventoryBaseline } from './types.js';
import {
  DEFAULT_SESSION_IGNORE_MARKERS,
  matchesIgnoreMarker,
} from './ignore.js';
import { parseTranscript } from './parser.js';
import { readBoundedTail, DEFAULT_INGEST_BUDGET_BYTES } from './chunked-ingest.js';

export interface ScannerConfig {
  claudeDir?: string;
  /**
   * Original claude dir path to translate from (for Docker path mapping).
   * Kept for config-surface compatibility (`SESSIONS_ORIGINAL_CLAUDE_DIR`);
   * `listLocalTranscripts` walks `claudeDir` directly and never needs to
   * translate a path, so this has no effect on the chunked-ingest scan path.
   */
  originalClaudeDir?: string;
  /** Minimum transcript file size in bytes (default 500) */
  minFileSize?: number;
  /**
   * Transcript content substrings that mark a session for suppression.
   * Defaults to DEFAULT_SESSION_IGNORE_MARKERS (e.g. M87 triage runner).
   */
  ignoreContentMarkers?: readonly string[];
}

/** A locally discovered transcript file, stat-only — no content read, no hash.
 * specs/behaviors/session-transcript-storage.md: "Unchanged sessions cost a
 * stat." What to do about it (unchanged / append / catch-up / re-ingest) is
 * decided by `SyncService` against the session's DB chunk state, not here. */
export interface LocalTranscriptFile {
  sessionId: string;
  transcriptPath: string;
  size: number;
  signal?: SessionSignal;
}

/**
 * Scanner for discovering Claude Code sessions from the local filesystem.
 * Content is never read here except where explicitly noted (the ignore-marker
 * check and legacy whole-session push loaders) — chunked ingest reads only
 * the bytes it needs, and that read lives in `SyncService`/`chunked-ingest.ts`.
 */
export class SessionScanner {
  private claudeDir: string;
  private signalsDir: string;
  private projectsDir: string;
  /** Retained for config-surface compatibility only — see ScannerConfig.originalClaudeDir. */
  private originalClaudeDir: string | null;
  private minFileSize: number;
  private ignoreContentMarkers: readonly string[];

  constructor(config: ScannerConfig = {}) {
    this.claudeDir = config.claudeDir ?? join(homedir(), '.claude');
    this.signalsDir = join(this.claudeDir, 'session-signals');
    this.projectsDir = join(this.claudeDir, 'projects');
    this.originalClaudeDir = config.originalClaudeDir ?? null;
    this.minFileSize = config.minFileSize ?? 500;
    this.ignoreContentMarkers =
      config.ignoreContentMarkers ?? DEFAULT_SESSION_IGNORE_MARKERS;
  }

  /**
   * Decide whether a transcript should be suppressed from ingest, matching
   * ignore markers against parsed user messages (the automation's initiating
   * prompt), not raw transcript text — see ignore.ts.
   */
  isIgnoredTranscript(sessionId: string, transcriptContent: string): boolean {
    if (this.ignoreContentMarkers.length === 0) {
      return false;
    }
    const { userMessages } = parseTranscript(sessionId, transcriptContent);
    return matchesIgnoreMarker(userMessages, this.ignoreContentMarkers);
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
   * Enumerate every `.jsonl` transcript under the projects directory
   * (skipping subagent files, which aren't UUID-named) with just a `stat` —
   * the chunked-ingest change-detection signal. Yields rather than
   * collecting: a scan over thousands of sessions costs thousands of
   * `stat`s either way, but nothing here ever holds transcript content.
   */
  async *listLocalTranscripts(): AsyncGenerator<LocalTranscriptFile> {
    const signalMap = await this.loadSignalMap();

    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.projectsDir);
    } catch {
      return;
    }

    for (const projectDir of projectDirs) {
      const projectPath = join(this.projectsDir, projectDir);
      const projectStat = await stat(projectPath).catch(() => null);
      if (!projectStat?.isDirectory()) continue;

      let files: string[];
      try {
        files = await readdir(projectPath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.replace('.jsonl', '');
        if (!this.isValidUuid(sessionId)) continue;

        const transcriptPath = join(projectPath, file);
        const transcriptStat = await stat(transcriptPath).catch(() => null);
        if (!transcriptStat || transcriptStat.size < this.minFileSize) continue;

        yield {
          sessionId,
          transcriptPath,
          size: transcriptStat.size,
          signal: signalMap.get(sessionId),
        };
      }
    }
  }

  /**
   * Lightweight inventory for two-phase push: session id, on-disk size, path,
   * and signal — no content read, no hash (specs/behaviors/
   * session-transcript-storage.md: "Change detection uses size and the
   * last-chunk hash, not a whole-file MD5"). The one exception: when ignore
   * markers are configured, a session's content still has to be read once to
   * evaluate them (matching pre-chunking behavior) — otherwise this never
   * materializes a transcript.
   */
  async getSessionInventory(): Promise<SessionInventoryItem[]> {
    const inventory: SessionInventoryItem[] = [];
    for await (const file of this.listLocalTranscripts()) {
      if (this.ignoreContentMarkers.length > 0) {
        const content = await readFile(file.transcriptPath, 'utf-8').catch(() => null);
        if (content !== null && this.isIgnoredTranscript(file.sessionId, content)) continue;
      }
      inventory.push({
        sessionId: file.sessionId,
        transcriptPath: file.transcriptPath,
        size: file.size,
        signal: file.signal,
      });
    }
    return inventory;
  }

  /**
   * Load the tail each needed session should push, per the server's
   * inventory-response baselines. A session absent from `baselines` (new to
   * the server) sends from byte zero, capped at `maxBytesPerSession` — the
   * same per-cycle budget local ingest applies, so a satellite's first push
   * of a huge session doesn't try to send it whole in one request; the rest
   * follows over subsequent push cycles as `baselines` advances.
   */
  async getSessionsByIds(
    sessionIds: Set<string>,
    baselines: Record<string, InventoryBaseline> = {},
    maxBytesPerSession: number = DEFAULT_INGEST_BUDGET_BYTES
  ): Promise<SessionPushData[]> {
    const sessions: SessionPushData[] = [];
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
      if (!projectStat?.isDirectory()) continue;

      let files: string[];
      try {
        files = await readdir(projectPath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.replace('.jsonl', '');
        if (!sessionIds.has(sessionId)) continue;

        const transcriptPath = join(projectPath, file);
        const sinceBytes = baselines[sessionId]?.ingestedBytes ?? 0;
        const { content } = await readBoundedTail(transcriptPath, sinceBytes, maxBytesPerSession).catch(
          () => ({ content: '', consumedBytes: 0, fileSize: 0 })
        );
        if (content.length === 0 && sinceBytes > 0) continue; // nothing new to send

        sessions.push({
          sessionId,
          transcriptPath,
          transcript: content,
          sinceBytes,
          signal: signalMap.get(sessionId),
        });
      }
    }

    return sessions;
  }
}
