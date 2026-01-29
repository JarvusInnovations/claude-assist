import { createPlugin } from '@jarvus/claude-assist-core';
import { SyncService } from './sync.js';
import { OutlineService } from './outline.js';
import { registerRoutes } from './routes.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Sessions plugin for archiving Claude Code transcripts
 *
 * Provides:
 * - Local filesystem scanning for sessions
 * - Push endpoint for satellite machines
 * - Full-text search across all sessions
 * - Scheduled sync every 5 minutes
 * - AI-generated session outlines (if ANTHROPIC_API_KEY is set)
 */
export default createPlugin('sessions', async (fastify, options) => {
  // Initialize sync service with optional path mapping for Docker
  // SESSIONS_ORIGINAL_CLAUDE_DIR: The original path on host (e.g., /Users/chris/.claude)
  // This allows the scanner to translate transcript paths when running in Docker
  // SESSIONS_MIN_FILE_SIZE: Minimum transcript file size in bytes (default 500)
  const minFileSize = process.env.SESSIONS_MIN_FILE_SIZE
    ? parseInt(process.env.SESSIONS_MIN_FILE_SIZE, 10)
    : undefined;

  const syncService = new SyncService(fastify.sql, fastify.log, {
    originalClaudeDir: process.env.SESSIONS_ORIGINAL_CLAUDE_DIR,
    minFileSize,
  });

  // Initialize outline service (optional - requires ANTHROPIC_API_KEY)
  let outlineService: OutlineService | null = null;
  if (process.env.ANTHROPIC_API_KEY) {
    const outlineConcurrency = process.env.OUTLINE_CONCURRENCY
      ? parseInt(process.env.OUTLINE_CONCURRENCY, 10)
      : undefined;

    outlineService = new OutlineService(fastify.sql, fastify.log, {
      concurrency: outlineConcurrency,
    });
    fastify.log.info('Outline service enabled');
  } else {
    fastify.log.warn(
      'ANTHROPIC_API_KEY not set - outline generation disabled'
    );
  }

  // Register API routes
  await fastify.register(registerRoutes, { syncService, outlineService });

  // Register scheduled sync task for localhost (unless disabled)
  if (process.env.SESSIONS_DISABLE_LOCAL_INGEST !== 'true') {
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
      },
    });
    fastify.log.info(
      'Sessions plugin loaded with local sync scheduled every 5 minutes'
    );
  } else {
    fastify.log.info(
      'Sessions plugin loaded (local sync disabled via SESSIONS_DISABLE_LOCAL_INGEST)'
    );
  }

  // Register hourly outline generation task (catch-all for any missed sessions)
  if (outlineService && process.env.SESSIONS_DISABLE_GENERATE_OUTLINES !== 'true') {
    fastify.scheduler.register({
      name: 'sessions:generate-outlines',
      schedule: '0 * * * *', // Every hour at :00
      runOnStartup: false,
      handler: async () => {
        fastify.log.info('Running scheduled outline generation');
        outlineService.queueOutlineGeneration();
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
