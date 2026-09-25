import { createPlugin } from '@jarvus/claude-assist-core';
import { SyncService } from './sync.js';
import { OutlineService } from './outline.js';
import { TranscriptReader } from './transcript-reader.js';
import { ChunkBackfillService } from './chunk-backfill.js';
import { registerRoutes } from './routes.js';
import {
  ClassificationStore,
  ClassificationEventClassifier,
  ClassificationService,
  SynthesisService,
  lastWeekPeriod,
} from './classification/index.js';

/**
 * Sessions plugin for archiving Claude Code transcripts
 *
 * Provides:
 * - Local filesystem scanning for sessions
 * - Push endpoint for satellite machines
 * - Full-text search across all sessions
 * - Scheduled sync every 5 minutes
 * - AI-generated session outlines (when the model invoker is available)
 */
export default createPlugin('sessions', async (fastify, options) => {
  const config = options.sessionsConfig ?? {};

  // The single choke point for reading raw_transcript (specs/behaviors/
  // session-transcript-storage.md: "Readers take ranges"). Shared across the
  // route handlers, the outline sweep, and the classification pipeline.
  const transcriptReader = new TranscriptReader(fastify.sql);

  // Initialize sync service with optional path mapping for Docker
  // originalClaudeDir: The original path on host (e.g., /Users/<user>/.claude)
  // This allows the scanner to translate transcript paths when running in Docker
  const syncService = new SyncService(fastify.sql, fastify.log, {
    machineId: config.machineId,
    originalClaudeDir: config.originalClaudeDir,
    minFileSize: config.minFileSize,
    disableLocalIngest: config.disableLocalIngest,
    ignoreContentMarkers: config.ignoreContentMarkers,
    chunkMaxBytes: config.chunkMaxBytes,
    ingestBudgetBytes: config.ingestBudgetBytes,
  });

  // Initialize outline service (optional - requires the model invoker)
  let outlineService: OutlineService | null = null;
  if (fastify.invoker?.enabled) {
    outlineService = new OutlineService(fastify.sql, fastify.log, {
      invoker: fastify.invoker,
      concurrency: config.outlineConcurrency,
      disableGenerateOutlines: config.disableGenerateOutlines,
      windowConfig: {
        thresholdMessages: config.outlineWindowThresholdMessages,
        thresholdBytes: config.outlineWindowThresholdBytes,
        maxMessages: config.outlineWindowMaxMessages,
        maxBytes: config.outlineWindowMaxBytes,
        maxSpanMs: config.outlineWindowMaxSpanMs,
        sweepCap: config.outlineWindowSweepCap,
        maxAttempts: config.outlineWindowMaxAttempts,
      },
    });
    fastify.log.info('Outline service enabled');
  } else {
    fastify.log.warn('Model invoker unavailable - outline generation disabled');
  }

  // Initialize classification pipeline (optional - requires the model invoker).
  // Per-session incremental cursors → append-only classification events →
  // weekly synthesis + timeline narrative. The self-improvement loop.
  let classificationService: ClassificationService | null = null;
  let synthesisService: SynthesisService | null = null;
  let classificationStore: ClassificationStore | null = null;
  if (fastify.invoker?.enabled && !config.disableClassification) {
    classificationStore = new ClassificationStore(fastify.sql);
    const classifier = new ClassificationEventClassifier(
      { invoker: fastify.invoker },
      fastify.log
    );
    classificationService = new ClassificationService(
      classificationStore,
      classifier,
      transcriptReader,
      fastify.log,
      {
        concurrency: config.classificationConcurrency,
        minDelta: config.classificationMinDelta,
        lookback: config.classificationLookback,
      }
    );
    synthesisService = new SynthesisService(
      classificationStore,
      {
        invoker: fastify.invoker,
        ...(config.synthesisModel ? { model: config.synthesisModel } : {}),
      },
      fastify.log
    );
    fastify.log.info('Classification pipeline enabled');
  } else if (!fastify.invoker?.enabled) {
    fastify.log.warn('Model invoker unavailable - classification pipeline disabled');
  } else {
    fastify.log.info('Classification pipeline disabled via disableClassification config');
  }

  // Legacy-transcript chunk backfill (specs/behaviors/session-transcript-storage.md;
  // plans/transcript-chunk-backfill.md). Disabled by default
  // (SESSIONS_BACKFILL_ENABLED) — the operator turns it on deliberately, after
  // a fresh backup, since raw_transcript is the only remaining copy for
  // sessions whose file has already aged off disk.
  const backfillService = new ChunkBackfillService(fastify.sql, fastify.log, {
    runBudgetBytes: config.backfillRunBudgetBytes,
    sessionBudgetBytes: config.backfillSessionBudgetBytes,
    chunkMaxBytes: config.chunkMaxBytes,
  });

  // Register API routes
  await fastify.register(registerRoutes, {
    syncService,
    outlineService,
    reader: transcriptReader,
    backfillService,
    classificationService,
    synthesisService,
    classificationStore,
  });

  // One-shot backfill for sessions ingested before context columns existed.
  // Idempotent: each row is stamped, so after the first pass this is a no-op
  // query per boot. Runs off the schedule so it never blocks startup.
  fastify.scheduler.register({
    name: 'sessions:backfill-context',
    schedule: '23 4 * * *',
    runOnStartup: true,
    handler: async () => {
      const result = await syncService.backfillContextWindow();
      if (result.scanned > 0) {
        fastify.log.info({ result }, `Context backfill: ${result.measured}/${result.scanned} measured`);
      }
    },
  });

  // Nightly full verification (specs/behaviors/session-transcript-storage.md):
  // streamed, one chunk in memory at a time, over locally-ingested chunked
  // sessions active in the last day. A mismatch triggers a full re-ingest —
  // the same repair a per-cycle continuity failure performs.
  fastify.scheduler.register({
    name: 'sessions:verify-chunks',
    schedule: '17 3 * * *',
    runOnStartup: false,
    handler: async () => {
      const result = await syncService.verifyRecentSessions();
      if (result.mismatches > 0) {
        fastify.log.warn({ result }, `Nightly verification: ${result.mismatches}/${result.checked} sessions re-ingested`);
      } else {
        fastify.log.info({ result }, `Nightly verification: ${result.checked} sessions clean`);
      }
    },
  });

  // Legacy-transcript chunk backfill sweep — disabled by default (see the
  // service construction above). `runOnStartup: true` mirrors sync-local: by
  // the time this flag is on, the operator has already decided this instance
  // should be converting rows, so the first tick doesn't wait for the cron.
  if (config.backfillEnabled) {
    fastify.scheduler.register({
      name: 'sessions:backfill-chunks',
      schedule: config.backfillCron ?? '*/10 * * * *',
      runOnStartup: true,
      handler: async () => {
        const result = await backfillService.runOnce();
        if (result.sessionsConsidered > 0) {
          fastify.log.info(
            { result: { ...result, details: undefined } },
            `Chunk backfill: ${result.sessionsFlipped} converted, ${result.sessionsProgressed} progressed, ${result.sessionsFailed} failed, ${result.sessionsSkipped} skipped`
          );
        }
      },
    });
    fastify.log.info('Chunk backfill sweep scheduled (SESSIONS_BACKFILL_ENABLED=true)');
  }

  // Register scheduled sync task for localhost (unless disabled)
  if (!config.disableLocalIngest) {
    fastify.scheduler.register({
      name: 'sessions:sync-local',
      schedule: '*/5 * * * *',
      runOnStartup: true,
      handler: async () => {
        fastify.log.info('Running scheduled local session sync');
        const result = await syncService.syncLocal();
        fastify.log.info(
          { result },
          `Scheduled sync: ${result.sessionsIngested} new, ${result.sessionsUpdated} updated`
        );

        // Queue outline generation for newly ingested/updated sessions (async)
        if (
          outlineService &&
          (result.sessionsIngested > 0 || result.sessionsUpdated > 0)
        ) {
          outlineService.queueOutlineGeneration();
        }

        // Coverage heartbeat: localhost session ingest succeeded this cycle.
        await fastify.heartbeats?.beat('session-ingest:localhost', {
          threshold: '48 hours',
        });
      },
    });
    fastify.log.info(
      'Sessions plugin loaded with local sync scheduled every 5 minutes'
    );
  } else {
    fastify.log.info(
      'Sessions plugin loaded (local sync disabled via disableLocalIngest)'
    );
  }

  // Register hourly outline generation task (catch-all for any missed sessions)
  if (outlineService && !config.disableGenerateOutlines) {
    fastify.scheduler.register({
      name: 'sessions:generate-outlines',
      schedule: '0 * * * *', // Every hour at :00
      runOnStartup: false,
      handler: async () => {
        fastify.log.info('Running scheduled outline generation');
        outlineService.queueOutlineGeneration();
        // Coverage heartbeat: the outline pipeline ran this cycle.
        await fastify.heartbeats?.beat('outline', { threshold: '24 hours' });
      },
    });
  }

  // Classification sweep: delta-only classification of recent sessions.
  // Runs on a modest cadence (not every 5-min sync) to keep windows dense and
  // cost bounded; a short lookback means it never touches the session backlog.
  if (classificationService) {
    fastify.scheduler.register({
      name: 'sessions:classify',
      schedule: config.classificationCron ?? '*/30 * * * *', // every 30 minutes
      runOnStartup: false,
      handler: async () => {
        const result = await classificationService!.sweep();
        fastify.log.info({ result }, 'Classification sweep complete');
        // Coverage heartbeat: classification succeeded this cycle (absence pages).
        await fastify.heartbeats?.beat('session-classification', {
          threshold: '24 hours',
        });
      },
    });
    fastify.log.info('Classification sweep scheduled');
  }

  // Weekly synthesis + timeline narrative. Digests the week's events
  // into proposed changes + friction hotspots, and an evolution narrative;
  // both are persisted AND delivered via the notify digest.
  if (synthesisService) {
    fastify.scheduler.register({
      name: 'sessions:weekly-synthesis',
      schedule: config.synthesisCron ?? '0 13 * * 1', // Mondays ~09:00 ET
      runOnStartup: false,
      handler: async () => {
        const period = lastWeekPeriod();

        const synthesis = await synthesisService!.synthesizeWeek(period);
        await fastify.notify?.notify({
          priority: 'digest',
          title: `Weekly self-improvement synthesis (${period.startLabel} → ${period.endLabel})`,
          body:
            `${synthesis.eventCount} classification events.\n\n` +
            truncate(synthesis.report, 1500),
        });

        const narrative = await synthesisService!.narrateWeek(period);
        await fastify.notify?.notify({
          priority: 'digest',
          title: `Assistant weekly evolution narrative (${period.startLabel} → ${period.endLabel})`,
          body: truncate(narrative.narrative, 1500),
        });

        fastify.log.info(
          { eventCount: synthesis.eventCount, period: period.startLabel },
          'Weekly synthesis + narrative complete'
        );
        // Coverage heartbeat: the weekly synthesis ran (absence pages after ~8d).
        await fastify.heartbeats?.beat('session-synthesis', { threshold: '8 days' });
      },
    });
    fastify.log.info('Weekly synthesis scheduled');
  }
});

/** Trim a report to a digest-friendly length, keeping the head. */
function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + '\n…';
}

// Re-export types for external use
export * from './types.js';
export { SyncService } from './sync.js';
export { OutlineService } from './outline.js';
export { SessionScanner } from './scanner.js';
export { parseTranscript } from './parser.js';
export { serializeTranscript } from './transcript.js';
export { TranscriptReader } from './transcript-reader.js';
export { ChunkBackfillService } from './chunk-backfill.js';
export { normalizeProjectPaths } from './project-names.js';
export { registerPublicShareRoutes } from './share-routes.js';
export {
  DEFAULT_SESSION_IGNORE_MARKERS,
  matchesIgnoreMarker,
} from './ignore.js';
export * from './classification/index.js';
