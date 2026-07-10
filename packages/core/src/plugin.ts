import type { FastifyPluginAsync, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type postgres from 'postgres';
import type { Scheduler } from './scheduler.js';
import type { NotifyDispatcher, HeartbeatRegistry } from './notify.js';

/**
 * Extended Fastify instance with claude-assist decorators
 */
declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
    /**
     * Notification dispatcher — the single delivery spine. Present only when
     * the notify module is loaded; callers guard with `fastify.notify?.…`.
     */
    notify?: NotifyDispatcher;
    /**
     * Coverage-ledger registry. Pipelines call `fastify.heartbeats?.beat(name)`
     * on a successful run so the daily monitor can alert on absence of success.
     */
    heartbeats?: HeartbeatRegistry;
  }
}

export interface PluginOptions {
  /** Name of the plugin for logging */
  name: string;
  /** Directory containing SQL migration files */
  migrationsDir?: string;
  /** Database schema to use (default: plugin name) */
  schema?: string;
  /** Skip running migrations on startup */
  disableMigrations?: boolean;
  /** Configuration for sessions plugin */
  sessionsConfig?: SessionsPluginConfig;
  /** Configuration for google plugin */
  googleConfig?: GooglePluginConfig;
  /** Configuration for chat plugin */
  chatConfig?: ChatPluginConfig;
  /** Configuration for notify plugin */
  notifyConfig?: NotifyPluginConfig;
  /** Configuration for capture plugin */
  captureConfig?: CapturePluginConfig;
}

/**
 * Configuration for the notify (notification dispatcher + heartbeat) plugin
 */
export interface NotifyPluginConfig {
  /** Pushover application API token (interrupt + notice channel). */
  pushoverToken?: string;
  /** Pushover user/group key (recipient). */
  pushoverUser?: string;
  /** Slack bot token (xoxb-…) reused from the chat module for the digest DM. */
  slackBotToken?: string;
  /** Slack user id of the owner — the digest DM recipient. */
  slackOwnerUserId?: string;
  /** Absolute path to the Hari repo clone (for manual coverage-ledger files). */
  hariRepoPath?: string;
  /** Filesystem path whose free space the host-health check watches (default `/`). */
  diskCheckPath?: string;
  /** Alert when free space drops below this many bytes (default 20 GiB). */
  diskMinFreeBytes?: number;
  /** Alert when free space drops below this fraction 0–1 (default 0.08). */
  diskMinFreePct?: number;
  /** Cron for the daily staleness + host-health check. */
  stalenessCron?: string;
  /** Cron for flushing batched digest notifications to Slack. */
  digestFlushCron?: string;
  /** Skip registering the daily staleness/host-health check. */
  disableStalenessCheck?: boolean;
}

/**
 * Configuration for the sessions plugin
 */
export interface SessionsPluginConfig {
  /** Original Claude directory path (for Docker path translation) */
  originalClaudeDir?: string;
  /** Minimum file size to process */
  minFileSize?: number;
  /** Anthropic API key for AI features */
  anthropicApiKey?: string;
  /** Concurrency for outline generation */
  outlineConcurrency?: number;
  /** Disable local filesystem scanning */
  disableLocalIngest?: boolean;
  /** Disable AI outline generation */
  disableGenerateOutlines?: boolean;
  /**
   * Transcript content substrings that mark a session for ingest suppression.
   * Appended to the built-in defaults (e.g. M87 triage runner).
   */
  ignoreContentMarkers?: readonly string[];

  // ── Classification pipeline (self-improvement loop) ──────────────────────
  /** Disable the delta-classification sweep + weekly synthesis. */
  disableClassification?: boolean;
  /** Parallel classify calls per sweep (default 3). */
  classificationConcurrency?: number;
  /** Min new messages before a still-active session's delta is classified (default 6). */
  classificationMinDelta?: number;
  /**
   * How far back the scheduled sweep looks by last transcript activity
   * (sessions.synced_at), so resumed old sessions are still swept; Postgres
   * interval (default '3 days'). Must exceed the 48h quiet threshold.
   */
  classificationLookback?: string;
  /** Cron for the classification sweep (default every 30 min). */
  classificationCron?: string;
  /** Cron for the weekly synthesis + narrative (default Mondays ~09:00 ET). */
  synthesisCron?: string;
  /** Synthesis model id (default 'claude-sonnet-5'). */
  synthesisModel?: string;
}

/**
 * Configuration for the chat plugin
 */
export interface ChatPluginConfig {
  /** Slack bot token */
  slackBotToken: string;
  /** Slack app-level token for Socket Mode (xapp-...) */
  slackAppToken: string;
  /** Slack signing secret */
  slackSigningSecret: string;
  /** Slack user ID of the owner */
  ownerSlackUserId?: string;
  /** Path to the agent's repo (contains CLAUDE.md, skills, protocols) */
  agentRepoPath: string;
  /** Bot username for chat platforms */
  botUsername?: string;
  /** Claude OAuth token for Max subscription */
  claudeOauthToken?: string;
  /** MCP server configurations */
  mcpServers?: Record<string, { command: string; args: string[] }>;
}

