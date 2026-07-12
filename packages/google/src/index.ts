/**
 * Google Module Plugin Entry Point
 *
 * Provides Gmail integration with:
 * - OAuth account management
 * - Email sync with full body fetching
 * - AI-powered triage using multi-turn Haiku
 * - Deterministic action layer: pre-AI rules, label/archive/spam executor,
 *   urgent-alert path, daily digest, and weekly spam-quarantine digest
 *
 * Configuration is passed via googleConfig in plugin options.
 */

import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { createPlugin, type PluginOptions, type Scheduler } from '@jarvus/claude-assist-core';
import { GmailAuthService } from './services/gmail-auth.js';
import { GmailSyncService } from './services/gmail-sync.js';
import { TriageService } from './services/triage.js';
import { RulesService } from './services/rules.js';
import { WhitelistService } from './services/whitelist.js';
import { GmailExecutorService } from './services/gmail-executor.js';
import { DigestService, AnthropicDigestSummarizer } from './services/digest.js';
import { SenderStandingStore, RefinementStore } from './services/standing.js';
import { PgEmailAttentionStore } from './services/attention-store.js';
import { EmailResidueClassifier } from './services/email-residue.js';
import { OpportunityEvaluator, loadOpportunityPrompt } from './services/opportunity.js';
import { loadClientContacts } from './services/contacts.js';
import { seedAccountRules, resolveSeedContent, EXAMPLE_SEED_CONTENT } from './services/seed-rules.js';
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

