import { createPlugin } from '@jarvus/claude-assist-core';
import { SyncService } from './sync.js';
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

  // Register API routes
  await fastify.register(registerRoutes, { syncService });

  // Register scheduled sync task for localhost
  // Run every 5 minutes, also on startup
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
    },
  });

  fastify.log.info('Sessions plugin loaded with local sync scheduled every 5 minutes');
});

// Re-export types for external use
export * from './types.js';
export { SyncService } from './sync.js';
export { SessionScanner } from './scanner.js';
export { parseTranscript } from './parser.js';
