import fp from 'fastify-plugin';
import fastifyEnv from '@fastify/env';
import type { FastifyInstance } from 'fastify';

/**
 * JSON Schema for environment variable validation
 * All env vars must be defined here with types, defaults, and validation
 */
const schema = {
  type: 'object',
  required: ['DATABASE_URL'],
  properties: {
    // Server
    PORT: { type: 'number', default: 2529 },
    HOST: { type: 'string', default: '0.0.0.0' },
    NODE_ENV: {
      type: 'string',
      enum: ['development', 'production', 'test'],
      default: 'development',
    },
    LOG_LEVEL: {
      type: 'string',
      enum: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
      default: 'info',
    },

    // Database
    DATABASE_URL: { type: 'string' },
    DISABLE_MIGRATIONS: { type: 'boolean', default: false },

    // Module enablement
    ENABLE_SESSIONS: { type: 'boolean', default: true },
    ENABLE_GOOGLE: { type: 'boolean', default: true },

    // Master sync disable (overrides all individual sync disable flags)
    DISABLE_SYNCS: { type: 'boolean', default: false },

    // Sessions module
    SESSIONS_ORIGINAL_CLAUDE_DIR: { type: 'string' },
    SESSIONS_MIN_FILE_SIZE: { type: 'number', default: 500 },
    SESSIONS_DISABLE_LOCAL_INGEST: { type: 'boolean', default: false },
    SESSIONS_DISABLE_GENERATE_OUTLINES: { type: 'boolean', default: false },
    // Newline-separated transcript substrings; sessions containing any are
    // suppressed from ingest. Appended to built-in defaults (e.g. M87 triage).
    SESSIONS_IGNORE_MARKERS: { type: 'string' },
    // Classification pipeline (self-improvement loop)
    SESSIONS_DISABLE_CLASSIFICATION: { type: 'boolean', default: false },
    SESSIONS_CLASSIFICATION_CONCURRENCY: { type: 'number', default: 3 },
    SESSIONS_CLASSIFICATION_MIN_DELTA: { type: 'number', default: 6 },
    SESSIONS_CLASSIFICATION_LOOKBACK: { type: 'string', default: '3 days' },
    SESSIONS_CLASSIFICATION_CRON: { type: 'string' },
    SESSIONS_SYNTHESIS_CRON: { type: 'string' },
    SESSIONS_SYNTHESIS_MODEL: { type: 'string', default: 'claude-sonnet-5' },

    // AI Features (optional)
    ANTHROPIC_API_KEY: { type: 'string' },
    OUTLINE_CONCURRENCY: { type: 'number', default: 5 },
    TRIAGE_CONCURRENCY: { type: 'number', default: 5 },

    // Google OAuth
    GOOGLE_CLIENT_ID: { type: 'string' },
    GOOGLE_CLIENT_SECRET: { type: 'string' },
    GOOGLE_REDIRECT_URI: {
      type: 'string',
      default: 'http://localhost:2529/google/auth/callback',
    },
    GOOGLE_DISABLE_EMAIL_SYNC: { type: 'boolean', default: false },
    GOOGLE_DISABLE_EMAIL_TRIAGE: { type: 'boolean', default: false },
    // Deterministic action layer (executor + digests + urgent alerts)
    GOOGLE_DISABLE_EMAIL_ACTIONS: { type: 'boolean', default: false },
    GOOGLE_DISABLE_EMAIL_ALERTS: { type: 'boolean', default: false },
    // Comma-separated team domains treated as whitelisted for the alert bar.
    // Empty by default — set to your own domain(s) on the deploy, e.g.
    // GOOGLE_TEAM_DOMAINS=example.com,example.org
    GOOGLE_TEAM_DOMAINS: { type: 'string', default: '' },
    // Optional path to a JSON seed file ({ rules: [...], topics: [...] }) used to
    // bootstrap deterministic triage rules + topics of interest at first boot.
    // When unset, a few generic example rules are seeded instead.
    GOOGLE_TRIAGE_SEED_FILE: { type: 'string' },
    GOOGLE_EMAIL_DIGEST_CRON: { type: 'string', default: '0 12 * * *' },
    GOOGLE_SPAM_QUARANTINE_CRON: { type: 'string', default: '0 13 * * 1' },

    // Capture module
    ENABLE_CAPTURE: { type: 'boolean', default: true },
    CAPTURE_DISABLE_CLASSIFICATION: { type: 'boolean', default: false },
    CAPTURE_CONCURRENCY: { type: 'number', default: 3 },
    CAPTURE_CLASSIFIER_MODEL: { type: 'string' },
    TANA_MCP_URL: { type: 'string', default: 'http://127.0.0.1:8262/mcp' },
    TANA_MCP_TOKEN: { type: 'string' },
    TANA_WORKSPACE_ID: { type: 'string' },

    // Briefing module (daily briefing + join-required meeting alerts)
    ENABLE_BRIEFING: { type: 'boolean', default: true },
    BRIEFING_DISABLE: { type: 'boolean', default: false },
    BRIEFING_DISABLE_ALERTS: { type: 'boolean', default: false },
    // Timezone for "today" + the morning cron (server clock is UTC).
    BRIEFING_TIMEZONE: { type: 'string', default: 'America/New_York' },
    // Cron in BRIEFING_TIMEZONE; default 06:30 local.
    BRIEFING_CRON: { type: 'string', default: '30 6 * * *' },
    // Alert evaluation cadence (server local / UTC); default every 2 min.
    BRIEFING_ALERT_CRON: { type: 'string', default: '*/2 * * * *' },
    BRIEFING_ALERT_WINDOW_MINUTES: { type: 'number', default: 60 },
    // CLI binaries (shelled out CLI-as-library); default to PATH.
    BRIEFING_GWS_AXI_BIN: { type: 'string', default: 'gws-axi' },
    // Optional pluggable "open commitments" source: any CLI that emits the
    // documented TOON commitments table (see sources/commitments.ts). When
    // unset, the briefing simply omits the commitments section.
    BRIEFING_COMMITMENTS_BIN: { type: 'string' },
    // Space-separated args passed to the commitments CLI (default 'commitment list').
    BRIEFING_COMMITMENTS_ARGS: { type: 'string', default: 'commitment list' },
    // DEPRECATED alias for BRIEFING_COMMITMENTS_BIN. Read only when the new var
    // is unset, so existing deployments keep working; remove after they migrate.
    BRIEFING_HQ_AXI_BIN: { type: 'string' },
    BRIEFING_CALENDAR_ACCOUNT: { type: 'string' },
    // Tana render target (reuses the capture module's TANA_* if unset — wired in server.ts).
    BRIEFING_TANA_WORKSPACE_ID: { type: 'string' },
    // Links out to richer claude-assist pages (e.g. https://assist.example.com).
    BRIEFING_PAGE_BASE_URL: { type: 'string' },

    // Chat module
    ENABLE_CHAT: { type: 'boolean', default: false },
    SLACK_BOT_TOKEN: { type: 'string' },
    SLACK_APP_TOKEN: { type: 'string' },
    SLACK_SIGNING_SECRET: { type: 'string' },
    SLACK_OWNER_USER_ID: { type: 'string' },
    AGENT_REPO_PATH: { type: 'string' },
    BOT_USERNAME: { type: 'string' },
    CLAUDE_CODE_OAUTH_TOKEN: { type: 'string' },

    // Notify module (notification dispatcher + heartbeat registry)
    ENABLE_NOTIFY: { type: 'boolean', default: true },
    // Pushover (interrupt + notice channel). Values live in the pushover MCP config.
    PUSHOVER_TOKEN: { type: 'string' },
    PUSHOVER_USER: { type: 'string' },
    // Slack DM (digest channel) reuses SLACK_BOT_TOKEN + SLACK_OWNER_USER_ID above.
    // Absolute path to the Hari repo clone (for manual coverage-ledger files).
    // Defaults to AGENT_REPO_PATH when unset.
    NOTIFY_HARI_REPO_PATH: { type: 'string' },
    // Host disk health.
    NOTIFY_DISK_PATH: { type: 'string', default: '/' },
    NOTIFY_DISK_MIN_FREE_GB: { type: 'number', default: 20 },
    NOTIFY_DISK_MIN_FREE_PCT: { type: 'number', default: 8 },
    NOTIFY_DISABLE_STALENESS: { type: 'boolean', default: false },
    NOTIFY_STALENESS_CRON: { type: 'string' },
    NOTIFY_DIGEST_FLUSH_CRON: { type: 'string' },

    // Slack urgency module (read-only urgency listener over Chris's Slack)
    ENABLE_SLACK_URGENCY: { type: 'boolean', default: false },
    // User token (xoxp-…) — reads AS Chris (same token slack-axi stores).
    SLACK_URGENCY_USER_TOKEN: { type: 'string' },
    // Team roster: CSV/newline `U0123=Julia Stone` pairs. Owner id reuses SLACK_OWNER_USER_ID.
    SLACK_URGENCY_ROSTER: { type: 'string' },
    // CSV of channel ids to watch beyond DMs.
    SLACK_URGENCY_WATCH_CHANNELS: { type: 'string' },
    // Residue classifier model (defaults to claude-haiku-4-5); reuses ANTHROPIC_API_KEY.
    SLACK_URGENCY_MODEL: { type: 'string' },
    SLACK_URGENCY_TZ: { type: 'string', default: 'America/New_York' },
    SLACK_URGENCY_QUIET_START: { type: 'number', default: 22 },
    SLACK_URGENCY_QUIET_END: { type: 'number', default: 7 },
    SLACK_URGENCY_COOLDOWN_MIN: { type: 'number', default: 30 },
    SLACK_URGENCY_HISTORY_LIMIT: { type: 'number', default: 50 },
    SLACK_URGENCY_POLL_CRON: { type: 'string' },
    // Full-sweep target across every DM + watch channel; history calls are
    // staggered evenly across this window (not fired all at once) to stay
    // well under Slack's history rate limits. Default: 5 minutes.
    SLACK_URGENCY_POLL_INTERVAL_MS: { type: 'number', default: 300_000 },
    SLACK_URGENCY_DISABLE_POLL: { type: 'boolean', default: false },
  },
} as const;

