import Anthropic from '@anthropic-ai/sdk';
import pLimit from 'p-limit';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import { serializeTranscript } from './transcript.js';

export interface OutlineServiceConfig {
  concurrency?: number; // Default: 5
  apiKey?: string; // Default: process.env.ANTHROPIC_API_KEY
  model?: string; // Default: 'claude-haiku-4-5'
  maxTokens?: number; // Default: 1024
}

export interface OutlineProgress {
  completed: number;
  total: number;
  currentSession: string | null;
  errors: number;
  isRunning: boolean;
}

export interface OutlineResult {
  sessionsProcessed: number;
  outlinesGenerated: number;
  skipped: number;
  errors: string[];
}

interface SessionForOutline {
  id: string;
  project_path: string | null;
  git_branch: string | null;
  raw_transcript: string;
  transcript_hash: string;
  outline: string | null;
  outline_hash: string | null;
  // postgres.js returns BIGINT as string to avoid JS number precision loss
  output_tokens: string;
}

/**
 * Check if a session has no assistant output (empty session)
 */
function isEmptySession(session: SessionForOutline): boolean {
  return parseInt(session.output_tokens, 10) === 0;
}

/**
 * Service for generating AI outlines of sessions using Claude Haiku
 * Uses p-limit for concurrency control
 */
export class OutlineService {
  private sql: postgres.Sql;
  private log: FastifyBaseLogger;
  private client: Anthropic;
  private limit: ReturnType<typeof pLimit>;
  private model: string;
  private maxTokens: number;
  private progress: OutlineProgress;

  constructor(
    sql: postgres.Sql,
    log: FastifyBaseLogger,
    config: OutlineServiceConfig = {}
  ) {
    this.sql = sql;
    this.log = log;
    this.model = config.model ?? 'claude-haiku-4-5';
    this.maxTokens = config.maxTokens ?? 1024;

    // Initialize Anthropic client
    const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable required');
    }
    this.client = new Anthropic({ apiKey });

    // Initialize concurrency limiter
    this.limit = pLimit(config.concurrency ?? 5);

