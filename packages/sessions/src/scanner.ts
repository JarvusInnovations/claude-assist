import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { SessionSignal, DiscoveredSession } from './types.js';

export interface ScannerConfig {
  claudeDir?: string;
}

/**
 * Scanner for discovering Claude Code sessions from the local filesystem
 */
export class SessionScanner {
  private claudeDir: string;
  private signalsDir: string;

  constructor(config: ScannerConfig = {}) {
    this.claudeDir = config.claudeDir ?? join(homedir(), '.claude');
    this.signalsDir = join(this.claudeDir, 'session-signals');
  }

  /**
   * Discover all ended sessions that haven't been synced (or have changed)
   * Uses session-signals/*.ended.json as the source of truth
   */
  async discoverSessions(
    knownHashes: Set<string>
  ): Promise<DiscoveredSession[]> {
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

    // Check if transcript exists
    const transcriptPath = signal.transcript_path;
    const transcriptStat = await stat(transcriptPath).catch(() => null);

    if (!transcriptStat) {
      return null;
    }

    // Read transcript content
    const transcriptContent = await readFile(transcriptPath, 'utf-8');

    // Compute MD5 hash for change detection (Kuato pattern)
    const transcriptHash = createHash('md5')
      .update(transcriptContent)
      .digest('hex');

    // Skip if we already have this exact content
    if (knownHashes.has(transcriptHash)) {
      return null;
    }

    return {
      signal,
      transcriptPath,
      transcriptContent,
      transcriptHash,
    };
  }

  /**
   * Get all sessions for CLI push (doesn't filter by known hashes)
   */
  async getAllSessions(): Promise<DiscoveredSession[]> {
    return this.discoverSessions(new Set());
  }
}
