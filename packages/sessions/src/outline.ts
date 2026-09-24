import { createHash } from 'node:crypto';
import pLimit from 'p-limit';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { ModelInvoker } from '@jarvus/claude-assist-core';
import { serializeTranscript } from './transcript.js';
import { TranscriptReader } from './transcript-reader.js';
import {
  OutlineWindowStore,
  DEFAULT_OUTLINE_WINDOW_CONFIG,
  planWindows,
  isWindowedSession,
  approxMessageBytes,
  windowsSignature,
  buildComposePrompt,
  buildWindowPrompt,
  type OutlineWindowConfig,
  type SummarizedWindowForCompose,
} from './outline-windows.js';

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
  /**
   * Windowed-outline thresholds and window sizing
   * (specs/behaviors/session-outlines.md). Defaults to
   * `DEFAULT_OUTLINE_WINDOW_CONFIG`; individual fields may be overridden.
   */
  windowConfig?: Partial<OutlineWindowConfig>;
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

/**
 * Deliberately carries no `raw_transcript`. A sweep selects one row per
 * session needing an outline - every session in the table, on a cold start -
 * so the transcript blob is fetched per-session inside the concurrency
 * limiter instead, bounding peak memory to `concurrency` transcripts rather
 * than the whole table's worth. See fetchCappedTranscript().
 */
interface SessionForOutline {
  id: string;
  project_path: string | null;
  git_branch: string | null;
  transcript_hash: string;
  outline: string | null;
  outline_hash: string | null;
  // postgres.js returns BIGINT as string to avoid JS number precision loss
  output_tokens: string;
  outline_attempts: number;
  /** Windowing decision input (specs/behaviors/session-outlines.md). */
  message_count: number;
  /** Signature of the window summaries that produced the current composed outline, if any. */
  outline_windows_hash: string | null;
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
   * Max characters of *raw* JSONL pulled out of Postgres for one session.
   * Sessions are unbounded in size - a long-lived polling bot can append to
   * one transcript for weeks and reach hundreds of MB - while the prompt
   * only ever uses TRANSCRIPT_PROMPT_CHAR_BUDGET of the serialized result.
   * Fetching the whole column just to throw almost all of it away is what
   * put multiple GB on the heap per sweep, so the slice happens in SQL.
   *
   * The margin over the prompt budget is deliberate: serializing strips the
   * JSON envelope, so raw shrinks substantially on its way to the prompt,
   * and this has to stay comfortably above the budget for capping to still
   * have material to work with.
   */
  private static readonly RAW_TRANSCRIPT_FETCH_BUDGET = 2_000_000;

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

  /** Lease duration for a claimed window's summarization (specs/behaviors/scheduled-work-leases.md). */
  private static readonly WINDOW_LEASE_MS = 10 * 60 * 1000;

  private sql: postgres.Sql;
  private log: FastifyBaseLogger;
  private reader: TranscriptReader;
  private invoker: ModelInvoker;
  private limit: ReturnType<typeof pLimit>;
  private model: string | undefined;
  private maxTokens: number;
  private progress: OutlineProgress;
  private disableGenerateOutlines: boolean;

  // ── Windowed outlines (specs/behaviors/session-outlines.md) ──────────────
  private windowStore: OutlineWindowStore;
  private windowConfig: OutlineWindowConfig;
  /** This process's lease-owner id, so a reclaim can tell a live lease from a crashed one. */
  private ownerId: string;
  /**
   * Windows summarized this sweep, across every session processed — the
   * shared backfill throttle. Reset to `windowConfig.sweepCap` at the start
   * of each `queueOutlineGeneration`/`generateOutlinesSync` call. A plain
   * instance field is safe here: the per-session tasks it's shared across all
   * run on this one process's event loop, and each decrements it
   * synchronously before its next `await` — the cross-process race this
   * doesn't (and doesn't need to) cover is guarded separately, per window, by
   * `OutlineWindowStore.claimOne`'s atomic `UPDATE ... WHERE status =
   * 'pending'`.
   */
  private windowBudget = 0;

