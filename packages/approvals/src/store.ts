import type postgres from 'postgres';
import {
  ApprovalConflictError,
  type ApprovalListFilter,
  type ApprovalRecord,
  type ApprovalResolution,
  type ApprovalStatus,
} from '@jarvus/claude-assist-core';

interface Row {
  id: string;
  kind: string;
  requested_by: string;
  title: string;
  body: string;
  payload: Record<string, unknown> | string;
  status: ApprovalStatus;
  dedupe_key: string | null;
  resolution: ApprovalResolution | string | null;
  resolved_by: string | null;
  expires_at: Date;
  created_at: Date;
  resolved_at: Date | null;
}

/** postgres.js hands JSONB back as an object or, sometimes, as a string. */
function parseJson<T>(value: T | string | null): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value;
}

function toRecord(row: Row): ApprovalRecord {
  return {
    id: row.id,
    kind: row.kind,
    requestedBy: row.requested_by,
    title: row.title,
    body: row.body,
    payload: parseJson<Record<string, unknown>>(row.payload) ?? {},
    status: row.status,
    dedupeKey: row.dedupe_key,
    resolution: parseJson<ApprovalResolution>(row.resolution),
    resolvedBy: row.resolved_by,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
  };
}

export interface InsertInput {
  kind: string;
  requestedBy: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  expiresAt: Date;
}

export interface InsertOutcome {
  record: ApprovalRecord;
  /** False when an existing pending row with the same dedupe key was returned. */
  created: boolean;
}

export class ApprovalStore {
  constructor(private readonly sql: postgres.Sql) {}

  /**
   * Insert, or return the existing pending row for this dedupe key.
   *
   * `ON CONFLICT DO NOTHING` against the partial unique index is what makes
   * this race-free — two workers hitting the same wall at the same instant
   * produce one row and one notification, not two.
   */
  async insert(input: InsertInput): Promise<InsertOutcome> {
    const rows = await this.sql<Row[]>`
      INSERT INTO approvals.requests
        (kind, requested_by, title, body, payload, dedupe_key, expires_at)
      VALUES
        (${input.kind}, ${input.requestedBy}, ${input.title}, ${input.body},
         ${input.payload as never}, ${input.dedupeKey}, ${input.expiresAt})
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    const inserted = rows[0];
    if (inserted) return { record: toRecord(inserted), created: true };

    const existing = await this.sql<Row[]>`
      SELECT * FROM approvals.requests
      WHERE dedupe_key = ${input.dedupeKey} AND status = 'pending'
      LIMIT 1
    `;
    const row = existing[0];
    if (!row) {
      throw new Error('Approval insert conflicted but no pending row was found');
    }
    return { record: toRecord(row), created: false };
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    const rows = await this.sql<Row[]>`SELECT * FROM approvals.requests WHERE id = ${id}`;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(filter: ApprovalListFilter = {}): Promise<ApprovalRecord[]> {
    const { status, kind, limit = 100 } = filter;
    const rows = await this.sql<Row[]>`
      SELECT * FROM approvals.requests
      WHERE (${status ?? null}::text IS NULL OR status = ${status ?? null})
        AND (${kind ?? null}::text IS NULL OR kind = ${kind ?? null})
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(toRecord);
  }

  /**
   * Resolve a pending request.
   *
   * The `status = 'pending'` predicate is the concurrency control: a double
   * click, a retried webhook, and two people answering at once all lose the
   * race in the database rather than silently overwriting each other. A miss
   * is reported as a conflict, never as success.
   */
  async resolve(
    id: string,
    resolution: ApprovalResolution,
    resolvedBy?: string,
  ): Promise<ApprovalRecord> {
    const rows = await this.sql<Row[]>`
      UPDATE approvals.requests
      SET status = ${resolution.decision},
          resolution = ${resolution as never},
          resolved_by = ${resolvedBy ?? null},
          resolved_at = NOW()
      WHERE id = ${id} AND status = 'pending'
      RETURNING *
    `;
    const row = rows[0];
    if (row) return toRecord(row);

    const current = await this.get(id);
    if (!current) throw new ApprovalConflictError(id, 'cancelled');
    throw new ApprovalConflictError(id, current.status);
  }

  async findResolved(dedupeKey: string): Promise<ApprovalRecord | null> {
    const rows = await this.sql<Row[]>`
      SELECT * FROM approvals.requests
      WHERE dedupe_key = ${dedupeKey} AND status <> 'pending'
      ORDER BY resolved_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    `;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Age out overdue pending rows. Returns what it expired, for logging. */
  async expireOverdue(): Promise<ApprovalRecord[]> {
    const rows = await this.sql<Row[]>`
      UPDATE approvals.requests
      SET status = 'expired', resolved_at = NOW()
      WHERE status = 'pending' AND expires_at < NOW()
      RETURNING *
    `;
    return rows.map(toRecord);
  }
}
