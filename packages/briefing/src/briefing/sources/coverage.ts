/**
 * Coverage-staleness + pipeline-health summary for the briefing.
 *
 * Reads the notify module's heartbeat registry (notify.pipeline_heartbeats) —
 * the same ledger the daily staleness monitor watches — and reports which
 * pipelines are behind their declared threshold. This is a read of the shared
 * registry, not a second staleness system: the monitor still pages; the
 * briefing just makes the state visible each morning. Degrades to omission if
 * the notify schema is absent.
 */

import type postgres from 'postgres';

export interface PipelineHealth {
  name: string;
  /** Age of last success in hours, or null if never succeeded. */
  ageHours: number | null;
  thresholdHours: number;
  ratio: number;
  stale: boolean;
}

export interface CoverageSummary {
  pipelines: PipelineHealth[];
  staleCount: number;
  error: string | null;
}

interface HeartbeatRow {
  name: string;
  last_success_at: Date | null;
  created_at: Date;
  threshold_seconds: string;
}

export async function fetchCoverageSummary(
  sql: postgres.Sql,
  nowMs: number = Date.now()
): Promise<CoverageSummary> {
  try {
    const rows = await sql<HeartbeatRow[]>`
      SELECT name, last_success_at, created_at,
             EXTRACT(EPOCH FROM threshold_interval)::text AS threshold_seconds
      FROM notify.pipeline_heartbeats
      ORDER BY name
    `;

    const pipelines: PipelineHealth[] = rows.map((row) => {
      const thresholdMs = Number(row.threshold_seconds) * 1000;
      const effective = (row.last_success_at ?? row.created_at).getTime();
      const ageMs = nowMs - effective;
      const ratio = thresholdMs > 0 ? ageMs / thresholdMs : Infinity;
      return {
        name: row.name,
        ageHours: row.last_success_at ? ageMs / 3_600_000 : null,
        thresholdHours: thresholdMs / 3_600_000,
        ratio,
        stale: ratio > 1,
      };
    });

    return {
      pipelines,
      staleCount: pipelines.filter((p) => p.stale).length,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { pipelines: [], staleCount: 0, error: `coverage summary unavailable: ${message}` };
  }
}