export default createPlugin('google', async (fastify: FastifyInstance, options: PluginOptions) => {
  const config = options.googleConfig;

  if (!config?.clientId || !config?.clientSecret) {
    throw new Error('googleConfig with clientId and clientSecret is required');
  }

  const actionsEnabled = !config.disableEmailActions;

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

  // Individual client contacts (pluggable source) get standing in the ATTENTION
  // bar. Load once at boot; a failed/absent source degrades to none (never fatal).
  let clientContacts: string[] = [];
  if (config.contactsFile || config.contactsBin) {
    try {
      const set = await loadClientContacts({
        file: config.contactsFile,
        bin: config.contactsBin,
        args: config.contactsArgs,
      });
      clientContacts = [...set];
      fastify.log.info(
        { count: clientContacts.length, source: config.contactsFile ?? config.contactsBin },
        'Loaded client contacts for the urgency bar'
      );
    } catch (error) {
      fastify.log.error({ error }, 'Failed to load client contacts source; continuing with none');
    }
  }

  // Deterministic collaborators for the action layer.
  const rulesService = new RulesService(fastify.sql);
  const whitelistService = new WhitelistService(fastify.sql, { clientContacts });

  // Two-tier urgency collaborators (attention store + cheap-model judges).
  const attentionStore = new PgEmailAttentionStore(fastify.sql);
  const residueJudge = config.anthropicApiKey
    ? new EmailResidueClassifier({ apiKey: config.anthropicApiKey }, fastify.log)
    : undefined;

  // Owner-interest opportunity evaluator for solicitation-class mail. Off unless
  // an interest-spec file is configured (instance data).
  let opportunityEvaluator: OpportunityEvaluator | undefined;
  if (config.anthropicApiKey && config.opportunityPromptFile) {
    try {
      const interestSpec = loadOpportunityPrompt(config.opportunityPromptFile);
      if (interestSpec) {
        opportunityEvaluator = new OpportunityEvaluator(
          { apiKey: config.anthropicApiKey, interestSpec },
          fastify.log
        );
        fastify.log.info(
          { source: config.opportunityPromptFile },
          'Loaded opportunity interest spec (RFP/solicitation evaluation enabled)'
        );
      }
    } catch (error) {
      fastify.log.error(
        { error, file: config.opportunityPromptFile },
        'Failed to load GOOGLE_OPPORTUNITY_PROMPT_FILE; opportunity evaluation disabled'
      );
    }
  }

  // Initialize Triage service (optional - requires anthropicApiKey)
  let triageService: TriageService | null = null;
  if (config.anthropicApiKey) {
    triageService = new TriageService(
      fastify.sql,
      fastify.log,
      {
        apiKey: config.anthropicApiKey,
        concurrency: config.triageConcurrency,
        disableEmailTriage: config.disableEmailTriage,
      },
      {
        rulesService,
        whitelistService,
        notify: fastify.notify,
        heartbeats: fastify.heartbeats,
        teamDomains: config.teamDomains,
        disableEmailAlerts: config.disableEmailAlerts || !actionsEnabled,
        attentionStore,
        residueJudge,
        opportunityEvaluator,
        quietHours: {
          timeZone: config.urgencyTimeZone ?? 'America/New_York',
          startHour: config.urgencyQuietStartHour ?? 22,
          endHour: config.urgencyQuietEndHour ?? 7,
        },
      }
    );
    fastify.log.info('Triage service enabled');
  } else {
    fastify.log.warn('anthropicApiKey not set - email triage disabled');
  }

  // Executor + digest (the Gmail-mutating side; gated by disableEmailActions).
  // Sender standing + refinement stores back the digest-page affordances; they
  // exist whenever the schema does, independent of the action layer.
  const senderStandingStore = new SenderStandingStore(fastify.sql);
  const refinementStore = new RefinementStore(fastify.sql);

  let executorService: GmailExecutorService | null = null;
  let digestService: DigestService | null = null;
  if (actionsEnabled) {
    executorService = new GmailExecutorService(
      fastify.sql,
      fastify.log,
      authService,
      whitelistService,
      { disableEmailActions: false },
      fastify.heartbeats
    );
    // Haiku-class summarizer for the digest-category content summaries (reuses
    // the triage API key; summarizing, not judging). Absent → deterministic
    // fallback bullets.
    const summarizer = config.anthropicApiKey
      ? new AnthropicDigestSummarizer({ apiKey: config.anthropicApiKey })
      : undefined;
    digestService = new DigestService(fastify.sql, fastify.log, fastify.notify, {
      summarizer,
      standing: senderStandingStore,
      pageUrl: config.emailDigestPageUrl,
    });
    fastify.log.info('Email action layer enabled (executor + digests)');
  } else {
    fastify.log.info('Email action layer disabled via disableEmailActions config');
  }

  // Resolve triage bootstrap seed content once: the JSON file at
  // GOOGLE_TRIAGE_SEED_FILE when set, otherwise the built-in generic examples.
  // A misconfigured file logs and falls back to examples rather than failing boot.
  let seedContent = EXAMPLE_SEED_CONTENT;
  try {
    seedContent = resolveSeedContent(config.triageSeedFile);
    fastify.log.info(
      {
        source: config.triageSeedFile ?? 'built-in examples',
        rules: seedContent.rules.length,
        topics: seedContent.topics.length,
      },
      'Loaded triage seed content'
    );
  } catch (error) {
    fastify.log.error(
      { error, seedFile: config.triageSeedFile },
      'Failed to load GOOGLE_TRIAGE_SEED_FILE; falling back to example rules'
    );
  }

  // Register routes
  await fastify.register(registerAccountRoutes, {
    authService,
    syncService,
    triageService,
    seedContent,
  });
  await fastify.register(registerEmailRoutes, {
    syncService,
    triageService,
    executorService,
    digestService,
    senderStandingStore,
    refinementStore,
  });
  await fastify.register(registerRuleRoutes);

  // Bootstrap triage rules + topics for every already-credentialed account
  // (idempotent — existing rows are preserved).
  try {
    const accounts = await fastify.sql<{ id: number }[]>`
      SELECT id FROM google.accounts WHERE oauth_credentials IS NOT NULL
    `;
    for (const account of accounts) {
      const seeded = await seedAccountRules(fastify.sql, account.id, seedContent);
      if (seeded.rulesInserted > 0 || seeded.topicsInserted > 0) {
        fastify.log.info(
          { accountId: account.id, ...seeded },
          'Seeded triage rules/topics'
        );
      }
    }
  } catch (error) {
    fastify.log.error({ error }, 'Failed to seed triage rules');
  }

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

  // Digest schedulers (the batch surface; no-daily-ritual — pushed on a
  // schedule, confirmed asynchronously).
  if (digestService) {
    fastify.scheduler.register({
      name: 'google:email-digest',
      schedule: config.emailDigestCron ?? '0 12 * * *', // daily ~08:00 ET
      runOnStartup: false,
      handler: async () => {
        const ids = await digestService!.sendDailyDigest();
        fastify.log.info({ staged: ids.length }, 'Daily email digest dispatched');
      },
    });

    fastify.scheduler.register({
      name: 'google:spam-quarantine-digest',
      schedule: config.spamQuarantineDigestCron ?? '0 13 * * 1', // Mondays ~09:00 ET
      runOnStartup: false,
      handler: async () => {
        const count = await digestService!.sendQuarantineDigest();
        fastify.log.info({ quarantined: count }, 'Spam-quarantine digest dispatched');
      },
    });

    fastify.log.info('Email digests scheduled');
  }
});

// Re-export types for external use
export * from './types.js';
export { GmailAuthService } from './services/gmail-auth.js';
export { GmailSyncService, type SyncStatus } from './services/gmail-sync.js';
export { TriageService, type TriageStatus } from './services/triage.js';
export { RulesService } from './services/rules.js';
export { WhitelistService } from './services/whitelist.js';
export { GmailExecutorService } from './services/gmail-executor.js';
export { DigestService, AnthropicDigestSummarizer } from './services/digest.js';
export { SenderStandingStore, RefinementStore } from './services/standing.js';
