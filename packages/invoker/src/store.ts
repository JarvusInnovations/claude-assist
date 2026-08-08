import type postgres from 'postgres';
import type { ModelTier, SpendTaskRow } from '@jarvus/claude-assist-core';

export interface InvocationRow {
  task: string;
  tier: ModelTier;
  model: string;
  attempt: number;
  outcome: 'succeeded' | 'failed';
  errorReason?: string;
  stopReason?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costMicros: number;
  durationMs: number;
}

export interface WindowTotals {
  calls: number;
  tokens: number;
  costMicros: number;
}

/**
 * The persistence seam for the spend ledger — narrow so a test can satisfy it
 * in memory, which is how the invoker is tested without a database.
 */
export interface SpendStorePort {
  record(row: InvocationRow): Promise<void>;
  totalsSince(since: Date): Promise<WindowTotals>;
  taskTotalsSince(since: Date): Promise<SpendTaskRow[]>;
}

export class SpendStore implements SpendStorePort {
  constructor(private readonly sql: postgres.Sql) {}

  async record(row: InvocationRow): Promise<void> {
    await this.sql`
      INSERT INTO invoker.invocations
        (task, tier, model, attempt, outcome, error_reason, stop_reason,
         input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
         cost_micros, duration_ms)
      VALUES
        (${row.task}, ${row.tier}, ${row.model}, ${row.attempt}, ${row.outcome},
         ${row.errorReason ?? null}, ${row.stopReason ?? null},
         ${row.inputTokens}, ${row.outputTokens}, ${row.cacheWriteTokens},
         ${row.cacheReadTokens}, ${row.costMicros}, ${row.durationMs})
    `;
  }

  async totalsSince(since: Date): Promise<WindowTotals> {
    const rows = await this.sql<{ calls: string; tokens: string; cost: string }[]>`
      SELECT COUNT(*) AS calls,
             COALESCE(SUM(input_tokens + output_tokens + cache_write_tokens + cache_read_tokens), 0) AS tokens,
             COALESCE(SUM(cost_micros), 0) AS cost
      FROM invoker.invocations
      WHERE ts >= ${since}
    `;
    const row = rows[0];
    return {
      calls: row ? parseInt(row.calls, 10) : 0,
      tokens: row ? parseInt(row.tokens, 10) : 0,
      costMicros: row ? parseInt(row.cost, 10) : 0,
    };
  }

  async taskTotalsSince(since: Date): Promise<SpendTaskRow[]> {
    const rows = await this.sql<{ task: string; calls: string; tokens: string; cost: string }[]>`
      SELECT task,
             COUNT(*) AS calls,
             COALESCE(SUM(input_tokens + output_tokens + cache_write_tokens + cache_read_tokens), 0) AS tokens,
             COALESCE(SUM(cost_micros), 0) AS cost
      FROM invoker.invocations
      WHERE ts >= ${since}
      GROUP BY task
      ORDER BY SUM(cost_micros) DESC
    `;
    return rows.map((row) => ({
      task: row.task,
      calls: parseInt(row.calls, 10),
      tokens: parseInt(row.tokens, 10),
      costUsd: parseInt(row.cost, 10) / 1_000_000,
    }));
  }
}
