/**
 * Slack urgency module — a read-only listener over the owner's incoming Slack that
 * interrupts (phone + watch, via the notification dispatcher) ONLY for what
 * genuinely can't wait, per the "interrupts are earned" principle.
 * Everything else batches to the digest; near-misses back-stop false negatives.
 *
 * Wiring: a user-token Web API reader (reads AS the owner) → a poll loop with
 * per-conversation cursors → the urgency pipeline (deterministic core + Haiku
 * residue + quiet hours + thread dedup) → fastify.notify at interrupt priority.
 * A per-cycle heartbeat means a silently-dead listener pages the owner — the exact
 * failure mode this system exists to eliminate.
 *
 * FIREWALL / READ-ONLY: no write path to any external system of record, and the
 * Slack side is strictly read (never posts, reacts, or marks-read). Team roster
 * comes from config / an external contacts dump, never from a transcript.
 */

import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import {
  createPlugin,
  type PluginOptions,
  type Scheduler,
  type NotifyDispatcher,
  type HeartbeatRegistry,
  type SlackUrgencyPluginConfig,
} from '@jarvus/claude-assist-core';
import { PgUrgencyStore } from './store.js';
import { Roster, parseRoster } from './roster.js';
import { ResidueClassifier } from './classifier.js';
import { WebApiSlackReader } from './web-reader.js';
import { UrgencyPipeline, type PermalinkResolver, type UrgencyNotifier } from './pipeline.js';
import { UrgencyPoller } from './poller.js';
import { registerUrgencyRoutes } from './routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
    notify?: NotifyDispatcher;
    heartbeats?: HeartbeatRegistry;
  }
}

export const SLACK_URGENCY_PIPELINE = 'slack-urgency';

export default createPlugin('slack-urgency', async (fastify: FastifyInstance, options: PluginOptions) => {
  const config: SlackUrgencyPluginConfig = options.slackUrgencyConfig ?? {};

  if (!config.userToken) {
    fastify.log.warn(
      'Slack urgency enabled but SLACK_URGENCY_USER_TOKEN not set — the poller reads AS the owner via a user token; skipping'
    );
    return;
  }
  if (!config.ownerId) {
    fastify.log.error('Slack urgency: SLACK_OWNER_USER_ID is required (never interrupt for the owner\'s own messages)');
    return;
  }

  const store = new PgUrgencyStore(fastify.sql);
  const roster = new Roster(parseRoster(config.roster));
  if (roster.size === 0) {
    fastify.log.warn(
      'Slack urgency: roster is empty — no sender is a known teammate, so only @mentions with a concrete ask can ever reach the model. Set SLACK_URGENCY_ROSTER.'
    );
  }

  const classifier = config.anthropicApiKey
    ? new ResidueClassifier({ apiKey: config.anthropicApiKey, model: config.model }, fastify.log)
    : null;
  if (!classifier) {
    fastify.log.warn(
      'Slack urgency: ANTHROPIC_API_KEY not set — residue messages default to the digest (no model pass)'
    );
  }

  const reader = new WebApiSlackReader({ userToken: config.userToken }, fastify.log);

  // The interrupt goes through the ONE dispatcher (no pipeline grows its own
  // delivery). Both tiers that reach here map to `interrupt` priority — the
  // pipeline already applied the earned-interrupt bar.
  const notifier: UrgencyNotifier = {
    async fire(decision, permalink) {
      if (!fastify.notify) {
        fastify.log.warn('Slack urgency: fastify.notify absent — interrupt dropped');
        return null;
      }
      const who = decision.candidate.senderName ?? decision.candidate.sender;
      const title = decision.tier === 'emergency' ? `🚨 ${who}` : who;
      const result = await fastify.notify.notify({
        priority: 'interrupt',
        title,
        body: decision.gist || decision.candidate.text.slice(0, 200),
        url: permalink ?? undefined,
      });
      return result.id;
    },
  };

  const permalinks: PermalinkResolver = {
    resolve: (channel, ts) => reader.permalink(channel, ts),
  };

  const pipeline = new UrgencyPipeline(store, classifier, roster, notifier, permalinks, fastify.log, {
    ownerId: config.ownerId,
    quietHours: {
      timeZone: config.timeZone ?? 'America/New_York',
      startHour: config.quietStartHour ?? 22,
      endHour: config.quietEndHour ?? 7,
    },
    cooldownMs: (config.cooldownMinutes ?? 30) * 60 * 1000,
  });

  const poller = new UrgencyPoller(reader, pipeline, store, fastify.log, {
    ownerId: config.ownerId,
    watchChannels: config.watchChannels ?? [],
    historyLimit: config.historyLimit,
    cycleIntervalMs: config.cycleIntervalMs,
  });

  await fastify.register(registerUrgencyRoutes, { store });

  // Heartbeat: a listener that silently dies is exactly the failure mode this
  // system exists to eliminate. Register + beat every cycle; the daily monitor
  // pages on absence of success (threshold generous vs the ~1-min poll).
  await fastify.heartbeats?.register({ name: SLACK_URGENCY_PIPELINE, threshold: '30 minutes' });

  if (!config.disablePolling) {
    fastify.scheduler.register({
      name: 'slack-urgency:poll',
      schedule: config.pollCron ?? '* * * * *', // every minute (cron's finest) — a tick just
      // attempts a cycle; the poller itself staggers calls across cycleIntervalMs, so most
      // ticks land mid-cycle and no-op (see UrgencyPoller.pollOnce)
      runOnStartup: true,
      handler: async () => {
        const result = await poller.pollOnce();
        if (result.processed > 0) {
          fastify.log.info({ result }, 'Slack urgency poll complete');
        }
        // Only a successful cycle beats — staleness (a dead poller) then pages.
        await fastify.heartbeats?.beat(SLACK_URGENCY_PIPELINE, { threshold: '30 minutes' });
      },
    });

    // Refresh the DM conversation cache hourly so newly-opened DMs get polled.
    fastify.scheduler.register({
      name: 'slack-urgency:refresh-dms',
      schedule: '7 * * * *',
      runOnStartup: false,
      handler: async () => poller.invalidateDmCache(),
    });
  } else {
    fastify.log.info('Slack urgency polling disabled via config');
  }

  fastify.log.info(
    { roster: roster.size, watchChannels: (config.watchChannels ?? []).length, model: Boolean(classifier) },
    'Slack urgency module loaded'
  );
});

export * from './types.js';
export { Roster, parseRoster } from './roster.js';
export {
  classifyDeterministic,
  summarize,
  isQuietHour,
  isQuietHours,
  localHourInTz,
  type QuietHoursConfig,
  type DeterministicInput,
} from './urgency.js';
export {
  ResidueClassifier,
  type ResidueJudge,
  type ThreadContextLine,
  type ResidueClassifierConfig,
} from './classifier.js';
export {
  UrgencyPipeline,
  tsToDate,
  type EvalContext,
  type PipelineConfig,
  type UrgencyNotifier,
  type PermalinkResolver,
} from './pipeline.js';
export {
  UrgencyPoller,
  buildCandidates,
  MENTION_SWEEP_CURSOR_ID,
  type SlackReader,
  type RawSlackMessage,
  type Conversation,
  type MentionHit,
  type PollerConfig,
} from './poller.js';
export { WebApiSlackReader, asChannelType, type WebReaderConfig } from './web-reader.js';
export {
  PgUrgencyStore,
  MemoryUrgencyStore,
  type UrgencyStore,
  type CandidateRow,
  type WeightRow,
  type RecordCandidateInput,
} from './store.js';
export { registerUrgencyRoutes, type UrgencyRoutesConfig } from './routes.js';
