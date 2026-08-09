import pLimit from 'p-limit';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { ModelInvoker } from '@jarvus/claude-assist-core';
import { serializeTranscript } from './transcript.js';

export interface OutlineServiceConfig {
  /** The single metered-model choke point (specs/modules/invoker.md). */
  invoker: ModelInvoker;
  /** Concurrency for outline generation (default: 5) */
  concurrency?: number;
  /** Pin a model for this call site. Prefer moving the tier instead. */
  model?: string;
  /** Max tokens for response (default: 1024) */
  maxTokens?: number;
  /** Disable outline generation */
  disableGenerateOutlines?: boolean;
}

export interface OutlineProgress {
  completed: number;
  total: number;
  currentSession: string | null;
  errors: number;
  inProgress: boolean;
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
  outline_attempts: number;
}

/**
 * Check if a session has no assistant output (empty session)
 */
function isEmptySession(session: SessionForOutline): boolean {
  return parseInt(session.output_tokens, 10) === 0;
}

/**
 * Service for generating AI outlines of sessions.
 * Uses p-limit for concurrency control
 */
export class OutlineService {
  /**
   * Max characters of *serialized* transcript allowed into the outline
   * prompt. serializeTranscript() itself caps at 680K chars assuming
   * ~3.5 chars/token, but real sessions can run denser than that - one
   * production case (a long automated run) measured ~3.33 chars/token,
   * landing at 204,367 tokens against the 200K-token context window
   * despite passing that cap, and retrying every cycle forever.
   * This budget is deliberately much tighter, with real margin even for
   * dense code-heavy content.
   */
  private static readonly TRANSCRIPT_PROMPT_CHAR_BUDGET = 300_000;

  /**
   * Sessions that fail outline generation this many times stop being
   * picked up by the automatic sweeps (hourly cron + the post-sync/push
   * triggers) - a session that's still too large after capping, or fails
   * for some other persistent reason, would otherwise retry forever,
   * paying for a failed model call every cycle. `outline_attempts` is only
   * reset by a successful outline generation. A manual retry that names
   * specific session ids bypasses the cap, matching a deliberate override.
   */
  static readonly MAX_OUTLINE_ATTEMPTS = 5;

  private sql: postgres.Sql;
  private log: FastifyBaseLogger;
  private invoker: ModelInvoker;
  private limit: ReturnType<typeof pLimit>;
  private model: string | undefined;
  private maxTokens: number;
  private progress: OutlineProgress;
  private disableGenerateOutlines: boolean;

