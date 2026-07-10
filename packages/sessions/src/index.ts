import { createPlugin } from '@jarvus/claude-assist-core';
import { SyncService } from './sync.js';
import { OutlineService } from './outline.js';
import { registerRoutes } from './routes.js';

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

  // Register API routes
  await fastify.register(registerRoutes, { syncService, outlineService });

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
});

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