    // Initialize progress tracking
    this.progress = {
      completed: 0,
      total: 0,
      currentSession: null,
      errors: 0,
      isRunning: false,
    };
  }

  /**
   * Get current progress for status reporting
   */
  getProgress(): OutlineProgress {
    return { ...this.progress };
  }

  /**
   * Build the prompt for outline generation
   */
  private buildPrompt(
    projectPath: string | null,
    gitBranch: string | null,
    serializedTranscript: string
  ): string {
    return `Summarize this Claude Code session.

SESSION:
- Project: ${projectPath ?? 'unknown'}
- Branch: ${gitBranch ?? 'unknown'}

TRANSCRIPT:
${serializedTranscript}

Respond with exactly this format:
<summary>
Task: [1-2 sentence description of what the user wanted to accomplish]

Outcome: [1-2 sentence summary of what was accomplished or the result]

- [key topic or task covered]
- [key topic or task covered]
</summary>`;
  }

  /**
   * Parse the outline response - extract from summary tags if present
   */
  private parseOutlineResponse(response: string): string {
    // Extract content from summary tags if present
    const match = response.match(/<summary>([\s\S]*?)<\/summary>/);
    if (match?.[1]) {
      return match[1].trim();
    }

    // Otherwise return response as-is
    return response.trim();
  }

  /**
   * Generate outline for a single session
   */
  async generateOutline(session: SessionForOutline): Promise<string> {
    const serializedTranscript = serializeTranscript(session.raw_transcript);
    const prompt = this.buildPrompt(
      session.project_path,
      session.git_branch,
      serializedTranscript
    );

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    // Extract text from response
    const textBlock = response.content.find((block) => block.type === 'text');
    const rawOutline = textBlock?.type === 'text' ? textBlock.text : '';

    return this.parseOutlineResponse(rawOutline);
  }

  /**
   * Process sessions that need outline generation (async/non-blocking)
   * Returns immediately, processing happens in background
   */
  async queueOutlineGeneration(sessionIds?: string[]): Promise<void> {
    if (this.progress.isRunning) {
      this.log.info('Outline generation already in progress, skipping');
      return;
    }

    // Mark as running immediately to prevent race conditions
    this.progress.isRunning = true;

    // Find sessions needing outlines
    let sessions: SessionForOutline[];
    try {
      if (sessionIds && sessionIds.length > 0) {
        sessions = await this.sql<SessionForOutline[]>`
          SELECT id, project_path, git_branch, raw_transcript, transcript_hash, outline, outline_hash, output_tokens
          FROM sessions.sessions
          WHERE id = ANY(${sessionIds}::uuid[])
            AND outline_hash IS DISTINCT FROM transcript_hash
        `;
      } else {
        sessions = await this.sql<SessionForOutline[]>`
          SELECT id, project_path, git_branch, raw_transcript, transcript_hash, outline, outline_hash, output_tokens
          FROM sessions.sessions
          WHERE outline_hash IS DISTINCT FROM transcript_hash
          ORDER BY started_at DESC
          LIMIT 100
        `;
      }
    } catch (error) {
      this.progress.isRunning = false;
      this.log.error({ error }, 'Failed to query sessions for outline generation');
      throw error;
    }

    if (sessions.length === 0) {
      this.log.info('No sessions need outline generation');
      this.progress.isRunning = false;
      return;
    }

    // Reset progress
    this.progress = {
      completed: 0,
      total: sessions.length,
      currentSession: null,
      errors: 0,
      isRunning: true,
    };

    this.log.info({ count: sessions.length }, 'Queuing outline generation');

    // Queue all sessions with concurrency limit (non-blocking)
    const promises = sessions.map((session) =>
      this.limit(async () => {
        try {
          this.progress.currentSession = session.id;

          // Skip API call for sessions with no assistant output
          const isEmpty = isEmptySession(session);
          const outline = isEmpty ? null : await this.generateOutline(session);

          // Store the outline (null for empty sessions)
          await this.sql`
            UPDATE sessions.sessions
            SET outline = ${outline},
                outline_hash = ${session.transcript_hash}
            WHERE id = ${session.id}::uuid
          `;

          this.progress.completed++;
          this.log.debug(
            { sessionId: session.id, skipped: isEmpty },
            outline ? 'Generated outline' : 'Skipped empty session'
          );
        } catch (error) {
          this.progress.errors++;
          this.log.error(
            { error, sessionId: session.id },
            'Failed to generate outline'
          );
        }
      })
    );

    // Don't await - let it run in background
    Promise.all(promises)
      .then(() => {
        this.progress.currentSession = null;
        this.progress.isRunning = false;
        this.log.info(
          {
            completed: this.progress.completed,
            errors: this.progress.errors,
          },
          'Outline generation batch complete'
        );
      })
      .catch((error) => {
        this.progress.isRunning = false;
        this.log.error({ error }, 'Outline generation batch failed');
      });
  }

  /**
   * Generate outlines synchronously (blocking, for manual triggers)
   */
  async generateOutlinesSync(sessionIds?: string[]): Promise<OutlineResult> {
    const result: OutlineResult = {
      sessionsProcessed: 0,
      outlinesGenerated: 0,
      skipped: 0,
      errors: [],
    };

    // Find sessions needing outlines (filter by hash mismatch at query level)
    let sessions: SessionForOutline[];
    if (sessionIds && sessionIds.length > 0) {
      sessions = await this.sql<SessionForOutline[]>`
        SELECT id, project_path, git_branch, raw_transcript, transcript_hash, outline, outline_hash, output_tokens
        FROM sessions.sessions
        WHERE id = ANY(${sessionIds}::uuid[])
          AND outline_hash IS DISTINCT FROM transcript_hash
      `;
    } else {
      sessions = await this.sql<SessionForOutline[]>`
        SELECT id, project_path, git_branch, raw_transcript, transcript_hash, outline, outline_hash, output_tokens
        FROM sessions.sessions
        WHERE outline_hash IS DISTINCT FROM transcript_hash
        ORDER BY started_at DESC
        LIMIT 100
      `;
    }

    result.sessionsProcessed = sessions.length;

    // Reset progress
    this.progress = {
      completed: 0,
      total: sessions.length,
      currentSession: null,
      errors: 0,
      isRunning: true,
    };

    // Process with concurrency limit
    const promises = sessions.map((session) =>
      this.limit(async () => {
        try {
          this.progress.currentSession = session.id;

          // Skip API call for sessions with no assistant output
          const isEmpty = isEmptySession(session);
          const outline = isEmpty ? null : await this.generateOutline(session);

          await this.sql`
            UPDATE sessions.sessions
            SET outline = ${outline},
                outline_hash = ${session.transcript_hash}
            WHERE id = ${session.id}::uuid
          `;

          result.outlinesGenerated++;
          this.progress.completed++;
        } catch (error) {
          const message = `Failed to generate outline for ${session.id}: ${error}`;
          result.errors.push(message);
          this.progress.errors++;
          this.log.error({ error, sessionId: session.id }, message);
        }
      })
    );

    await Promise.all(promises);
    this.progress.currentSession = null;
    this.progress.isRunning = false;

    return result;
  }
}
