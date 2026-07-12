/**
 * Persistence for the ledger.
 *
 * `LedgerStore` wraps the shared Postgres connection and implements both the
 * derivation-facing surface (`DerivationStore`) and the direct-write + query
 * surface. Derivation orchestration (derivation.ts) depends only on the narrow
 * `DerivationStore` interface, so it can be unit-tested against an in-memory
 * fake without a database.
 */

import type postgres from 'postgres';
import type { LedgerRecordInput } from '@jarvus/claude-assist-core';
import type { DerivedActionRecord, ToolCallRow } from './rules.js';

/** The narrow surface the derivation job needs. */
export interface DerivationStore {
  /** Current derivation cursor, or null when nothing has been derived yet. */
  getState(): Promise<{ rulesVersion: string; lastToolCallId: number } | null>;
  /** Upsert the singleton cursor. */
  setState(rulesVersion: string, lastToolCallId: number): Promise<void>;
  /** Fetch the next batch of tool calls with id greater than `afterId`. */
  fetchToolCallsAfter(afterId: number, limit: number): Promise<ToolCallRow[]>;
  /** Insert derived rows idempotently; returns how many were actually inserted. */
  insertDerived(records: DerivedActionRecord[]): Promise<number>;
  /** Delete all derived rows (direct rows are never touched); returns the count. */
  deleteDerived(): Promise<number>;
}

/** Filters for the query surface. */
export interface ActionQuery {
  since?: string;
  until?: string;
  type?: string;
  source?: 'derived' | 'direct';
  /** Matches actor kind or service. */
  actor?: string;
  limit?: number;
}

export interface ActionRow {
  id: string;
  ts: string;
  actor: Record<string, unknown>;
  action_type: string;
  target_system: string;
  target_id: string | null;
  summary: string;
  context: Record<string, unknown>;
  source: string;
  rules_version: string | null;
  created_at: string;
}

export interface SummaryRow {
  day: string;
  action_type: string;
  count: number;
}

export class LedgerStore implements DerivationStore {
  constructor(private readonly sql: postgres.Sql) {}

  async getState(): Promise<{ rulesVersion: string; lastToolCallId: number } | null> {
    const rows = await this.sql<{ rules_version: string; last_tool_call_id: string }[]>`
      SELECT rules_version, last_tool_call_id
      FROM ledger.derivation_state
      WHERE id = 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      rulesVersion: row.rules_version,
      lastToolCallId: Number(row.last_tool_call_id),
    };
  }

  async setState(rulesVersion: string, lastToolCallId: number): Promise<void> {
    await this.sql`
      INSERT INTO ledger.derivation_state (id, rules_version, last_tool_call_id, updated_at)
      VALUES (1, ${rulesVersion}, ${lastToolCallId}, NOW())
      ON CONFLICT (id) DO UPDATE SET
        rules_version = EXCLUDED.rules_version,
        last_tool_call_id = EXCLUDED.last_tool_call_id,
        updated_at = NOW()
    `;
  }

  async fetchToolCallsAfter(afterId: number, limit: number): Promise<ToolCallRow[]> {
    return this.sql<ToolCallRow[]>`
      SELECT id, session_id::text AS session_id, msg_uuid, msg_index, ts,
             tool_name, target, is_sidechain
      FROM sessions.tool_calls
      WHERE id > ${afterId}
      ORDER BY id ASC
      LIMIT ${limit}
    `;
  }

  async insertDerived(records: DerivedActionRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    const sql = this.sql;
    let inserted = 0;
    // Each row is inserted idempotently via the unique (tool_call_id,
    // rules_version) index; no surrounding transaction is needed — a partial
    // batch simply resumes from the cursor on the next pass.
    for (const r of records) {
      const rows = await sql<{ id: string }[]>`
        INSERT INTO ledger.actions
          (ts, actor, action_type, target_system, target_id, summary, context, source, rules_version)
        VALUES (
          COALESCE(${r.ts as never}::timestamptz, NOW()),
          ${sql.json(r.actor as never)},
          ${r.actionType},
          ${r.targetSystem},
          ${r.targetId},
          ${r.summary},
          ${sql.json(r.context as never)},
          'derived',
          ${r.rulesVersion}
        )
        ON CONFLICT ((context ->> 'tool_call_id'), rules_version)
          WHERE source = 'derived'
        DO NOTHING
        RETURNING id
      `;
      inserted += rows.length;
    }
    return inserted;
  }

  async deleteDerived(): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM ledger.actions WHERE source = 'derived' RETURNING id
    `;
    return rows.length;
  }

  /** Direct write — a service records an action it performed at execution time. */
  async recordDirect(input: LedgerRecordInput): Promise<{ id: number }> {
    const actor = {
      kind: input.actor.kind,
      ...(input.actor.sessionId !== undefined ? { session_id: input.actor.sessionId } : {}),
      ...(input.actor.sidechain !== undefined ? { sidechain: input.actor.sidechain } : {}),
      ...(input.actor.service !== undefined ? { service: input.actor.service } : {}),
    };
    const rows = await this.sql<{ id: string }[]>`
      INSERT INTO ledger.actions
        (ts, actor, action_type, target_system, target_id, summary, context, source, rules_version)
      VALUES (
        COALESCE(${(input.ts ?? null) as never}::timestamptz, NOW()),
        ${this.sql.json(actor as never)},
        ${input.actionType},
        ${input.targetSystem},
        ${input.targetId ?? null},
        ${input.summary},
        ${this.sql.json((input.context ?? {}) as never)},
        'direct',
        NULL
      )
      RETURNING id
    `;
    return { id: Number(rows[0]!.id) };
  }

  /** List actions newest-first across both sources, with optional filters. */
  async queryActions(q: ActionQuery): Promise<ActionRow[]> {
    const sql = this.sql;
    const limit = Math.min(q.limit ?? 200, 1000);
    return sql<ActionRow[]>`
      SELECT id, ts, actor, action_type, target_system, target_id, summary,
             context, source, rules_version, created_at
      FROM ledger.actions
      WHERE 1 = 1
        ${q.since ? sql`AND ts >= ${q.since}` : sql``}
        ${q.until ? sql`AND ts < ${q.until}` : sql``}
        ${q.type ? sql`AND action_type = ${q.type}` : sql``}
        ${q.source ? sql`AND source = ${q.source}` : sql``}
        ${
          q.actor
            ? sql`AND (actor ->> 'kind' = ${q.actor} OR actor ->> 'service' = ${q.actor})`
            : sql``
        }
      ORDER BY ts DESC, id DESC
      LIMIT ${limit}
    `;
  }

  /** Counts by action type per day — the substrate for narrative rendering. */
  async summarize(q: ActionQuery): Promise<SummaryRow[]> {
    const sql = this.sql;
    return sql<SummaryRow[]>`
      SELECT date_trunc('day', ts)::date::text AS day,
             action_type,
             COUNT(*)::int AS count
      FROM ledger.actions
      WHERE 1 = 1
        ${q.since ? sql`AND ts >= ${q.since}` : sql``}
        ${q.until ? sql`AND ts < ${q.until}` : sql``}
        ${q.source ? sql`AND source = ${q.source}` : sql``}
      GROUP BY day, action_type
      ORDER BY day DESC, action_type ASC
    `;
  }
}
