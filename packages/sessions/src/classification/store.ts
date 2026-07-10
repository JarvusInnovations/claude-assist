/**
 * Persistence for the classification pipeline. Events are APPEND-ONLY: this
 * store exposes no update or delete of a classification_events row (a session
 * delete cascades, that's all). Cursors are mutable — they advance.
 */

import type postgres from 'postgres';
import type {
  ClassificationEventWithContext,
  ActiveSessionSummary,
  DetectedEvent,
  SessionForClassification,
  SynthesisPayload,
} from './types.js';

export class ClassificationStore {
  constructor(private sql: postgres.Sql) {}

  /**
   * Sessions whose transcript has new content to classify: no cursor yet, or a
   * cursor whose last_hash differs from the current transcript_hash (the outline
   * pattern). Bounded by `sinceInterval` so the scheduled sweep tracks only
   * recent/live sessions and never sweeps the whole backlog — historical
   * backfill goes through an explicit `--since` (see `backfillSince`).
   */
  async selectForClassification(
    limit: number,
    maxAttempts: number,
    sinceInterval: string
  ): Promise<SessionForClassification[]> {
    return this.sql<SessionForClassification[]>`
      SELECT
        s.id, s.project_path, s.git_branch, s.raw_transcript, s.transcript_hash,
        s.ended_at, s.output_tokens,
        c.last_seq        AS cursor_last_seq,
        c.last_hash       AS cursor_last_hash,
        c.final_pass_done AS cursor_final_pass_done
      FROM sessions.sessions s
      LEFT JOIN sessions.classification_cursors c ON c.session_id = s.id
      WHERE s.output_tokens > 0
        AND s.started_at > NOW() - ${sinceInterval}::interval
        AND (c.session_id IS NULL OR c.last_hash IS DISTINCT FROM s.transcript_hash)
        AND COALESCE(c.attempts, 0) < ${maxAttempts}
      ORDER BY s.ended_at ASC NULLS LAST
      LIMIT ${limit}
    `;
  }

  /**
   * Sessions eligible for a bounded historical backfill: same delta logic but
   * driven by an explicit `since` timestamp rather than the sweep's short
   * lookback. This is the only path that reaches back past the lookback window.
   */
  async selectForBackfill(
    since: Date,
    limit: number,
    maxAttempts: number
  ): Promise<SessionForClassification[]> {
    return this.sql<SessionForClassification[]>`
      SELECT
        s.id, s.project_path, s.git_branch, s.raw_transcript, s.transcript_hash,
        s.ended_at, s.output_tokens,
        c.last_seq        AS cursor_last_seq,
        c.last_hash       AS cursor_last_hash,
        c.final_pass_done AS cursor_final_pass_done
      FROM sessions.sessions s
      LEFT JOIN sessions.classification_cursors c ON c.session_id = s.id
      WHERE s.output_tokens > 0
        AND s.started_at >= ${since}
        AND (c.session_id IS NULL OR c.last_hash IS DISTINCT FROM s.transcript_hash)
        AND COALESCE(c.attempts, 0) < ${maxAttempts}
      ORDER BY s.started_at ASC
      LIMIT ${limit}
    `;
  }

  /**
   * Append classification events for one delta window. INSERT-only, one row per
   * event — no window ever rewrites a prior window's events.
   */
  async appendEvents(
    sessionId: string,
    seqStart: number,
    seqEnd: number,
    events: DetectedEvent[],
    model: string
  ): Promise<void> {
    for (const e of events) {
      await this.sql`
        INSERT INTO sessions.classification_events
          (session_id, seq_start, seq_end, event_type, summary, confidence, quote, model)
        VALUES (
          ${sessionId}::uuid, ${seqStart}, ${seqEnd}, ${e.type},
          ${e.summary}, ${e.confidence}, ${e.quote ?? null}, ${model}
        )
      `;
    }
  }

  /** Advance the cursor after a successful classification pass (attempts reset to 0). */
  async advanceCursor(
    sessionId: string,
    lastSeq: number,
    lastHash: string,
    messageCount: number,
    finalPassDone: boolean
  ): Promise<void> {
    await this.sql`
      INSERT INTO sessions.classification_cursors
        (session_id, last_seq, last_hash, message_count, final_pass_done,
         attempts, last_classified_at, updated_at)
      VALUES (
        ${sessionId}::uuid, ${lastSeq}, ${lastHash}, ${messageCount},
        ${finalPassDone}, 0, NOW(), NOW()
      )
      ON CONFLICT (session_id) DO UPDATE SET
        last_seq = EXCLUDED.last_seq,
        last_hash = EXCLUDED.last_hash,
        message_count = EXCLUDED.message_count,
        -- final_pass_done is sticky: once terminal, stay terminal.
        final_pass_done = sessions.classification_cursors.final_pass_done OR EXCLUDED.final_pass_done,
        attempts = 0,
        last_classified_at = NOW(),
        updated_at = NOW()
    `;
  }

