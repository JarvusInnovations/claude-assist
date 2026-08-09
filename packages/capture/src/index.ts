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
 * (per the owner's private personal↔team firewall spec).
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
import { KitchenEventExecutor } from './services/executors/kitchen-event.js';
import { emitHeartbeat } from './services/heartbeat.js';
import { registerCaptureRoutes } from './routes/capture.js';
import type { AttachmentStorage } from './services/attachments/storage.js';
import { GcsAttachmentStorage } from './services/attachments/storage-gcs.js';

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

  // Attachment object store (optional). Configured only when a bucket is set;
  // credentials come from Google Application Default Credentials. Without it,
  // the sign endpoint 503s and attachment-bearing captures are rejected —
  // plain captures are unaffected.
  let attachmentStorage: AttachmentStorage | null = null;
  if (config.attachmentsBucket) {
    attachmentStorage = new GcsAttachmentStorage({ bucket: config.attachmentsBucket });
    fastify.log.info(
      { bucket: config.attachmentsBucket },
      'Capture attachment storage enabled'
    );
  } else {
    fastify.log.warn(
      'CAPTURE_ATTACHMENTS_BUCKET not set - capture attachments disabled'
    );
  }

  // Classifier (optional — needs the model invoker; without it only the
  // deterministic URL-only shortcut classifies, the rest queue up)
  let classifier: CaptureClassifier | null = null;
  if (fastify.invoker?.enabled) {
    classifier = new CaptureClassifier(
      {
        invoker: fastify.invoker,
        ...(config.classifierModel ? { model: config.classifierModel } : {}),
      },
      fastify.log
    );
    fastify.log.info('Capture classifier enabled');
  } else {
    fastify.log.warn(
      'Model invoker unavailable — capture classification limited to the URL-only shortcut'
    );
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
    router.register(
      new TanaInboxExecutor(tanaClient, config.tanaWorkspaceId, attachmentStorage)
    );
  } else {
    fastify.log.warn(
      'TANA_MCP_TOKEN/TANA_WORKSPACE_ID not set - stray thoughts will park in awaiting_executor'
    );
  }

  // Kitchen-event executor (phase-2 ambient-remark seam). The resolver is
  // composed by the server from the kitchen module's decorated surface; without
  // it, kitchen_event captures park in awaiting_executor until it lands.
  if (config.kitchenEventResolver) {
    router.register(new KitchenEventExecutor(config.kitchenEventResolver));
  } else {
    fastify.log.warn(
      'kitchenEventResolver not configured - kitchen_event captures will park in awaiting_executor'
    );
  }

  const pipeline = new CapturePipeline(store, classifier, router, fastify.log, {
    concurrency: config.concurrency,
    storage: attachmentStorage,
  });

  await fastify.register(registerCaptureRoutes, {
    pipeline,
    referenceStore,
    storage: attachmentStorage,
  });

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
export { TanaInboxExecutor, formatTanaPaste, type AttachmentLink } from './services/executors/tana-inbox.js';
export {
  type AttachmentStorage,
  type SignUploadParams,
  buildObjectKey,
  objectKeyPrefix,
  sanitizeFilename,
  SIGNED_URL_TTL_MS,
} from './services/attachments/storage.js';
export { GcsAttachmentStorage } from './services/attachments/storage-gcs.js';
export { MemoryAttachmentStorage } from './services/attachments/storage-memory.js';
export {
  AttachmentStorageUnconfiguredError,
  AttachmentVerificationError,
  AttachmentKeyMismatchError,
} from './services/attachments/errors.js';
export { ReferencesExecutor, extractNotes } from './services/executors/references.js';
export { HoldExecutor } from './services/executors/hold.js';
export { KitchenEventExecutor } from './services/executors/kitchen-event.js';
export { registerCaptureRoutes, type CaptureRoutesConfig } from './routes/capture.js';
export { emitHeartbeat } from './services/heartbeat.js';
