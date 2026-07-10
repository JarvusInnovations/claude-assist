import { createPlugin } from '@jarvus/claude-assist-core';
import { SyncService } from './sync.js';
import { OutlineService } from './outline.js';
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
 * - AI-generated session outlines (if anthropicApiKey is provided)
 */
export default createPlugin('sessions', async (fastify, options) => {
  const config = options.sessionsConfig ?? {};

  // Initialize sync service with optional path mapping for Docker
  // originalClaudeDir: The original path on host (e.g., /Users/chris/.claude)
  // This allows the scanner to translate transcript paths when running in Docker
  const syncService = new SyncService(fastify.sql, fastify.log, {
    originalClaudeDir: config.originalClaudeDir,
    minFileSize: config.minFileSize,
    disableLocalIngest: config.disableLocalIngest,
    ignoreContentMarkers: config.ignoreContentMarkers,
  });

  // Initialize outline service (optional - requires anthropicApiKey)
  let outlineService: OutlineService | null = null;
  if (config.anthropicApiKey) {
    outlineService = new OutlineService(fastify.sql, fastify.log, {
      apiKey: config.anthropicApiKey,
      concurrency: config.outlineConcurrency,
      disableGenerateOutlines: config.disableGenerateOutlines,
    });
    fastify.log.info('Outline service enabled');
  } else {
    fastify.log.warn('anthropicApiKey not set - outline generation disabled');
  }

  // Initialize classification pipeline (optional - requires anthropicApiKey).
  // Per-session incremental cursors → append-only Haiku classification events →
  // weekly Sonnet synthesis + timeline narrative. The self-improvement loop.
  let classificationService: ClassificationService | null = null;
  let synthesisService: SynthesisService | null = null;
  let classificationStore: ClassificationStore | null = null;
  if (config.anthropicApiKey && !config.disableClassification) {
    classificationStore = new ClassificationStore(fastify.sql);
    const classifier = new ClassificationEventClassifier(
      { apiKey: config.anthropicApiKey },
      fastify.log
    );
    classificationService = new ClassificationService(
      classificationStore,
      classifier,
      fastify.log,
      {
        concurrency: config.classificationConcurrency,
        minDelta: config.classificationMinDelta,
        lookback: config.classificationLookback,
      }
    );
    synthesisService = new SynthesisService(
      classificationStore,
      { apiKey: config.anthropicApiKey, model: config.synthesisModel },
      fastify.log
    );
    fastify.log.info('Classification pipeline enabled');
  } else if (!config.anthropicApiKey) {
    fastify.log.warn('anthropicApiKey not set - classification pipeline disabled');
  } else {
    fastify.log.info('Classification pipeline disabled via disableClassification config');
  }

  // Register API routes
  await fastify.register(registerRoutes, {
    syncService,
    outlineService,
    classificationService,
    synthesisService,
    classificationStore,
  });

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

  // Classification sweep: delta-only Haiku classification of recent sessions.
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

  // Weekly synthesis + timeline narrative (Sonnet). Digests the week's events
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
          title: `Hari weekly evolution narrative (${period.startLabel} → ${period.endLabel})`,
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
export { normalizeProjectPaths } from './project-names.js';
export { registerPublicShareRoutes } from './share-routes.js';
export {
  DEFAULT_SESSION_IGNORE_MARKERS,
  matchesIgnoreMarker,
} from './ignore.js';
export * from './classification/index.js';