  constructor(
    sql: postgres.Sql,
    log: FastifyBaseLogger,
    config: OutlineServiceConfig
  ) {
    this.sql = sql;
    this.log = log;
    this.reader = new TranscriptReader(sql);
    this.invoker = config.invoker;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 1024;
    this.disableGenerateOutlines = config.disableGenerateOutlines ?? false;

    this.windowStore = new OutlineWindowStore(sql);
    this.windowConfig = { ...DEFAULT_OUTLINE_WINDOW_CONFIG, ...config.windowConfig };
    this.ownerId = `${process.env.HOSTNAME ?? 'host'}-${process.pid}`;

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
   * Read one session's raw transcript, sliced to RAW_TRANSCRIPT_FETCH_BUDGET
   * in SQL so an oversized session never lands on the heap in full.
   *
   * The slice keeps a head and a tail for the same reason
   * capTranscriptForPrompt() does - the end of a session is usually the part
   * that says what actually happened - and joins them with a newline so the
   * partial lines at each cut stay separate. Raw transcripts are JSONL and
   * serializeTranscript() skips lines it can't parse, so the two fragments
   * at the seam drop out on their own.
   */
  private async fetchCappedTranscript(
    sessionId: string
  ): Promise<{ raw: string; fullLength: number }> {
    return this.reader.readHeadTail(sessionId, OutlineService.RAW_TRANSCRIPT_FETCH_BUDGET);
  }

  /**
   * Generate outline and title for a single session
   */
  async generateOutline(
    session: SessionForOutline
  ): Promise<{ title: string | null; outline: string }> {
    const { raw, fullLength } = await this.fetchCappedTranscript(session.id);

    if (fullLength > OutlineService.RAW_TRANSCRIPT_FETCH_BUDGET) {
      this.log.info(
        {
          sessionId: session.id,
          fullLength,
          fetchedLength: raw.length,
        },
        'Transcript exceeds raw fetch budget, sampling head+tail in SQL'
      );
    }

    const serializedTranscript = serializeTranscript(raw);
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
   * Whether a session is over the windowing threshold
   * (specs/behaviors/session-outlines.md). Message count is already on the
   * selected row, so a session obviously over that threshold short-circuits
   * without an extra query; the byte check only runs for a session that's
   * short on messages but could still be large (a few huge pasted blocks) —
   * `rawByteLength` is a scalar read, never a content fetch.
   */
  private async isWindowed(session: SessionForOutline): Promise<boolean> {
    if (session.message_count > this.windowConfig.thresholdMessages) return true;
    const bytes = await this.reader.rawByteLength(session.id);
    return isWindowedSession(session.message_count, bytes, this.windowConfig);
  }

  /**
   * Windowed generation for a long session: maintain window boundaries
   * (cheap, no model calls, reads only what's new via
   * `TranscriptReader.messagesSince`), summarize windows up to the shared
   * per-sweep budget (`this.windowBudget`), and recompose the session
   * outline from the window summaries when their signature has changed.
   *
   * `caughtUp` tells the caller whether it's safe to advance `outline_hash`
   * to `transcript_hash` — only once boundaries reflect the transcript's
   * current end (always true right after the boundary pass above, since
   * `messagesSince` has no upper bound) AND every window is resolved
   * (`summarized`, `failed`, or a tail that was actually processed this
   * pass rather than skipped for lack of budget or lost a claim race).
   */
  private async generateWindowedOutline(session: SessionForOutline): Promise<{
    generated: { title: string | null; outline: string } | null;
    newWindowsHash: string | null;
    caughtUp: boolean;
  }> {
    const { lastClosedToSeq, closedCount } = await this.windowStore.boundaryState(session.id);
    const newMessages = await this.reader.messagesSince(session.id, lastClosedToSeq);
    if (newMessages.length > 0) {
      const boundaries = planWindows(
        closedCount,
        lastClosedToSeq + 1,
        newMessages.map((m) => ({ timestamp: m.timestamp, approxBytes: approxMessageBytes(m) })),
        this.windowConfig
      );
      for (const boundary of boundaries) {
        await this.windowStore.upsertBoundary(session.id, boundary);
      }
    }

    const windows = await this.windowStore.listWindows(session.id);
    let caughtUp = true;

    for (const w of windows) {
      if (w.status === 'summarized' || w.status === 'failed') continue; // resolved, immutable or given up
      if (w.status === 'summarizing') {
        caughtUp = false; // another process (or a stuck lease) currently owns it
        continue;
      }
      // status === 'pending'
      if (this.windowBudget <= 0) {
        caughtUp = false; // budget exhausted this sweep; carries to the next one
        continue;
      }
      this.windowBudget--;

      const claimed = await this.windowStore.claimOne(w.id, this.ownerId, OutlineService.WINDOW_LEASE_MS);
      if (!claimed) {
        caughtUp = false; // lost a claim race to a concurrent sweep
        continue;
      }

      const isTail = w.closed_at === null;
      try {
        const range = await this.reader.messageRange(session.id, w.from_seq, w.to_seq);
        const contentHash = createHash('md5').update(range.text).digest('hex');

        if (isTail && w.content_hash !== null && w.content_hash === contentHash) {
          // Nothing new since the tail's last summary — no model call.
          await this.windowStore.releaseUnchanged(w.id);
          continue;
        }

        const prompt = buildWindowPrompt(
          session.project_path,
          session.git_branch,
          w.window_index,
          !isTail,
          range.text
        );
        const result = await this.invoker.invoke({
          task: 'sessions.outline.window',
          tier: 'extract',
          maxTokens: this.maxTokens,
          ...(this.model ? { model: this.model } : {}),
          messages: [{ role: 'user', content: prompt }],
        });
        const summary = result.text.trim();
        await this.windowStore.completeSummary(w.id, {
          summary,
          model: this.invoker.modelFor('extract'),
          contentHash,
          closed: !isTail,
        });
        w.status = isTail ? 'pending' : 'summarized';
        w.summary = summary;
        w.content_hash = contentHash;
      } catch (error) {
        caughtUp = false;
        await this.windowStore.failSummary(w.id, String(error), this.windowConfig.maxAttempts);
        this.log.error({ error, sessionId: session.id, windowIndex: w.window_index }, 'Failed to summarize outline window');
      }
    }

    const summarized: SummarizedWindowForCompose[] = windows
      .filter((w) => w.summary !== null)
      .map((w) => ({
        windowIndex: w.window_index,
        fromTs: w.from_ts,
        toTs: w.to_ts,
        closed: w.closed_at !== null,
        summary: w.summary as string,
      }));

    let generated: { title: string | null; outline: string } | null = null;
    let newWindowsHash: string | null = null;
    if (summarized.length > 0) {
      const sig = windowsSignature(summarized);
      if (sig !== session.outline_windows_hash) {
        const prompt = buildComposePrompt(session.project_path, session.git_branch, summarized);
        const result = await this.invoker.invoke({
          task: 'sessions.outline.compose',
          tier: 'extract',
          maxTokens: this.maxTokens,
          ...(this.model ? { model: this.model } : {}),
          messages: [{ role: 'user', content: prompt }],
        });
        generated = this.parseOutlineResponse(result.text);
        newWindowsHash = sig;
      }
    }

    return { generated, newWindowsHash, caughtUp };
  }

  /**
   * Everything that happens to ONE session in a sweep: decide the path
   * (empty / single-pass / windowed), generate accordingly, and persist.
   * `queueOutlineGeneration` and `generateOutlinesSync` both call this so
   * the windowing branch exists in exactly one place; each keeps its own
   * progress/result bookkeeping around the call. The short-pass branch below
   * is byte-identical to the pre-windowing code: same query, same
   * `generateOutline` call, same UPDATE.
   */
  private async processOneSession(session: SessionForOutline): Promise<void> {
    const isEmpty = isEmptySession(session);
    if (isEmpty) {
      await this.sql`
        UPDATE sessions.sessions
        SET outline = NULL,
            title = NULL,
            outline_hash = ${session.transcript_hash},
            outline_attempts = 0
        WHERE id = ${session.id}::uuid
      `;
      this.log.debug({ sessionId: session.id, skipped: true }, 'Skipped empty session');
      return;
    }

    if (!(await this.isWindowed(session))) {
      const generated = await this.generateOutline(session);
      await this.sql`
        UPDATE sessions.sessions
        SET outline = ${generated.outline},
            title = ${generated.title},
            outline_hash = ${session.transcript_hash},
            outline_attempts = 0
        WHERE id = ${session.id}::uuid
      `;
      this.log.debug({ sessionId: session.id, skipped: false }, 'Generated outline');
      return;
    }

    const { generated, newWindowsHash, caughtUp } = await this.generateWindowedOutline(session);
    await this.sql`
      UPDATE sessions.sessions SET
        ${generated
          ? this.sql`outline = ${generated.outline}, title = ${generated.title}, outline_windows_hash = ${newWindowsHash},`
          : this.sql``}
        ${caughtUp ? this.sql`outline_hash = ${session.transcript_hash},` : this.sql``}
        outline_attempts = 0
      WHERE id = ${session.id}::uuid
    `;
    this.log.debug(
      { sessionId: session.id, composed: generated !== null, caughtUp },
      'Processed windowed outline'
    );
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
          SELECT id, project_path, git_branch, transcript_hash, outline, outline_hash, output_tokens, outline_attempts, message_count, outline_windows_hash
          FROM sessions.sessions
          WHERE id = ANY(${sessionIds}::uuid[])
            AND outline_hash IS DISTINCT FROM transcript_hash
        `;
      } else {
        sessions = await this.sql<SessionForOutline[]>`
          SELECT id, project_path, git_branch, transcript_hash, outline, outline_hash, output_tokens, outline_attempts, message_count, outline_windows_hash
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

    // Per-sweep windowing bookkeeping: reclaim any lease a crashed prior
    // sweep left stuck, then reset the shared backfill budget this sweep may
    // spend across every windowed session below.
    await this.windowStore.reclaimExpired().catch((error) => {
      this.log.warn({ error }, 'Failed to reclaim expired outline-window leases');
    });
    this.windowBudget = this.windowConfig.sweepCap;

    this.log.info({ count: sessions.length }, 'Queuing outline generation');

    // Queue all sessions with concurrency limit (non-blocking)
    const promises = sessions.map((session) =>
      this.limit(async () => {
        try {
          this.progress.currentSession = session.id;
          await this.processOneSession(session);
          this.progress.completed++;
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
        SELECT id, project_path, git_branch, transcript_hash, outline, outline_hash, output_tokens, outline_attempts, message_count, outline_windows_hash
        FROM sessions.sessions
        WHERE id = ANY(${sessionIds}::uuid[])
          AND outline_hash IS DISTINCT FROM transcript_hash
      `;
    } else {
      sessions = await this.sql<SessionForOutline[]>`
        SELECT id, project_path, git_branch, transcript_hash, outline, outline_hash, output_tokens, outline_attempts, message_count, outline_windows_hash
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

    // Per-sweep windowing bookkeeping — see queueOutlineGeneration.
    await this.windowStore.reclaimExpired().catch((error) => {
      this.log.warn({ error }, 'Failed to reclaim expired outline-window leases');
    });
    this.windowBudget = this.windowConfig.sweepCap;

    // Process with concurrency limit
    const promises = sessions.map((session) =>
      this.limit(async () => {
        try {
          this.progress.currentSession = session.id;
          await this.processOneSession(session);
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