  constructor(
    sql: postgres.Sql,
    log: FastifyBaseLogger,
    config: OutlineServiceConfig
  ) {
    this.sql = sql;
    this.log = log;
    this.invoker = config.invoker;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 1024;
    this.disableGenerateOutlines = config.disableGenerateOutlines ?? false;

    // Initialize concurrency limiter
    this.limit = pLimit(config.concurrency ?? 5);

    // Initialize progress tracking
    this.progress = {
      completed: 0,
      total: 0,
      currentSession: null,
      errors: 0,
      inProgress: false,
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
<title>[5-10 word concise title describing the main task]</title>
<summary>
Task: [1-2 sentence description of what the user wanted to accomplish]

Outcome: [1-2 sentence summary of what was accomplished or the result]

- [key topic or task covered]
- [key topic or task covered]
</summary>`;
  }

  /**
   * Cap the serialized transcript at TRANSCRIPT_PROMPT_CHAR_BUDGET before it
   * enters the outline prompt. A blind head-only truncate (what
   * serializeTranscript() itself does) drops the ending entirely, which is
   * often the part that matters most for a summary - what actually
   * happened. So instead, this keeps a head sample (what was asked) and a
   * tail sample (how it wrapped up), split evenly, and drops the middle -
   * cutting on line boundaries so [U]/[A]/[T]-prefixed entries stay intact.
   */
  private capTranscriptForPrompt(serialized: string): { text: string; truncated: boolean } {
    if (serialized.length <= OutlineService.TRANSCRIPT_PROMPT_CHAR_BUDGET) {
      return { text: serialized, truncated: false };
    }

    const lines = serialized.split('\n');
    const halfBudget = Math.floor(OutlineService.TRANSCRIPT_PROMPT_CHAR_BUDGET / 2);

    const head: string[] = [];
    let headChars = 0;
    let headEnd = 0;
    for (; headEnd < lines.length; headEnd++) {
      const line = lines[headEnd]!;
      if (headChars + line.length + 1 > halfBudget) {
        // A single line (e.g. one giant pasted diff) can exceed the whole
        // head budget by itself. Rather than drop it - leaving the sample
        // empty - keep a raw char slice of it.
        if (head.length === 0 && line.length > 0) {
          head.push(line.slice(0, halfBudget));
          headEnd++;
        }
        break;
      }
      head.push(line);
      headChars += line.length + 1;
    }

    const tail: string[] = [];
    let tailChars = 0;
    let i = lines.length - 1;
    for (; i >= headEnd; i--) {
      const line = lines[i]!;
      if (tailChars + line.length + 1 > halfBudget) {
        if (tail.length === 0 && line.length > 0) {
          tail.unshift(line.slice(-halfBudget));
        }
        break;
      }
      tail.unshift(line);
      tailChars += line.length + 1;
    }

    const text = [...head, '[...transcript truncated - middle omitted...]', ...tail].join('\n');
    return { text, truncated: true };
  }

  /**
   * Parse the outline response - extract title and summary from tags
   */
  private parseOutlineResponse(response: string): {
    title: string | null;
    outline: string;
  } {
    // Extract title from title tags
    const titleMatch = response.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch?.[1]?.trim() || null;

    // Extract content from summary tags if present
    const summaryMatch = response.match(/<summary>([\s\S]*?)<\/summary>/);
    const outline = summaryMatch?.[1]?.trim() || response.trim();

    return { title, outline };
  }

  /**
   * Generate outline and title for a single session
   */
  async generateOutline(
    session: SessionForOutline
  ): Promise<{ title: string | null; outline: string }> {
    const serializedTranscript = serializeTranscript(session.raw_transcript);
    const capped = this.capTranscriptForPrompt(serializedTranscript);

    if (capped.truncated) {
      this.log.info(
        {
          sessionId: session.id,
          originalLength: serializedTranscript.length,
          cappedLength: capped.text.length,
        },
        'Transcript too large for outline prompt, sampling head+tail'
      );
    }

    const prompt = this.buildPrompt(
      session.project_path,
      session.git_branch,
      capped.text
    );

    // A long transcript in, a short summary out — the extract tier. The
    // response is free text with optional tags, so no tagged-parse retry:
    // a missing <summary> falls back to the whole reply rather than costing
    // a second call.
    const result = await this.invoker.invoke({
      task: 'sessions.outline',
      tier: 'extract',
      maxTokens: this.maxTokens,
      ...(this.model ? { model: this.model } : {}),
      messages: [{ role: 'user', content: prompt }],
    });

    return this.parseOutlineResponse(result.text);
  }

  /**
   * Record a failed outline attempt and log clearly once a session hits the
   * cap (MAX_OUTLINE_ATTEMPTS) - visible without digging through logs when a
   * permanently-stuck session needs a code fix or a manual sessionIds retry.
   */
  private async bumpOutlineAttempts(sessionId: string): Promise<void> {
    const [updated] = await this.sql<{ outline_attempts: number }[]>`
      UPDATE sessions.sessions
      SET outline_attempts = outline_attempts + 1
      WHERE id = ${sessionId}::uuid
      RETURNING outline_attempts
    `;

    if (updated && updated.outline_attempts >= OutlineService.MAX_OUTLINE_ATTEMPTS) {
      this.log.error(
        {
          sessionId,
          attempts: updated.outline_attempts,
          maxAttempts: OutlineService.MAX_OUTLINE_ATTEMPTS,
        },
        'Outline generation failed max attempts - automatic sweeps will stop retrying this session'
      );
    }
  }

  /**
   * Process sessions that need outline generation (async/non-blocking)
   * Returns immediately, processing happens in background
   */
  async queueOutlineGeneration(sessionIds?: string[]): Promise<void> {
    if (this.disableGenerateOutlines) {
      this.log.info('Outline generation disabled via disableGenerateOutlines config');
      return;
    }

    if (this.progress.inProgress) {
      this.log.info('Outline generation already in progress, skipping');
      return;
    }

    // Mark as running immediately to prevent race conditions
    this.progress.inProgress = true;

    // Find sessions needing outlines. Explicit sessionIds (a manual retry)
    // bypass the retry cap; the unforced full sweep (cron + post-sync/push
    // triggers) excludes sessions that already hit MAX_OUTLINE_ATTEMPTS so
    // a permanently-failing session can't burn a paid model call forever.
    let sessions: SessionForOutline[];
    try {
      if (sessionIds && sessionIds.length > 0) {
        sessions = await this.sql<SessionForOutline[]>`
          SELECT id, project_path, git_branch, raw_transcript, transcript_hash, outline, outline_hash, output_tokens, outline_attempts
          FROM sessions.sessions
          WHERE id = ANY(${sessionIds}::uuid[])
            AND outline_hash IS DISTINCT FROM transcript_hash
        `;
      } else {
        sessions = await this.sql<SessionForOutline[]>`
          SELECT id, project_path, git_branch, raw_transcript, transcript_hash, outline, outline_hash, output_tokens, outline_attempts
          FROM sessions.sessions
          WHERE outline_hash IS DISTINCT FROM transcript_hash
            AND outline_attempts < ${OutlineService.MAX_OUTLINE_ATTEMPTS}
          ORDER BY started_at DESC
        `;
      }
    } catch (error) {
      this.progress.inProgress = false;
      this.log.error({ error }, 'Failed to query sessions for outline generation');
      throw error;
    }

    if (sessions.length === 0) {
      this.log.info('No sessions need outline generation');
      this.progress.inProgress = false;
      return;
    }

    // Reset progress
    this.progress = {
      completed: 0,
      total: sessions.length,
      currentSession: null,
      errors: 0,
      inProgress: true,
    };

    this.log.info({ count: sessions.length }, 'Queuing outline generation');

    // Queue all sessions with concurrency limit (non-blocking)
    const promises = sessions.map((session) =>
      this.limit(async () => {
        try {
          this.progress.currentSession = session.id;

          // Skip API call for sessions with no assistant output
          const isEmpty = isEmptySession(session);
          const generated = isEmpty ? null : await this.generateOutline(session);

          // Store the outline and title (null for empty sessions), and
          // reset the retry counter now that generation succeeded
          await this.sql`
            UPDATE sessions.sessions
            SET outline = ${generated?.outline ?? null},
                title = ${generated?.title ?? null},
                outline_hash = ${session.transcript_hash},
                outline_attempts = 0
            WHERE id = ${session.id}::uuid
          `;

          this.progress.completed++;
          this.log.debug(
            { sessionId: session.id, skipped: isEmpty },
            generated ? 'Generated outline' : 'Skipped empty session'
          );
        } catch (error) {
          this.progress.errors++;
          this.log.error(
            { error, sessionId: session.id },
            'Failed to generate outline'
          );
          await this.bumpOutlineAttempts(session.id);
        }
      })
    );

    // Don't await - let it run in background
    Promise.all(promises)
      .then(() => {
        this.progress.currentSession = null;
        this.progress.inProgress = false;
        this.log.info(
          {
            completed: this.progress.completed,
            errors: this.progress.errors,
          },
          'Outline generation batch complete'
        );
      })
      .catch((error) => {
        this.progress.inProgress = false;
        this.log.error({ error }, 'Outline generation batch failed');
      });
  }

  /**
   * Generate outlines synchronously (blocking, for manual triggers)
   */
  async generateOutlinesSync(sessionIds?: string[]): Promise<OutlineResult> {
    if (this.disableGenerateOutlines) {
      this.log.info('Outline generation disabled via disableGenerateOutlines config');
      return {
        sessionsProcessed: 0,
        outlinesGenerated: 0,
        skipped: 0,
        errors: [],
      };
    }

    const result: OutlineResult = {
      sessionsProcessed: 0,
      outlinesGenerated: 0,
      skipped: 0,
      errors: [],
    };

    // Find sessions needing outlines (filter by hash mismatch at query
    // level). Explicit sessionIds bypass the retry cap, same as
    // queueOutlineGeneration - see the comment there.
    let sessions: SessionForOutline[];
    if (sessionIds && sessionIds.length > 0) {
      sessions = await this.sql<SessionForOutline[]>`
        SELECT id, project_path, git_branch, raw_transcript, transcript_hash, outline, outline_hash, output_tokens, outline_attempts
        FROM sessions.sessions
        WHERE id = ANY(${sessionIds}::uuid[])
          AND outline_hash IS DISTINCT FROM transcript_hash
      `;
    } else {
      sessions = await this.sql<SessionForOutline[]>`
        SELECT id, project_path, git_branch, raw_transcript, transcript_hash, outline, outline_hash, output_tokens, outline_attempts
        FROM sessions.sessions
        WHERE outline_hash IS DISTINCT FROM transcript_hash
          AND outline_attempts < ${OutlineService.MAX_OUTLINE_ATTEMPTS}
        ORDER BY started_at DESC
      `;
    }

    result.sessionsProcessed = sessions.length;

    // Reset progress
    this.progress = {
      completed: 0,
      total: sessions.length,
      currentSession: null,
      errors: 0,
      inProgress: true,
    };

    // Process with concurrency limit
    const promises = sessions.map((session) =>
      this.limit(async () => {
        try {
          this.progress.currentSession = session.id;

          // Skip API call for sessions with no assistant output
          const isEmpty = isEmptySession(session);
          const generated = isEmpty ? null : await this.generateOutline(session);

          await this.sql`
            UPDATE sessions.sessions
            SET outline = ${generated?.outline ?? null},
                title = ${generated?.title ?? null},
                outline_hash = ${session.transcript_hash},
                outline_attempts = 0
            WHERE id = ${session.id}::uuid
          `;

          result.outlinesGenerated++;
          this.progress.completed++;
        } catch (error) {
          const message = `Failed to generate outline for ${session.id}: ${error}`;
          result.errors.push(message);
          this.progress.errors++;
          this.log.error({ error, sessionId: session.id }, message);
          await this.bumpOutlineAttempts(session.id);
        }
      })
    );

    await Promise.all(promises);
    this.progress.currentSession = null;
    this.progress.inProgress = false;

    return result;
  }
}
