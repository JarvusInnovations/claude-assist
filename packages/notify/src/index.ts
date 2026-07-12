/**
 * Notify module — the single notification dispatcher + coverage-ledger registry.
 *
 * Provides:
 * - `fastify.notify`      — dispatch spine delivering through Pushover
 * - `fastify.heartbeats`  — pipeline heartbeat / coverage-ledger registry
 * - a daily staleness + host-health check that pages on absence of success
 * - internal HTTP routes (POST /notify, POST /heartbeat/:pipeline)
 *
 * All delivery lives behind `notify()`; no pipeline grows its own delivery code.
 */

import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import {
  createPlugin,
  type PluginOptions,
  type Scheduler,
  type NotifyPluginConfig,
} from '@jarvus/claude-assist-core';
import { createPushoverChannel } from './channels/pushover.js';
import { createDispatcher } from './dispatcher.js';
import { createHeartbeatRegistry } from './heartbeats.js';
import { runStalenessCheck } from './staleness.js';
import { registerNotifyRoutes } from './routes.js';

// Module augmentation for fastify decorators
declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
  }
}

const GIB = 1024 ** 3;

export default createPlugin('notify', async (fastify: FastifyInstance, options: PluginOptions) => {
  const config: NotifyPluginConfig = options.notifyConfig ?? {};

  // Channels — each optional; the module still logs + tracks heartbeats without them.
  const pushover =
    config.pushoverToken && config.pushoverUser
      ? createPushoverChannel({ token: config.pushoverToken, user: config.pushoverUser })
      : null;
  if (!pushover) {
    fastify.log.warn('Notify: PUSHOVER_TOKEN/USER not set — all notification delivery disabled');
  }

  const dispatcher = createDispatcher({
    sql: fastify.sql,
    log: fastify.log,
    pushover,
    ledger: fastify.ledger,
  });
  const heartbeats = createHeartbeatRegistry(fastify.sql);

  // Decorate so every other module can deliver / beat through the one spine.
  fastify.decorate('notify', dispatcher);
  fastify.decorate('heartbeats', heartbeats);

  await fastify.register(registerNotifyRoutes, { dispatcher, heartbeats });

  // --- Register the pipelines that already exist -----------------------------
  // Singleton pipelines register statically so they alert even before a first
  // beat; per-account / per-machine pipelines auto-register on their first beat
  // (email-sync:<account>, session-ingest:<machine>) with the thresholds below.
  await heartbeats.register({ name: 'outline', threshold: '24 hours' });
  await heartbeats.register({ name: 'triage', threshold: '6 hours' });

  // External coverage ledgers in the agent repo — read via filesystem path.
  // WHICH ledgers exist (names, thresholds, repo-relative paths) is instance
  // data, so it comes from config (NOTIFY_COVERAGE_LEDGERS) rather than code.
  const coverageLedgers = config.coverageLedgers ?? [];
  if (config.hariRepoPath && coverageLedgers.length > 0) {
    for (const ledger of coverageLedgers) {
      await heartbeats.register({
        name: ledger.name,
        threshold: ledger.threshold,
        source: 'manual',
        ledgerPath: ledger.path,
      });
    }
  } else if (coverageLedgers.length > 0) {
    fastify.log.warn('Notify: hariRepoPath not set — external coverage ledgers not registered');
  }

  // --- Daily staleness + host-health check -----------------------------------
  const diskCheckPath = config.diskCheckPath ?? '/';
  const diskMinFreeBytes = config.diskMinFreeBytes ?? 20 * GIB;
  const diskMinFreePct = config.diskMinFreePct ?? 0.08;

  if (!config.disableStalenessCheck) {
    fastify.scheduler.register({
      name: 'notify:staleness-check',
      schedule: config.stalenessCron ?? '0 13 * * *', // daily ~09:00 ET
      runOnStartup: false,
      handler: async () => {
        await runStalenessCheck({
          sql: fastify.sql,
          notify: dispatcher,
          log: fastify.log,
          hariRepoPath: config.hariRepoPath,
          diskCheckPath,
          diskMinFreeBytes,
          diskMinFreePct,
        });
      },
    });
  } else {
    fastify.log.info('Notify: staleness check disabled via config');
  }

  // --- Digest flush ----------------------------------------------------------
  fastify.scheduler.register({
    name: 'notify:digest-flush',
    schedule: config.digestFlushCron ?? '0 12,22 * * *', // twice daily
    runOnStartup: false,
    handler: async () => {
      await dispatcher.flushDigest();
    },
  });

  fastify.log.info('Notify module loaded (dispatcher + heartbeat registry)');
});

// Re-export the implementation surface for tests / external use.
export { createDispatcher, type Dispatcher, type DispatcherDeps } from './dispatcher.js';
export { createHeartbeatRegistry } from './heartbeats.js';
export {
  createPushoverChannel,
  type PushoverChannel,
  type PushoverConfig,
} from './channels/pushover.js';
export {
  runStalenessCheck,
  evaluateStaleness,
  evaluateDiskHealth,
  parseWatermarkDate,
  type StalenessLevel,
  type StalenessResult,
  type DiskHealthResult,
} from './staleness.js';
export { registerNotifyRoutes, type NotifyRoutesConfig } from './routes.js';
export {
  isSecretUrl,
  redactUrl,
  redactText,
  hashPayload,
} from './redact.js';
