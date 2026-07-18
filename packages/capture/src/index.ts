/**
 * Capture Module Plugin Entry Point
 *
 * The single dumb-fast entry point for the owner's stray thoughts, links, and
 * (future) diet entries:
 * - POST /api/capture: idempotent store-and-ack, zero decisions at capture
 * - Async classification sweep (Haiku, mirrors email triage patterns)
 * - Routing executors: tana-inbox (stray thoughts), references (links),
 *   review hold (actionable / team_relevant)
 *
 * FIREWALL: this module has NO HQ write path — team-relevant material only
 * ever parks in awaiting_review for the owner's explicit synthesis
 * (Hari specs/behaviors/personal-team-firewall.md).
 */

import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import {
  createPlugin,
  type PluginOptions,
  type Scheduler,
} from '@jarvus/claude-assist-core';
import { PgCaptureStore, PgReferenceStore } from './store.js';
import { CaptureClassifier } from './services/classifier.js';
import { CaptureRouter } from './services/router.js';
import { CapturePipeline } from './services/pipeline.js';
import { TanaMcpClient } from './services/tana-mcp.js';
import { TanaInboxExecutor } from './services/executors/tana-inbox.js';
import { ReferencesExecutor } from './services/executors/references.js';
import { HoldExecutor } from './services/executors/hold.js';
import { emitHeartbeat } from './services/heartbeat.js';
import { registerCaptureRoutes } from './routes/capture.js';

// Module augmentation for fastify decorators
declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
  }
}

export const CAPTURE_PIPELINE_NAME = 'capture-classification';

export default createPlugin('capture', async (fastify: FastifyInstance, options: PluginOptions) => {
  const config = options.captureConfig ?? {};

  const store = new PgCaptureStore(fastify.sql);
  const referenceStore = new PgReferenceStore(fastify.sql);

  // Classifier (optional - requires anthropicApiKey; without it only the
  // deterministic URL-only shortcut classifies, the rest queue up)
  let classifier: CaptureClassifier | null = null;
  if (config.anthropicApiKey) {
    classifier = new CaptureClassifier(
      { apiKey: config.anthropicApiKey, model: config.classifierModel },
      fastify.log
    );
    fastify.log.info('Capture classifier enabled');
  } else {
    fastify.log.warn('anthropicApiKey not set - capture classification limited to URL-only shortcut');
  }

  // Routing executors. The review hold and references executors are always
  // available; the Tana executor requires MCP config — without it,
  // stray-thought captures park in awaiting_executor (no attempts burned)
  // until the config lands and the sweep picks them back up.
  const router = new CaptureRouter(store, fastify.log);
  router.register(new HoldExecutor());
  router.register(new ReferencesExecutor(referenceStore));

  if (config.tanaMcpToken && config.tanaWorkspaceId) {
    const tanaClient = new TanaMcpClient({
      url: config.tanaMcpUrl ?? 'http://127.0.0.1:8262/mcp',
      token: config.tanaMcpToken,
    });
    router.register(new TanaInboxExecutor(tanaClient, config.tanaWorkspaceId));
  } else {
    fastify.log.warn(
      'TANA_MCP_TOKEN/TANA_WORKSPACE_ID not set - stray thoughts will park in awaiting_executor'
    );
  }

  const pipeline = new CapturePipeline(store, classifier, router, fastify.log, {
    concurrency: config.concurrency,
  });

  await fastify.register(registerCaptureRoutes, { pipeline, referenceStore });

  if (!config.disableClassification) {
    fastify.scheduler.register({
      name: 'capture:process',
      schedule: '* * * * *', // Every minute - capture should feel instant
      runOnStartup: true,
      handler: async () => {
        const result = await pipeline.sweep();
        const activity = Object.values(result).some((count) => count > 0);
        if (activity) {
          fastify.log.info({ result }, 'Capture sweep complete');
        }
        // Guarded no-op unless the notification-dispatcher's heartbeat
        // helper is present at merge time (see services/heartbeat.ts).
        await emitHeartbeat(fastify, CAPTURE_PIPELINE_NAME);
      },
    });
  } else {
    fastify.log.info('Capture classification sweep disabled via config');
  }
});

// Re-exports for clients (chat sigil path, CLI, tests, future modules)
export * from './types.js';
export { generateUlid, ulidFromSeed, isValidUlid, ULID_PATTERN } from './ulid.js';
export { matchCaptureSigil } from './sigil.js';
export { ROUTING_TABLE, transition, destinationFor, InvalidTransitionError } from './state.js';
export type { CaptureStore, ReferenceStore, NewCapture } from './store.js';
export { PgCaptureStore, PgReferenceStore, normalizeInput } from './store.js';
export { MemoryCaptureStore, MemoryReferenceStore } from './memory-store.js';
export { CapturePipeline, type SweepResult } from './services/pipeline.js';
export { CaptureRouter, type RoutingExecutor } from './services/router.js';
export { CaptureClassifier, deterministicClassification, collectUrls } from './services/classifier.js';
export { TanaMcpClient, parseMcpBody } from './services/tana-mcp.js';
export { TanaInboxExecutor, formatTanaPaste } from './services/executors/tana-inbox.js';
export { ReferencesExecutor, extractNotes } from './services/executors/references.js';
export { HoldExecutor } from './services/executors/hold.js';
export { registerCaptureRoutes, type CaptureRoutesConfig } from './routes/capture.js';
export { emitHeartbeat } from './services/heartbeat.js';