/**
 * Configuration for the capture plugin
 */
export interface CapturePluginConfig {
  /** Anthropic API key for AI classification */
  anthropicApiKey?: string;
  /** Classifier model (default: claude-haiku-4-5) */
  classifierModel?: string;
  /** Concurrency for the classification sweep */
  concurrency?: number;
  /** Disable the scheduled classify/route sweep */
  disableClassification?: boolean;
  /** tana-local MCP endpoint (default: http://127.0.0.1:8262/mcp) */
  tanaMcpUrl?: string;
  /** tana-local MCP Personal Access Token */
  tanaMcpToken?: string;
  /** Tana workspace whose {id}_CAPTURE_INBOX receives stray thoughts */
  tanaWorkspaceId?: string;
}

export interface GooglePluginConfig {
  /** Google OAuth client ID */
  clientId: string;
  /** Google OAuth client secret */
  clientSecret: string;
  /** OAuth redirect URI */
  redirectUri: string;
  /** Anthropic API key for AI triage */
  anthropicApiKey?: string;
  /** Concurrency for email triage */
  triageConcurrency?: number;
  /** Disable Gmail sync */
  disableEmailSync?: boolean;
  /** Disable AI email triage */
  disableEmailTriage?: boolean;
  /**
   * Domains whose senders are treated as team/whitelisted for the urgent-alert
   * path (in addition to reply history and any optional external contacts
   * source). Default: [] — configure via GOOGLE_TEAM_DOMAINS on the deploy.
   */
  teamDomains?: string[];
  /**
   * Optional path to a JSON seed file ({ rules, topics }) used to bootstrap the
   * deterministic triage rules + topics of interest at first boot. When unset,
   * generic example rules are seeded instead.
   */
  triageSeedFile?: string;
  /**
   * Disable the deterministic action layer entirely — the executor endpoint,
   * the daily digest, the spam-quarantine digest, and the urgent-alert path.
   * Sync + triage still run. Use as a kill switch for the Gmail-mutating side.
   */
  disableEmailActions?: boolean;
  /** Disable only the urgent-alert dispatch at triage completion. */
  disableEmailAlerts?: boolean;
  /** Cron for the daily confirm-to-execute digest (default '0 12 * * *' ~08:00 ET). */
  emailDigestCron?: string;
  /** Cron for the weekly spam-quarantine review digest (default '0 13 * * 1'). */
  spamQuarantineDigestCron?: string;
}

export interface ModulePlugin {
  plugin: FastifyPluginAsync<PluginOptions>;
  options: PluginOptions;
}

/**
 * Create a module plugin that follows claude-assist conventions
 *
 * Provides:
 * - Automatic migration running on startup
 * - Access to sql client via fastify.sql
 * - Access to scheduler via fastify.scheduler
 */
export function createPlugin(
  name: string,
  setup: (
    fastify: FastifyInstance,
    options: PluginOptions
  ) => Promise<void>
): FastifyPluginAsync<Partial<PluginOptions>> {
  const plugin: FastifyPluginAsync<Partial<PluginOptions>> = async (
    fastify,
    opts
  ) => {
    const options: PluginOptions = {
      name,
      schema: opts.schema ?? name,
      migrationsDir: opts.migrationsDir,
      disableMigrations: opts.disableMigrations,
      sessionsConfig: opts.sessionsConfig,
      googleConfig: opts.googleConfig,
      chatConfig: opts.chatConfig,
      notifyConfig: opts.notifyConfig,
      captureConfig: opts.captureConfig,
    };

    fastify.log.info(`Loading plugin: ${name}`);

    // Run migrations if migrations directory is provided (unless disabled)
    if (options.migrationsDir && fastify.sql) {
      if (options.disableMigrations) {
        fastify.log.info(`Skipping migrations for ${name} (disableMigrations=true)`);
      } else {
        const { runMigrations } = await import('./migrations.js');
        const applied = await runMigrations(fastify.sql, {
          migrationsDir: options.migrationsDir,
          schema: options.schema,
        });

        if (applied.length > 0) {
          fastify.log.info(
            { migrations: applied },
            `Applied ${applied.length} migrations for ${name}`
          );
        }
      }
    }

    // Run the plugin setup
    await setup(fastify, options);

    fastify.log.info(`Loaded plugin: ${name}`);
  };

  // Wrap with fastify-plugin to avoid encapsulation
  return fp(plugin, {
    name,
    fastify: '5.x',
    dependencies: [], // Add dependencies as needed
  });
}