  /** Record a failed classification attempt; returns the new attempt count. */
  async recordFailure(sessionId: string): Promise<number> {
    const [row] = await this.sql<{ attempts: number }[]>`
      INSERT INTO sessions.classification_cursors (session_id, attempts, updated_at)
      VALUES (${sessionId}::uuid, 1, NOW())
      ON CONFLICT (session_id) DO UPDATE SET
        attempts = sessions.classification_cursors.attempts + 1,
        updated_at = NOW()
      RETURNING attempts
    `;
    return row?.attempts ?? 0;
  }

  /** Events (with session context) created within [start, end), for synthesis. */
  async eventsForPeriod(start: Date, end: Date): Promise<ClassificationEventWithContext[]> {
    return this.sql<ClassificationEventWithContext[]>`
      SELECT e.id, e.session_id, e.seq_start, e.seq_end, e.event_type, e.summary,
             e.confidence, e.quote, e.model, e.created_at,
             s.project_path, s.git_branch, s.title
      FROM sessions.classification_events e
      JOIN sessions.sessions s ON s.id = e.session_id
      WHERE e.created_at >= ${start} AND e.created_at < ${end}
      ORDER BY e.created_at ASC
    `;
  }

  /** Sessions active within [start, end) that produced events, for the narrative. */
  async activeSessionsForPeriod(start: Date, end: Date): Promise<ActiveSessionSummary[]> {
    return this.sql<ActiveSessionSummary[]>`
      SELECT s.id, s.project_path, s.title, s.session_name, s.started_at, s.ended_at,
             COUNT(e.id)::int AS event_count
      FROM sessions.sessions s
      JOIN sessions.classification_events e ON e.session_id = s.id
      WHERE e.created_at >= ${start} AND e.created_at < ${end}
      GROUP BY s.id, s.project_path, s.title, s.session_name, s.started_at, s.ended_at
      ORDER BY event_count DESC, s.started_at ASC
    `;
  }

  /** Upsert (replace) a week's synthesis or narrative report. */
  async saveReport(
    kind: 'synthesis' | 'narrative',
    periodStart: string,
    periodEnd: string,
    report: string,
    reportJson: SynthesisPayload | null,
    eventCount: number,
    model: string
  ): Promise<void> {
    await this.sql`
      INSERT INTO sessions.synthesis_reports
        (kind, period_start, period_end, report, report_json, event_count, model)
      VALUES (
        ${kind}, ${periodStart}, ${periodEnd}, ${report},
        ${reportJson ? this.sql.json(reportJson as never) : null}, ${eventCount}, ${model}
      )
      ON CONFLICT (kind, period_start) DO UPDATE SET
        period_end = EXCLUDED.period_end,
        report = EXCLUDED.report,
        report_json = EXCLUDED.report_json,
        event_count = EXCLUDED.event_count,
        model = EXCLUDED.model,
        created_at = NOW()
    `;
  }

  /** Recent events for the read API. */
  async listEvents(opts: {
    type?: string;
    days?: number;
    limit: number;
  }): Promise<ClassificationEventWithContext[]> {
    const { type, days, limit } = opts;
    return this.sql<ClassificationEventWithContext[]>`
      SELECT e.id, e.session_id, e.seq_start, e.seq_end, e.event_type, e.summary,
             e.confidence, e.quote, e.model, e.created_at,
             s.project_path, s.git_branch, s.title
      FROM sessions.classification_events e
      JOIN sessions.sessions s ON s.id = e.session_id
      WHERE 1=1
        ${type ? this.sql`AND e.event_type = ${type}` : this.sql``}
        ${days ? this.sql`AND e.created_at > NOW() - INTERVAL '1 day' * ${days}` : this.sql``}
      ORDER BY e.created_at DESC
      LIMIT ${limit}
    `;
  }

  /** Recent persisted reports for the read API. */
  async listReports(limit: number): Promise<
    Array<{
      id: string;
      kind: string;
      period_start: string;
      period_end: string;
      report: string;
      event_count: number;
      created_at: Date;
    }>
  > {
    return this.sql`
      SELECT id, kind, period_start, period_end, report, event_count, created_at
      FROM sessions.synthesis_reports
      ORDER BY period_start DESC, kind ASC
      LIMIT ${limit}
    ` as never;
  }
}
