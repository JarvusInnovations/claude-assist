/**
 * Captures-awaiting-review count for the briefing, read from the capture
 * module's table (claude-assist Postgres). These are the actionable /
 * team-relevant captures parked for the owner's explicit synthesis (the firewall
 * never auto-routes them). Degrades to omission if the capture schema is absent.
 */

import type postgres from 'postgres';

export interface CapturesSummary {
  awaitingReview: number;
  awaitingExecutor: number;
  error: string | null;
}

export async function fetchCapturesSummary(sql: postgres.Sql): Promise<CapturesSummary> {
  try {
    const rows = await sql<{ status: string; count: number }[]>`
      SELECT status::text AS status, COUNT(*)::int AS count
      FROM capture.captures
      WHERE status IN ('awaiting_review', 'awaiting_executor')
      GROUP BY status
    `;
    const byStatus = new Map(rows.map((r) => [r.status, r.count]));
    return {
      awaitingReview: byStatus.get('awaiting_review') ?? 0,
      awaitingExecutor: byStatus.get('awaiting_executor') ?? 0,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { awaitingReview: 0, awaitingExecutor: 0, error: `captures summary unavailable: ${message}` };
  }
}
