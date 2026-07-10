/**
 * Guarded pipeline-heartbeat helper.
 *
 * The notification-dispatcher work (separate branch) introduces
 * `pipeline_heartbeats` and is expected to decorate the Fastify instance
 * with a `heartbeat(pipeline)` function. This module calls it IF it exists
 * and is a silent no-op otherwise, so the capture service neither depends
 * on that branch nor breaks without it.
 *
 * Merge-time wire-up: once both branches are merged, verify the dispatcher
 * exposes `fastify.heartbeat` (or adapt this helper to its actual API) so
 * `capture-classification` staleness pages Chris per the
 * every-pipeline-has-a-watermark principle.
 */

import type { FastifyInstance } from 'fastify';

export async function emitHeartbeat(fastify: FastifyInstance, pipeline: string): Promise<void> {
  const registry = (fastify as unknown as { heartbeats?: { beat?: unknown } }).heartbeats;
  if (!registry || typeof registry.beat !== 'function') return;
  try {
    await (registry.beat as (pipeline: string) => Promise<void>).call(registry, pipeline);
  } catch (error) {
    fastify.log.warn({ pipeline, error }, 'Heartbeat emit failed (non-fatal)');
  }
}
