/**
 * Classification sweep orchestrator. Selects sessions with unclassified delta,
 * serializes only the new-message window (per-session cursor), runs the
 * classifier, appends events, and advances the cursor — delta-only, idempotent,
 * append-only.
 *
 * Cost posture: the scheduled sweep is bounded by a short `lookback` so it only
 * tracks recent/live sessions and never touches the 2,400-session backlog on
 * deploy. Historical coverage is an explicit, bounded `backfillSince`.
 */

import pLimit from 'p-limit';
import type { FastifyBaseLogger } from 'fastify';
import { serializeSince } from '../transcript.js';
import type { ClassificationEventClassifier } from './events.js';
import type { ClassificationStore } from './store.js';
import type { SessionForClassification } from './types.js';

export interface ClassificationServiceConfig {
  /** Parallel classify calls (default 3). */
  concurrency?: number;
  /** Sessions selected per sweep (default 50). */
  batchSize?: number;
  /**
   * A session is classified once it has at least this many new messages since
   * its cursor, OR it has gone quiet (see quietHours). Keeps windows
   * signal-dense and avoids paying to classify a one-message delta (default 6).
   */
  minDelta?: number;
  /** Hours of inactivity after which a session gets its terminal (final) pass (default 48). */
  quietHours?: number;
  /**
   * How far back the scheduled sweep looks, by last transcript *activity*
   * (sessions.synced_at — bumped only when content changes), so a months-old
   * session resumed today is still swept. Postgres interval, default '3 days'.
   * MUST comfortably exceed quietHours: a held sub-minDelta tail is flushed by
   * the quiet pass, which can only fire while the session's synced_at is still
   * inside this window.
   */
  lookback?: string;
}

export interface SweepResult {
  sessionsSelected: number;
  sessionsClassified: number;
  sessionsSkipped: number;
  eventsAppended: number;
  errors: number;
}

/** The retry cap: a session that fails classification this many times stops being selected. */
export const MAX_CLASSIFICATION_ATTEMPTS = 5;

export class ClassificationService {
  private limit: ReturnType<typeof pLimit>;
  private batchSize: number;
  private minDelta: number;
  private quietHours: number;
  private lookback: string;
  private sweeping = false;

  constructor(
    private store: ClassificationStore,
    private classifier: ClassificationEventClassifier,
    private log: FastifyBaseLogger,
    config: ClassificationServiceConfig = {}
  ) {
    this.limit = pLimit(config.concurrency ?? 3);
    this.batchSize = config.batchSize ?? 50;
    this.minDelta = config.minDelta ?? 6;
    this.quietHours = config.quietHours ?? 48;
    this.lookback = config.lookback ?? '3 days';
  }

  /** Scheduled sweep: classify recent sessions' deltas. */
  async sweep(): Promise<SweepResult> {
    if (this.sweeping) {
      this.log.info('Classification sweep already in progress - skipping');
      return this.emptyResult();
    }
    this.sweeping = true;
    try {
      const sessions = await this.store.selectForClassification(
        this.batchSize,
        MAX_CLASSIFICATION_ATTEMPTS,
        this.lookback
      );
      return await this.classifyBatch(sessions);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Bounded historical backfill from an explicit `since`. Runs to completion in
   * pages of `batchSize`. This is the ONLY path that reaches past the sweep's
   * lookback — never invoked automatically on deploy.
   */
  async backfillSince(since: Date): Promise<SweepResult> {
    const total = this.emptyResult();
    // Page until a batch selects nothing new. A page whose sessions all fail
    // (and hit the attempt cap) will stop being selected, terminating the loop.
    for (;;) {
      const sessions = await this.store.selectForBackfill(
        since,
        this.batchSize,
        MAX_CLASSIFICATION_ATTEMPTS
      );
      if (sessions.length === 0) break;
      const page = await this.classifyBatch(sessions);
      total.sessionsSelected += page.sessionsSelected;
      total.sessionsClassified += page.sessionsClassified;
      total.sessionsSkipped += page.sessionsSkipped;
      total.eventsAppended += page.eventsAppended;
      total.errors += page.errors;
      // If a whole page only skipped (waiting for more delta) and nothing
      // advanced, stop — otherwise we'd loop forever on the same rows.
      if (page.sessionsClassified === 0 && page.errors === 0) break;
    }
    return total;
  }

  private async classifyBatch(sessions: SessionForClassification[]): Promise<SweepResult> {
    const result = this.emptyResult();
    result.sessionsSelected = sessions.length;

    await Promise.all(
      sessions.map((s) =>
        this.limit(async () => {
          try {
            const outcome = await this.classifyOne(s);
            if (outcome === 'skipped') {
              result.sessionsSkipped++;
            } else {
              result.sessionsClassified++;
              result.eventsAppended += outcome;
            }
          } catch (error) {
            result.errors++;
            const attempts = await this.store.recordFailure(s.id);
            this.log.error(
              { error, sessionId: s.id, attempts },
              attempts >= MAX_CLASSIFICATION_ATTEMPTS
                ? 'Classification failed max attempts - sweep will stop retrying this session'
                : 'Classification failed'
            );
          }
        })
      )
    );

    return result;
  }

  /**
   * Classify one session's delta. Returns 'skipped' when there isn't enough new
   * delta yet and the session isn't quiet; otherwise returns the number of
   * events appended.
   */
  private async classifyOne(s: SessionForClassification): Promise<number | 'skipped'> {
    const fromSeq = s.cursor_last_seq ?? -1;
    const delta = serializeSince(s.raw_transcript, fromSeq);

    // No new messages at all (idempotent no-op) — advance the hash so we don't
    // re-select this unchanged transcript next cycle.
    if (delta.count === 0) {
      await this.store.advanceCursor(
        s.id,
        delta.seqEnd,
        s.transcript_hash,
        fromSeq + 1,
        this.isQuiet(s)
      );
      return 0;
    }

    const quiet = this.isQuiet(s);
    // Hold a small, still-active delta until it accumulates or the session goes
    // quiet. We leave the cursor untouched so it's re-selected next cycle (no
    // model spend on this pass).
    if (delta.count < this.minDelta && !quiet) {
      return 'skipped';
    }

    const events = await this.classifier.classifyDelta({
      sessionId: s.id,
      projectPath: s.project_path,
      gitBranch: s.git_branch,
      deltaText: delta.text,
    });

    if (events.length > 0) {
      await this.store.appendEvents(
        s.id,
        delta.seqStart,
        delta.seqEnd,
        events,
        this.classifier.model
      );
    }

    await this.store.advanceCursor(
      s.id,
      delta.seqEnd,
      s.transcript_hash,
      delta.seqEnd + 1,
      quiet
    );

    return events.length;
  }

  private isQuiet(s: SessionForClassification): boolean {
    const last = s.ended_at ? new Date(s.ended_at).getTime() : null;
    if (last === null) return false;
    return Date.now() - last > this.quietHours * 60 * 60 * 1000;
  }

  private emptyResult(): SweepResult {
    return {
      sessionsSelected: 0,
      sessionsClassified: 0,
      sessionsSkipped: 0,
      eventsAppended: 0,
      errors: 0,
    };
  }
}
