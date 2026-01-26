/**
 * Google Module Plugin Entry Point
 *
 * Provides Gmail integration with:
 * - OAuth account management
 * - Email sync with full body fetching
 * - AI-powered triage using multi-turn Haiku
 * - Database-driven rules and topics
 *
 * Required environment variables:
 * - GOOGLE_CLIENT_ID: OAuth client ID
 * - GOOGLE_CLIENT_SECRET: OAuth client secret
 *
 * Optional environment variables:
 * - GOOGLE_REDIRECT_URI: OAuth redirect URI (default: http://localhost:3000/google/auth/callback)
 * - TRIAGE_CONCURRENCY: Number of concurrent triage operations (default: 5)
 * - ANTHROPIC_API_KEY: Required for AI-powered triage
 */

import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { createPlugin, type PluginOptions, type Scheduler } from '@jarvus/claude-assist-core';
import { GmailAuthService } from './services/gmail-auth.js';
import { GmailSyncService } from './services/gmail-sync.js';
import { TriageService } from './services/triage.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerEmailRoutes } from './routes/emails.js';
import { registerRuleRoutes } from './routes/rules.js';

// Module augmentation for fastify decorators
declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
  }
}

export default createPlugin('google', async (fastify: FastifyInstance, _options: PluginOptions) => {
  // Read configuration from environment variables
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/google/auth/callback';
  const triageConcurrency = parseInt(process.env.TRIAGE_CONCURRENCY || '5', 10);

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables are required');
  }

  // Initialize Gmail Auth service
  const authService = new GmailAuthService(fastify.sql, fastify.log, {
    clientId,
    clientSecret,
    redirectUri,
  });

  // Initialize Gmail Sync service
  const syncService = new GmailSyncService(
    fastify.sql,
    fastify.log,
    authService
  );

  // Initialize Triage service (optional - requires ANTHROPIC_API_KEY)
  let triageService: TriageService | null = null;
  if (process.env.ANTHROPIC_API_KEY) {
    triageService = new TriageService(fastify.sql, fastify.log, {
      concurrency: triageConcurrency,
    });
    fastify.log.info('Triage service enabled');
  } else {
    fastify.log.warn(
      'ANTHROPIC_API_KEY not set - email triage disabled'
    );
  }

  // Register routes
  await fastify.register(registerAccountRoutes, { authService, syncService });
  await fastify.register(registerEmailRoutes, { syncService, triageService });
  await fastify.register(registerRuleRoutes);

  // Register scheduled tasks
  fastify.scheduler.register({
    name: 'google:sync',
    schedule: '*/5 * * * *', // Every 5 minutes
    runOnStartup: true,
    handler: async () => {
      const accounts = await fastify.sql<{ id: number }[]>`
        SELECT id FROM google.accounts
        WHERE oauth_credentials IS NOT NULL
      `;

      for (const account of accounts) {
        try {
          const result = await syncService.syncIncremental(account.id);
          fastify.log.info(
            { accountId: account.id, result },
            'Gmail sync complete'
          );
        } catch (error) {
          fastify.log.error(
            { accountId: account.id, error },
            'Gmail sync failed'
          );
        }
      }
    },
  });

  if (triageService) {
    fastify.scheduler.register({
      name: 'google:triage-pending',
      schedule: '*/5 * * * *', // Every 5 minutes
      runOnStartup: false,
      handler: async () => {
        const pending = await fastify.sql<{ id: number }[]>`
          SELECT id FROM google.emails
          WHERE workflow_status = 'new'
          ORDER BY date DESC
          LIMIT 50
        `;

        if (pending.length > 0) {
          const result = await triageService.triageBatch(
            pending.map((e) => e.id)
          );
          fastify.log.info(
            { count: pending.length, result },
            'Triage batch complete'
          );
        }
      },
    });
  }

  fastify.scheduler.register({
    name: 'google:sync-full',
    schedule: '0 4 * * *', // Daily at 4 AM
    runOnStartup: false,
    handler: async () => {
      const accounts = await fastify.sql<{ id: number }[]>`
        SELECT id FROM google.accounts
        WHERE oauth_credentials IS NOT NULL
      `;

      for (const account of accounts) {
        try {
          const result = await syncService.syncFull(account.id);
          fastify.log.info(
            { accountId: account.id, result },
            'Gmail full sync complete'
          );
        } catch (error) {
          fastify.log.error(
            { accountId: account.id, error },
            'Gmail full sync failed'
          );
        }
      }
    },
  });
});

// Re-export types for external use
export * from './types.js';
export { GmailAuthService } from './services/gmail-auth.js';
export { GmailSyncService, type SyncStatus } from './services/gmail-sync.js';
export { TriageService } from './services/triage.js';
