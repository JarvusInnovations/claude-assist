/**
 * Google Module Plugin Entry Point
 *
 * Provides Gmail integration with:
 * - OAuth account management
 * - Email sync with full body fetching
 * - AI-powered triage using multi-turn Haiku
 *
 * Configuration is passed via googleConfig in plugin options.
 */

import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { createPlugin, type PluginOptions, type Scheduler } from '@jarvus/claude-assist-core';
import { GmailAuthService } from './services/gmail-auth.js';
import { GmailSyncService } from './services/gmail-sync.js';
import { TriageService } from './services/triage.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerEmailRoutes } from './routes/emails.js';

// Module augmentation for fastify decorators
declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
  }
}

export default createPlugin('google', async (fastify: FastifyInstance, options: PluginOptions) => {
  const config = options.googleConfig;

  if (!config?.clientId || !config?.clientSecret) {
    throw new Error('googleConfig with clientId and clientSecret is required');
  }

  // Initialize Gmail Auth service
  const authService = new GmailAuthService(fastify.sql, fastify.log, {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
  });

  // Initialize Gmail Sync service
  const syncService = new GmailSyncService(fastify.sql, fastify.log, authService, {
    disableEmailSync: config.disableEmailSync,
  });

  // Initialize Triage service (optional - requires anthropicApiKey)
  let triageService: TriageService | null = null;
  if (config.anthropicApiKey) {
    triageService = new TriageService(fastify.sql, fastify.log, {
      apiKey: config.anthropicApiKey,
      concurrency: config.triageConcurrency,
      disableEmailTriage: config.disableEmailTriage,
    });
    fastify.log.info('Triage service enabled');
  } else {
    fastify.log.warn('anthropicApiKey not set - email triage disabled');
  }

  // Register routes
  await fastify.register(registerAccountRoutes, { authService, syncService, triageService });
  await fastify.register(registerEmailRoutes, { syncService, triageService });

  // Register scheduled tasks (unless disabled)
  if (!config.disableEmailSync) {
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
            // Coverage heartbeat: a successful per-account sync (absence pages).
            await fastify.heartbeats?.beat(`email-sync:${account.id}`, {
              threshold: '12 hours',
              metadata: { accountId: account.id },
            });
          } catch (error) {
            fastify.log.error(
              { accountId: account.id, error },
              'Gmail sync failed'
            );
          }
        }
      },
    });

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

    fastify.log.info('Gmail sync scheduled');
  } else {
    fastify.log.info('Gmail sync disabled via disableEmailSync config');
  }

  if (triageService && !config.disableEmailTriage) {
    fastify.scheduler.register({
      name: 'google:triage-pending',
      schedule: '*/5 * * * *', // Every 5 minutes
      runOnStartup: false,
      handler: async () => {
        // Excludes emails that already hit the retry cap (see
        // TriageService.MAX_TRIAGE_ATTEMPTS) so a permanently-failing email
        // (e.g. one that keeps blowing the model's context window) doesn't
        // burn a paid turn-1 call every cycle forever.
        const pending = await fastify.sql<{ id: number }[]>`
          SELECT id FROM google.emails
          WHERE workflow_status = 'new' AND triage_attempts < ${TriageService.MAX_TRIAGE_ATTEMPTS}
          ORDER BY date DESC
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
        // Coverage heartbeat: the triage sweep ran to completion this cycle.
        await fastify.heartbeats?.beat('triage', { threshold: '6 hours' });
      },
    });
  } else if (triageService) {
    fastify.log.info('Email triage disabled via disableEmailTriage config');
  }
});

// Re-export types for external use
export * from './types.js';
export { GmailAuthService } from './services/gmail-auth.js';
export { GmailSyncService, type SyncStatus } from './services/gmail-sync.js';
export { TriageService, type TriageStatus } from './services/triage.js';
