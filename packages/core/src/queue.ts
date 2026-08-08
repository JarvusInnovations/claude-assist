/**
 * Lease-claimed background work.
 *
 * Spec: `specs/behaviors/scheduled-work-leases.md`.
 *
 * This is a helper *over an existing domain table*, not a queue table. The work
 * already lives in `capture.captures`, `kitchen.entries`, `google.emails`; a
 * separate queue table would mean writing the same row twice and keeping the
 * two in sync, which is a migration with no payoff. What those tables were
 * missing was never a place to put the work — it was an atomic claim, an
 * owner, an expiry, and a backoff.
 *
 * What it fixes, concretely: the selection queries these pipelines used were
 * plain `SELECT … WHERE status = … AND attempts < cap LIMIT n` with no row
 * locking, guarded by a process-local boolean. Two sweeps select the same rows
 * by construction, and the guard neither survives a restart nor is visible to a
 * second process.
 */

import type postgres from 'postgres';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function ident(value: string, what: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${what} for lease queue: ${value}`);
  }
  return `"${value}"`;
}

export interface LeaseQueueConfig {
  /** Postgres schema owning the table. */
  schema: string;
  table: string;
  /** Primary key column. Default `id`. */
  idColumn?: string;
  /** Column holding the workflow status. Default `status`. */
  statusColumn?: string;
  /** Status a row must be in to be claimable. */
  readyStatus: string;
  /** Status a claimed row is moved to. */
  runningStatus: string;
  /** Status a row lands in once its attempt cap is exhausted. */
  failedStatus: string;
  /** Status `complete()` sets. Default: caller passes it per call. */
  doneStatus?: string;
  attemptsColumn?: string;
  ownerColumn?: string;
  expiresColumn?: string;
  nextAttemptColumn?: string;
  errorColumn?: string;
  /** Terminal after this many attempts. Default 5. */
  maxAttempts?: number;
  /** Lease duration. Default 5 minutes. Keep it short and `renew()` long work. */
  leaseMs?: number;
  /** First retry delay; doubles per attempt. Default 30s. */
  backoffBaseMs?: number;
  /** Ceiling on the backoff. Default 1 hour. */
  backoffMaxMs?: number;
  /** ORDER BY fragment for the claim. Default `created_at ASC`. */
  orderBy?: string;
  /** Extra predicate on claimable rows (module-authored SQL, not user input). */
  where?: string;
  /**
   * Serialize by key: at most one in-flight row per distinct value of this
   * column, while `SKIP LOCKED` still gives full parallelism across keys.
   * Back it with a partial unique index over the running status.
   */
  serializeBy?: string;
  /** Columns `claim()` returns. Default: the id column only. */
  returning?: string[];
}

export interface LeaseClaim {
  id: string;
  attempts: number;
  [column: string]: unknown;
}

export interface LeaseFailureOutcome {
  id: string;
  attempts: number;
  status: string;
  /** True when the attempt cap sent the row terminal. */
  exhausted: boolean;
}

export interface LeaseQueue {
  /** Atomically take up to `limit` rows. Concurrent callers get disjoint sets. */
  claim(limit: number): Promise<LeaseClaim[]>;
  /** Extend the lease on rows still being worked. */
  renew(ids: string[]): Promise<number>;
  /** Mark a row finished; clears owner, expiry, backoff, and error. */
  complete(id: string, status?: string): Promise<void>;
  /**
   * Release a row after a failure: back to ready with a backed-off next
   * attempt, or terminal once the cap is reached.
   */
  fail(id: string, error: string): Promise<LeaseFailureOutcome | null>;
  /** Return expired leases to ready (or terminal at the cap). */
  reclaimExpired(): Promise<LeaseFailureOutcome[]>;
  readonly ownerId: string;
}

/** SQL for the exponential-backoff interval, in terms of the attempts column. */
function backoffInterval(attemptsCol: string, baseMs: number, maxMs: number): string {
  return `((LEAST(${maxMs}, ${baseMs} * POWER(2, GREATEST(${attemptsCol} - 1, 0)))::bigint)::text || ' milliseconds')::interval`;
}

export function createLeaseQueue(
  sql: postgres.Sql,
  config: LeaseQueueConfig,
  ownerId = `${process.env.HOSTNAME ?? 'host'}-${process.pid}`,
): LeaseQueue {
  const schema = ident(config.schema, 'schema');
  const table = ident(config.table, 'table');
  const rel = `${schema}.${table}`;
  const id = ident(config.idColumn ?? 'id', 'id column');
  const status = ident(config.statusColumn ?? 'status', 'status column');
  const attempts = ident(config.attemptsColumn ?? 'attempts', 'attempts column');
  const owner = ident(config.ownerColumn ?? 'lease_owner', 'owner column');
  const expires = ident(config.expiresColumn ?? 'lease_expires_at', 'expiry column');
  const nextAttempt = ident(config.nextAttemptColumn ?? 'next_attempt_at', 'next-attempt column');
  const errorCol = ident(config.errorColumn ?? 'last_error', 'error column');
  const maxAttempts = config.maxAttempts ?? 5;
  const leaseMs = config.leaseMs ?? 300_000;
  const backoff = backoffInterval(attempts, config.backoffBaseMs ?? 30_000, config.backoffMaxMs ?? 3_600_000);
  const orderBy = config.orderBy ?? 'created_at ASC';
  const serializeBy = config.serializeBy ? ident(config.serializeBy, 'serialization column') : null;
  const returning = [id, attempts, ...(config.returning ?? []).map((c) => ident(c, 'returned column'))];
  const returningList = Array.from(new Set(returning)).map((c) => `t.${c}`).join(', ');

  const serializeClause = serializeBy
    ? `AND NOT EXISTS (
           SELECT 1 FROM ${rel} a
           WHERE a.${serializeBy} = t.${serializeBy}
             AND a.${status} = $2
         )`
    : '';
  const extraWhere = config.where ? `AND (${config.where})` : '';

  const claimSql = `
    WITH claimable AS (
      SELECT t.${id}
      FROM ${rel} t
      WHERE t.${status} = $1
        AND t.${attempts} < ${maxAttempts}
        AND (t.${nextAttempt} IS NULL OR t.${nextAttempt} <= NOW())
        ${serializeClause}
        ${extraWhere}
      ORDER BY ${orderBy}
      FOR UPDATE OF t SKIP LOCKED
      LIMIT $3
    )
    UPDATE ${rel} t
    SET ${status} = $2,
        ${owner} = $4,
        ${expires} = NOW() + ((${leaseMs})::text || ' milliseconds')::interval,
        ${attempts} = t.${attempts} + 1
    FROM claimable c
    WHERE t.${id} = c.${id}
    RETURNING ${returningList}
  `;

  const releaseSql = (whereClause: string) => `
    UPDATE ${rel} t
    SET ${status} = CASE WHEN t.${attempts} >= ${maxAttempts} THEN $1 ELSE $2 END,
        ${owner} = NULL,
        ${expires} = NULL,
        ${nextAttempt} = CASE WHEN t.${attempts} >= ${maxAttempts} THEN NULL ELSE NOW() + ${backoff} END,
        ${errorCol} = $3
    WHERE ${whereClause}
    RETURNING t.${id} AS id, t.${attempts} AS attempts, t.${status} AS status
  `;

  return {
    ownerId,

    async claim(limit) {
      if (limit <= 0) return [];
      const rows = await sql.unsafe<LeaseClaim[]>(claimSql, [
        config.readyStatus,
        config.runningStatus,
        limit,
        ownerId,
      ]);
      return rows.map((row) => ({
        ...row,
        id: String((row as Record<string, unknown>)[config.idColumn ?? 'id']),
        attempts: Number((row as Record<string, unknown>)[config.attemptsColumn ?? 'attempts'] ?? 0),
      }));
    },

    async renew(ids) {
      if (ids.length === 0) return 0;
      const rows = await sql.unsafe<{ id: string }[]>(
        `UPDATE ${rel} t
         SET ${expires} = NOW() + ((${leaseMs})::text || ' milliseconds')::interval
         WHERE t.${id} = ANY($1) AND t.${owner} = $2 AND t.${status} = $3
         RETURNING t.${id} AS id`,
        [ids, ownerId, config.runningStatus],
      );
      return rows.length;
    },

    async complete(rowId, doneStatus) {
      const next = doneStatus ?? config.doneStatus;
      if (!next) {
        throw new Error('complete() needs a status: pass one or set doneStatus in the config');
      }
      await sql.unsafe(
        `UPDATE ${rel} t
         SET ${status} = $1, ${owner} = NULL, ${expires} = NULL,
             ${nextAttempt} = NULL, ${errorCol} = NULL
         WHERE t.${id} = $2`,
        [next, rowId],
      );
    },

    async fail(rowId, error) {
      const rows = await sql.unsafe<{ id: string; attempts: number; status: string }[]>(
        releaseSql(`t.${id} = $4`),
        [config.failedStatus, config.readyStatus, error.slice(0, 2000), rowId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: String(row.id),
        attempts: Number(row.attempts),
        status: row.status,
        exhausted: row.status === config.failedStatus,
      };
    },

    async reclaimExpired() {
      const rows = await sql.unsafe<{ id: string; attempts: number; status: string }[]>(
        releaseSql(`t.${status} = $4 AND t.${expires} IS NOT NULL AND t.${expires} < NOW()`),
        [config.failedStatus, config.readyStatus, 'lease expired', config.runningStatus],
      );
      return rows.map((row) => ({
        id: String(row.id),
        attempts: Number(row.attempts),
        status: row.status,
        exhausted: row.status === config.failedStatus,
      }));
    },
  };
}
