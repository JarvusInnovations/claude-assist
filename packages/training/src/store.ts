/**
 * Persistence for generated week plans.
 *
 * The port is narrow on purpose — the runner's whole approval dance is tested
 * against the in-memory implementation (memory-store.ts), the same way every
 * other DB-backed service in this repo stays testable without a live Postgres.
 */

import type postgres from 'postgres';
import type { PlanInputs, PlannedSession, WeekPlan, WeekPlanStatus } from './types.js';

export interface NewWeekPlan {
  weekStart: string;
  summary: string;
  rationale: string;
  adjustments: string[];
  sessions: PlannedSession[];
  inputs: PlanInputs;
  model: string | null;
  approvalKey: string | null;
}

export interface WeekPlanStore {
  /** Insert a `proposed` plan. Returns null when one is already pending for the week. */
  insertProposed(input: NewWeekPlan): Promise<WeekPlan | null>;
  /** The single `active` plan whose week contains `dateIso`, if any. */
  activeForDate(dateIso: string): Promise<WeekPlan | null>;
  /** The plan for a week in a given status. */
  byWeek(weekStart: string, status?: WeekPlanStatus): Promise<WeekPlan | null>;
  /** Every plan still awaiting a human. */
  listProposed(): Promise<WeekPlan[]>;
  /** Most recent plans, any status. */
  list(limit: number): Promise<WeekPlan[]>;
  /** Attach the approval this plan is gated on. */
  attachApproval(id: string, approvalId: string): Promise<void>;
  /**
   * Approve: the plan becomes `active` and any previously active plan for the
   * same week is superseded — in one transaction, because the partial unique
   * index makes a two-step version a real race rather than a theoretical one.
   */
  activate(id: string): Promise<WeekPlan | null>;
  /** Terminal resolution that is not activation (`rejected` / `expired`). */
  close(id: string, status: Extract<WeekPlanStatus, 'rejected' | 'expired'>): Promise<void>;
}

interface Row {
  id: string;
  week_start: string;
  status: WeekPlanStatus;
  summary: string;
  rationale: string;
  adjustments: unknown;
  sessions: unknown;
  inputs: unknown;
  approval_id: string | null;
  approval_key: string | null;
  model: string | null;
  generated_at: Date;
  resolved_at: Date | null;
}

function toPlan(row: Row): WeekPlan {
  return {
    id: row.id,
    // `week_start` is a DATE; the driver may hand back a Date or a string.
    weekStart: typeof row.week_start === 'string' ? row.week_start : isoDate(row.week_start),
    status: row.status,
    summary: row.summary,
    rationale: row.rationale,
    adjustments: asArray<string>(row.adjustments),
    sessions: asArray<PlannedSession>(row.sessions),
    inputs: (row.inputs ?? {}) as PlanInputs,
    approvalId: row.approval_id,
    approvalKey: row.approval_key,
    model: row.model,
    generatedAt: row.generated_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
  };
}

function isoDate(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

const COLUMNS = `id, week_start::text AS week_start, status, summary, rationale,
                 adjustments, sessions, inputs, approval_id, approval_key, model,
                 generated_at, resolved_at`;

export class PgWeekPlanStore implements WeekPlanStore {
  constructor(private readonly sql: postgres.Sql) {}

  async insertProposed(input: NewWeekPlan): Promise<WeekPlan | null> {
    const rows = await this.sql<Row[]>`
      INSERT INTO training.week_plans
        (week_start, status, summary, rationale, adjustments, sessions, inputs, model, approval_key)
      VALUES (
        ${input.weekStart}::date, 'proposed', ${input.summary}, ${input.rationale},
        ${this.sql.json(input.adjustments)}, ${this.sql.json(input.sessions as never)},
        ${this.sql.json(input.inputs as never)}, ${input.model}, ${input.approvalKey}
      )
      ON CONFLICT DO NOTHING
      RETURNING id, week_start::text AS week_start, status, summary, rationale,
                adjustments, sessions, inputs, approval_id, approval_key, model,
                generated_at, resolved_at
    `;
    return rows[0] ? toPlan(rows[0]) : null;
  }

  async activeForDate(dateIso: string): Promise<WeekPlan | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)}
      FROM training.week_plans
      WHERE status = 'active'
        AND week_start <= ${dateIso}::date
        AND week_start + 6 >= ${dateIso}::date
      ORDER BY week_start DESC
      LIMIT 1
    `;
    return rows[0] ? toPlan(rows[0]) : null;
  }

  async byWeek(weekStart: string, status?: WeekPlanStatus): Promise<WeekPlan | null> {
    const rows = status
      ? await this.sql<Row[]>`
          SELECT ${this.sql.unsafe(COLUMNS)} FROM training.week_plans
          WHERE week_start = ${weekStart}::date AND status = ${status}
          ORDER BY generated_at DESC LIMIT 1
        `
      : await this.sql<Row[]>`
          SELECT ${this.sql.unsafe(COLUMNS)} FROM training.week_plans
          WHERE week_start = ${weekStart}::date
          ORDER BY generated_at DESC LIMIT 1
        `;
    return rows[0] ? toPlan(rows[0]) : null;
  }

  async listProposed(): Promise<WeekPlan[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM training.week_plans
      WHERE status = 'proposed' ORDER BY generated_at ASC
    `;
    return rows.map(toPlan);
  }

  async list(limit: number): Promise<WeekPlan[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM training.week_plans
      ORDER BY week_start DESC, generated_at DESC
      LIMIT ${Math.max(1, Math.min(limit, 200))}
    `;
    return rows.map(toPlan);
  }

  async attachApproval(id: string, approvalId: string): Promise<void> {
    await this.sql`
      UPDATE training.week_plans
      SET approval_id = ${approvalId}, updated_at = NOW()
      WHERE id = ${id}::uuid
    `;
  }

  async activate(id: string): Promise<WeekPlan | null> {
    return this.sql.begin(async (rawTx) => {
      // postgres.js's TransactionSql type drops the tagged-template call
      // signature (a TS/Omit limitation) even though it's present at runtime —
      // the same cast kitchen's inventory-store and pages' store use.
      const tx = rawTx as unknown as postgres.Sql;
      const [target] = await tx<Row[]>`
        SELECT ${tx.unsafe(COLUMNS)} FROM training.week_plans
        WHERE id = ${id}::uuid AND status = 'proposed'
        FOR UPDATE
      `;
      if (!target) return null;
      await tx`
        UPDATE training.week_plans
        SET status = 'superseded', updated_at = NOW()
        WHERE week_start = ${target.week_start}::date AND status = 'active'
      `;
      const [updated] = await tx<Row[]>`
        UPDATE training.week_plans
        SET status = 'active', resolved_at = NOW(), updated_at = NOW()
        WHERE id = ${id}::uuid
        RETURNING ${tx.unsafe(COLUMNS)}
      `;
      return updated ? toPlan(updated) : null;
    }) as Promise<WeekPlan | null>;
  }

  async close(id: string, status: 'rejected' | 'expired'): Promise<void> {
    await this.sql`
      UPDATE training.week_plans
      SET status = ${status}, resolved_at = NOW(), updated_at = NOW()
      WHERE id = ${id}::uuid AND status = 'proposed'
    `;
  }
}