/**
 * TypeScript module augmentation for type-safe config access
 */
declare module 'fastify' {
  interface FastifyInstance {
    config: {
      // Server
      PORT: number;
      HOST: string;
      NODE_ENV: 'development' | 'production' | 'test';
      LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

      // Database
      DATABASE_URL: string;
      DISABLE_MIGRATIONS: boolean;

      // Module enablement
      ENABLE_SESSIONS: boolean;
      ENABLE_GOOGLE: boolean;

      // Master sync disable
      DISABLE_SYNCS: boolean;

      // Sessions module
      SESSIONS_ORIGINAL_CLAUDE_DIR?: string;
      SESSIONS_MIN_FILE_SIZE: number;
      SESSIONS_DISABLE_LOCAL_INGEST: boolean;
      SESSIONS_DISABLE_GENERATE_OUTLINES: boolean;
      SESSIONS_IGNORE_MARKERS?: string;
      SESSIONS_DISABLE_CLASSIFICATION: boolean;
      SESSIONS_CLASSIFICATION_CONCURRENCY: number;
      SESSIONS_CLASSIFICATION_MIN_DELTA: number;
      SESSIONS_CLASSIFICATION_LOOKBACK: string;
      SESSIONS_CLASSIFICATION_CRON?: string;
      SESSIONS_SYNTHESIS_CRON?: string;
      SESSIONS_SYNTHESIS_MODEL: string;

      // AI Features
      ANTHROPIC_API_KEY?: string;
      OUTLINE_CONCURRENCY: number;
      TRIAGE_CONCURRENCY: number;

      // Google OAuth
      GOOGLE_CLIENT_ID?: string;
      GOOGLE_CLIENT_SECRET?: string;
      GOOGLE_REDIRECT_URI: string;
      GOOGLE_DISABLE_EMAIL_SYNC: boolean;
      GOOGLE_DISABLE_EMAIL_TRIAGE: boolean;
      GOOGLE_DISABLE_EMAIL_ACTIONS: boolean;
      GOOGLE_DISABLE_EMAIL_ALERTS: boolean;
      GOOGLE_TEAM_DOMAINS: string;
      GOOGLE_TRIAGE_SEED_FILE?: string;
      GOOGLE_EMAIL_DIGEST_CRON: string;
      GOOGLE_SPAM_QUARANTINE_CRON: string;

      // Capture module
      ENABLE_CAPTURE: boolean;
      CAPTURE_DISABLE_CLASSIFICATION: boolean;
      CAPTURE_CONCURRENCY: number;
      CAPTURE_CLASSIFIER_MODEL?: string;
      TANA_MCP_URL: string;
      TANA_MCP_TOKEN?: string;
      TANA_WORKSPACE_ID?: string;

      // Briefing module
      ENABLE_BRIEFING: boolean;
      BRIEFING_DISABLE: boolean;
      BRIEFING_DISABLE_ALERTS: boolean;
      BRIEFING_TIMEZONE: string;
      BRIEFING_CRON: string;
      BRIEFING_ALERT_CRON: string;
      BRIEFING_ALERT_WINDOW_MINUTES: number;
      BRIEFING_GWS_AXI_BIN: string;
      BRIEFING_COMMITMENTS_BIN?: string;
      BRIEFING_COMMITMENTS_ARGS: string;
      /** @deprecated alias for BRIEFING_COMMITMENTS_BIN; used only when it is unset. */
      BRIEFING_HQ_AXI_BIN?: string;
      BRIEFING_CALENDAR_ACCOUNT?: string;
      BRIEFING_TANA_WORKSPACE_ID?: string;
      BRIEFING_PAGE_BASE_URL?: string;

      // Chat module
      ENABLE_CHAT: boolean;
      SLACK_BOT_TOKEN?: string;
      SLACK_APP_TOKEN?: string;
      SLACK_SIGNING_SECRET?: string;
      SLACK_OWNER_USER_ID?: string;
      AGENT_REPO_PATH?: string;
      BOT_USERNAME?: string;
      CLAUDE_CODE_OAUTH_TOKEN?: string;

      // Notify module
      ENABLE_NOTIFY: boolean;
      PUSHOVER_TOKEN?: string;
      PUSHOVER_USER?: string;
      NOTIFY_HARI_REPO_PATH?: string;
      NOTIFY_DISK_PATH: string;
      NOTIFY_DISK_MIN_FREE_GB: number;
      NOTIFY_DISK_MIN_FREE_PCT: number;
      NOTIFY_DISABLE_STALENESS: boolean;
      NOTIFY_STALENESS_CRON?: string;
      NOTIFY_DIGEST_FLUSH_CRON?: string;

      // Slack urgency module
      ENABLE_SLACK_URGENCY: boolean;
      SLACK_URGENCY_USER_TOKEN?: string;
      SLACK_URGENCY_ROSTER?: string;
      SLACK_URGENCY_WATCH_CHANNELS?: string;
      SLACK_URGENCY_MODEL?: string;
      SLACK_URGENCY_TZ: string;
      SLACK_URGENCY_QUIET_START: number;
      SLACK_URGENCY_QUIET_END: number;
      SLACK_URGENCY_COOLDOWN_MIN: number;
      SLACK_URGENCY_HISTORY_LIMIT: number;
      SLACK_URGENCY_POLL_CRON?: string;
      SLACK_URGENCY_POLL_INTERVAL_MS: number;
      SLACK_URGENCY_DISABLE_POLL: boolean;
    };
  }
}

export default fp(
  async (fastify: FastifyInstance) => {
    await fastify.register(fastifyEnv, {
      confKey: 'config',
      schema,
      dotenv: true,
      ajv: {
        customOptions(ajvInstance) {
          ajvInstance.opts.coerceTypes = true;
          return ajvInstance;
        },
      },
    });
  },
  { name: 'env' }
);
