/**
 * Coverage-ledger registry, backed by notify.pipeline_heartbeats.
 *
 * `register()` declares a pipeline + staleness threshold (and, for external
 * ledgers, a `manual` source pointing at a file in the agent repo). `beat()`
 * records a successful run and auto-registers a not-yet-known pipeline so
 * per-account / per-machine names track without being pre-listed. The daily
 * monitor reads `list()`.
 */

import type postgres from 'postgres';
import type {
  HeartbeatRegistry,
  HeartbeatRegistration,
  HeartbeatOptions,
  HeartbeatRow,
} from '@jarvus/claude-assist-core';

/** Threshold used when `beat()` auto-registers a pipeline with no explicit one. */
const DEFAULT_BEAT_THRESHOLD = '24 hours';

export function createHeartbeatRegistry(sql: postgres.Sql): HeartbeatRegistry {
  async function register(reg: HeartbeatRegistration): Promise<void> {
    const source = reg.source ?? 'heartbeat';
    await sql`
      INSERT INTO notify.pipeline_heartbeats
        (name, threshold_interval, source, ledger_path, metadata, updated_at)
      VALUES (
        ${reg.name},
        ${reg.threshold}::interval,
        ${source},
        ${reg.ledgerPath ?? null},
        ${sql.json((reg.metadata ?? {}) as Record<string, unknown> as never)},
        NOW()
      )
      ON CONFLICT (name) DO UPDATE SET
        threshold_interval = EXCLUDED.threshold_interval,
        source = EXCLUDED.source,
        ledger_path = EXCLUDED.ledger_path,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `;
  }

  async function beat(name: string, opts: HeartbeatOptions = {}): Promise<void> {
    const threshold = opts.threshold ?? DEFAULT_BEAT_THRESHOLD;
    const source = opts.source ?? 'heartbeat';
    // First beat inserts (registering the pipeline); later beats only advance
    // last_success_at and keep the originally-registered threshold/metadata.
    await sql`
      INSERT INTO notify.pipeline_heartbeats
        (name, last_success_at, threshold_interval, source, ledger_path, metadata, updated_at)
      VALUES (
        ${name},
        NOW(),
        ${threshold}::interval,
        ${source},
        ${opts.ledgerPath ?? null},
        ${sql.json((opts.metadata ?? {}) as Record<string, unknown> as never)},
        NOW()
      )
      ON CONFLICT (name) DO UPDATE SET
        last_success_at = NOW(),
        updated_at = NOW()
    `;
  }

  async function list(): Promise<HeartbeatRow[]> {
    return sql<HeartbeatRow[]>`
      SELECT name, last_success_at, threshold_interval, source, ledger_path,
             metadata, created_at, updated_at
      FROM notify.pipeline_heartbeats
      ORDER BY name
    `;
  }

  return { register, beat, list };
}
