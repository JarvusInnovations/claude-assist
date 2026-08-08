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

    // --- Invoker: the single choke point for metered model calls ---
    // Tier overrides. A call site names a tier describing its work; these are
    // the only place a model id is configured (specs/modules/invoker.md).
    MODEL_TIER_CLASSIFY: { type: 'string' },
    MODEL_TIER_EXTRACT: { type: 'string' },
    MODEL_TIER_VISION: { type: 'string' },
    MODEL_TIER_SYNTHESIZE: { type: 'string' },
    // Stop all metered invocation while leaving the host healthy. Per-feature
    // disable flags answer "turn this pipeline off"; this answers "stop
    // spending, now, everywhere."
    MODEL_KILL_SWITCH: { type: 'boolean', default: false },
    // Rolling-daily ceilings. A breach raises one human approval per window
    // and fails calls transiently; it does not silently stop the instance.
    MODEL_DAILY_BUDGET_USD: { type: 'number' },
    MODEL_DAILY_BUDGET_TOKENS: { type: 'number' },
    // JSON object of per-task dollar ceilings, e.g. {"google.triage": 2.5}.
    MODEL_TASK_BUDGETS_USD: { type: 'string' },
    // JSON object of price overrides, USD per million tokens, keyed by model:
    // {"claude-haiku-4-5": {"input": 1, "output": 5}}.
    MODEL_PRICES: { type: 'string' },
    MODEL_MAX_ATTEMPTS: { type: 'number', default: 3 },
    MODEL_RETRY_BASE_MS: { type: 'number', default: 500 },
    MODEL_TIMEOUT_MS: { type: 'number' },

    // --- Approvals: human gates that never block a worker ---
    ENABLE_APPROVALS: { type: 'boolean', default: true },
    APPROVAL_EXPIRY_MS: { type: 'number', default: 86400000 },
    APPROVAL_EXPIRE_CRON: { type: 'string' },
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
    // Two-tier urgency quiet hours (owner TZ). INTERRUPTs raised inside the
    // window are HELD and shown in the morning briefing; emergencies pierce.
    GOOGLE_URGENCY_TZ: { type: 'string', default: 'America/New_York' },
    GOOGLE_URGENCY_QUIET_START: { type: 'number', default: 22 },
    GOOGLE_URGENCY_QUIET_END: { type: 'number', default: 7 },
    // Individual client contacts (get standing in the ATTENTION bar). Point at a
    // newline-delimited file of addresses, or a CLI that prints them to stdout.
    GOOGLE_CONTACTS_FILE: { type: 'string' },
    GOOGLE_CONTACTS_BIN: { type: 'string' },
    GOOGLE_CONTACTS_ARGS: { type: 'string', default: '' },
    // Owner-maintained interest spec for solicitation-class (RFP/RFQ) mail.
    // Unset = opportunity path off. Instance data; contents never enter the repo.
    GOOGLE_OPPORTUNITY_PROMPT_FILE: { type: 'string' },
    GOOGLE_EMAIL_DIGEST_CRON: { type: 'string', default: '0 12 * * *' },
    GOOGLE_SPAM_QUARANTINE_CRON: { type: 'string', default: '0 13 * * 1' },
    // Absolute URL of the interactive digest page — carried in the daily digest
    // Pushover notice's button slot (e.g. https://assist.example.com/digest).
    GOOGLE_DIGEST_PAGE_URL: { type: 'string' },

    // Capture module
    ENABLE_CAPTURE: { type: 'boolean', default: true },
    CAPTURE_DISABLE_CLASSIFICATION: { type: 'boolean', default: false },
    CAPTURE_CONCURRENCY: { type: 'number', default: 3 },
    CAPTURE_CLASSIFIER_MODEL: { type: 'string' },
    TANA_MCP_URL: { type: 'string', default: 'http://127.0.0.1:8262/mcp' },
    TANA_MCP_TOKEN: { type: 'string' },
    TANA_WORKSPACE_ID: { type: 'string' },
    // Object-store bucket for capture attachments. Unset → attachments
    // disabled (sign endpoint 503s). Credentials via Google Application
    // Default Credentials (GOOGLE_APPLICATION_CREDENTIALS or ambient identity).
    CAPTURE_ATTACHMENTS_BUCKET: { type: 'string' },

    // Kitchen module (consumption journal — entries, estimation, recipes)
    ENABLE_KITCHEN: { type: 'boolean', default: true },
    KITCHEN_DISABLE_ESTIMATION: { type: 'boolean', default: false },
    KITCHEN_CONCURRENCY: { type: 'number', default: 3 },
    // Vision-capable estimation model; defaults to a strong vision tier (open-ended meal estimation).
    KITCHEN_ESTIMATION_MODEL: { type: 'string', default: 'claude-fable-5' },
    // Cheap vision model for mechanical receipt-line extraction (phase 2).
    KITCHEN_RECEIPT_MODEL: { type: 'string', default: 'claude-haiku-4-5' },
    // Model for the spawned interactive meal-planning session — an INTERACTIVE
    // HUMAN session under subscription auth, unrelated to the metered models
    // above. Unset ⇒ the instance-wide SESSION_SPAWN_MODEL applies.
    KITCHEN_PLAN_SESSION_MODEL: { type: 'string' },
    KITCHEN_MAX_PHOTO_BYTES: { type: 'number', default: 10_485_760 },
    KITCHEN_MAX_PHOTOS: { type: 'number', default: 6 },
    // Meal-bank gitsheet read (both optional — unset degrades to recents-only reselect).
    KITCHEN_MEALBANK_REPO_PATH: { type: 'string' },
    KITCHEN_MEALBANK_SHEET: { type: 'string' },
    // Owner's non-exercise daily expenditure (kcal) for the net-energy line
    // (§ Expenditure & net energy). Optional — unset omits the net line.
    KITCHEN_TDEE_BASE: { type: 'number' },
    // Owner-set per-nutrient daily reference lines (§ Daily targets) — JSON
    // mapping panel fields to exactly one of {"max": N} / {"min": N}.
    // Optional — unset omits the summary's targets block; malformed fails
    // boot loudly at kitchen plugin init.
    KITCHEN_DAILY_TARGETS: { type: 'string' },
    // Owner's IANA timezone (§ Timezone & local-day bucketing) — the one source
    // of truth for every local-day boundary the module computes. Optional —
    // unset falls back to UTC (stated in affected output); a present-but-invalid
    // zone fails boot loudly at kitchen plugin init.
    KITCHEN_OWNER_TZ: { type: 'string' },
    // Strava activity sync (§ Strava activity sync) — all three credentials
    // present ⇒ the scheduled sync runs; any absent ⇒ entirely off. The
    // refresh token is a first-boot seed only (kitchen.strava_oauth is
    // authoritative once it exists).
    KITCHEN_STRAVA_CLIENT_ID: { type: 'string' },
    KITCHEN_STRAVA_CLIENT_SECRET: { type: 'string' },
    KITCHEN_STRAVA_REFRESH_TOKEN: { type: 'string' },
    // Sync cadence in minutes (default 30). Kept a string so the kitchen
    // plugin can validate boot-loudly (malformed ⇒ startup failure).
    KITCHEN_STRAVA_SYNC_MINUTES: { type: 'string' },

    // Pages module (publish + collect interactive HTML pages)
    ENABLE_PAGES: { type: 'boolean', default: true },
    // Override for links in publish responses + notify dispatch (default:
    // derived from the request's forwarded-proto/host headers).
    PAGES_BASE_URL: { type: 'string' },

    // Briefing module (daily briefing + join-required meeting alerts)
    ENABLE_BRIEFING: { type: 'boolean', default: true },
    BRIEFING_DISABLE: { type: 'boolean', default: false },
    BRIEFING_DISABLE_ALERTS: { type: 'boolean', default: false },
    // Timezone for "today" + the morning cron (server clock is UTC).
    BRIEFING_TIMEZONE: { type: 'string', default: 'America/New_York' },
    // Cron in BRIEFING_TIMEZONE; default 06:30 local.
    BRIEFING_CRON: { type: 'string', default: '30 6 * * *' },
    // Alert evaluation cadence (server local / UTC). Every minute: 1-minute
    // video leads have a ~150s firing window (start-grace included) and must
    // never fall between scans.
    BRIEFING_ALERT_CRON: { type: 'string', default: '* * * * *' },
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

    // Per-meeting briefings (preps on the virtuous cycle)
    ENABLE_MEETING_BRIEFINGS: { type: 'boolean', default: true },
    // Sonnet-class prep composer model.
    MEETING_PREP_MODEL: { type: 'string', default: 'claude-sonnet-5' },
    // Optional pluggable prior-occurrence context CLI (transcripts/HQ timelines/
    // Slack). Receives occurrence metadata as JSON on stdin + --series-key/
    // --occurrence-key args; prints context text on stdout. Unset → omitted.
    MEETING_CONTEXT_BIN: { type: 'string' },
    // Space-separated args passed to the context CLI before the derived flags.
    MEETING_CONTEXT_ARGS: { type: 'string', default: '' },
    // Cron for the meeting-cycle pass (server local / UTC); default every 30 min.
    MEETING_CRON: { type: 'string', default: '*/30 * * * *' },
    // Refresh occurrences starting within this many hours (the ~24h trigger).
    MEETING_REFRESH_AHEAD_HOURS: { type: 'number', default: 26 },

    // Chat module
    ENABLE_CHAT: { type: 'boolean', default: false },
    SLACK_BOT_TOKEN: { type: 'string' },
    SLACK_APP_TOKEN: { type: 'string' },
    SLACK_SIGNING_SECRET: { type: 'string' },
    SLACK_OWNER_USER_ID: { type: 'string' },
    AGENT_REPO_PATH: { type: 'string' },
    BOT_USERNAME: { type: 'string' },
    CLAUDE_CODE_OAUTH_TOKEN: { type: 'string' },
    // Live per-turn context commands — JSON array whose elements are each a
    // command string or an argv array of strings, run in AGENT_REPO_PATH on
    // every chat turn (UserPromptSubmit hook). Which commands is instance data.
    CHAT_CONTEXT_COMMANDS: { type: 'string' },
    CHAT_MAX_TURNS: { type: 'number' },

    // Notify module (notification dispatcher + heartbeat registry)
    ENABLE_NOTIFY: { type: 'boolean', default: true },
    // Pushover — the sole notification channel (interrupt + notice + batched
    // digest flush). Values live in the pushover MCP config. The former Slack DM
    // digest channel was retired; notify no longer reads any SLACK_* var.
    PUSHOVER_TOKEN: { type: 'string' },
    PUSHOVER_USER: { type: 'string' },
    // Absolute path to the owner's agent repo clone (for manual
    // coverage-ledger files). Defaults to AGENT_REPO_PATH when unset.
    NOTIFY_AGENT_REPO_PATH: { type: 'string' },
    // Deprecated alias for NOTIFY_AGENT_REPO_PATH — still honored (with a
    // startup warning) so existing deploys keep working until their env is
    // updated. Remove once no deploy sets it.
    NOTIFY_HARI_REPO_PATH: { type: 'string' },
    // External coverage ledgers to watch — JSON array of
    // {"name": "...", "threshold": "<pg interval>", "path": "<repo-relative>"}.
    // Which ledgers exist is instance data; none are registered when unset.
    NOTIFY_COVERAGE_LEDGERS: { type: 'string' },
    // Host disk health.
    NOTIFY_DISK_PATH: { type: 'string', default: '/' },
    NOTIFY_DISK_MIN_FREE_GB: { type: 'number', default: 20 },
    NOTIFY_DISK_MIN_FREE_PCT: { type: 'number', default: 8 },
    NOTIFY_DISABLE_STALENESS: { type: 'boolean', default: false },
    NOTIFY_STALENESS_CRON: { type: 'string' },
    NOTIFY_DIGEST_FLUSH_CRON: { type: 'string' },

    // Session-spawn module (warm an interactive session, ping the phone with a
    // takeover link — the app-initiated gather-and-ping "spawn" half).
    ENABLE_SESSION_SPAWN: { type: 'boolean', default: true },
    // The spawn command as a JSON argv array of strings (same convention as
    // CHAT_CONTEXT_COMMANDS). Given a preload prompt (appended as a temp-file
    // path in the final argv slot), the command warms an RC session and prints
    // a takeover URL to stdout. Unset ⇒ spawning disabled (callers 503). Which
    // command + its working directory + auth are instance data, never in-repo.
    SESSION_SPAWN_CMD: { type: 'string' },
    // Wall-clock bound per spawn (ms); a slow/hung command fails loud.
    SESSION_SPAWN_TIMEOUT_MS: { type: 'number', default: 120_000 },
    // Model every spawned interactive session runs on — an alias (tracks the
    // latest in that tier) or a pinned model name. Explicit by default so a warm
    // session never inherits whichever model the owner last selected
    // interactively; a caller may override it per spawn.
    SESSION_SPAWN_MODEL: { type: 'string', default: 'opus' },

    // Ledger module (derived audit ledger + direct-write surface)
    ENABLE_LEDGER: { type: 'boolean', default: true },
    // Cron for the incremental derivation pass (default every 15 minutes).
    LEDGER_DERIVE_CRON: { type: 'string', default: '*/15 * * * *' },
    // Tool calls scanned + classified per derivation batch.
    LEDGER_DERIVE_BATCH_SIZE: { type: 'number', default: 1000 },
    // Disable the scheduled derivation (direct writes + queries still work).
    LEDGER_DISABLE_DERIVE: { type: 'boolean', default: false },

    // Slack urgency module (read-only urgency listener over the owner's Slack)
    ENABLE_SLACK_URGENCY: { type: 'boolean', default: false },
    // User token (xoxp-…) — reads AS the owner (same token slack-axi stores).
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
      MODEL_TIER_CLASSIFY?: string;
      MODEL_TIER_EXTRACT?: string;
      MODEL_TIER_VISION?: string;
      MODEL_TIER_SYNTHESIZE?: string;
      MODEL_KILL_SWITCH: boolean;
      MODEL_DAILY_BUDGET_USD?: number;
      MODEL_DAILY_BUDGET_TOKENS?: number;
      MODEL_TASK_BUDGETS_USD?: string;
      MODEL_PRICES?: string;
      MODEL_MAX_ATTEMPTS: number;
      MODEL_RETRY_BASE_MS: number;
      MODEL_TIMEOUT_MS?: number;
      ENABLE_APPROVALS: boolean;
      APPROVAL_EXPIRY_MS: number;
      APPROVAL_EXPIRE_CRON?: string;
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
      GOOGLE_URGENCY_TZ: string;
      GOOGLE_URGENCY_QUIET_START: number;
      GOOGLE_URGENCY_QUIET_END: number;
      GOOGLE_CONTACTS_FILE?: string;
      GOOGLE_CONTACTS_BIN?: string;
      GOOGLE_CONTACTS_ARGS: string;
      GOOGLE_OPPORTUNITY_PROMPT_FILE?: string;
      GOOGLE_EMAIL_DIGEST_CRON: string;
      GOOGLE_SPAM_QUARANTINE_CRON: string;
      GOOGLE_DIGEST_PAGE_URL?: string;

      // Capture module
      ENABLE_CAPTURE: boolean;
      CAPTURE_DISABLE_CLASSIFICATION: boolean;
      CAPTURE_CONCURRENCY: number;
      CAPTURE_CLASSIFIER_MODEL?: string;
      TANA_MCP_URL: string;
      TANA_MCP_TOKEN?: string;
      TANA_WORKSPACE_ID?: string;
      CAPTURE_ATTACHMENTS_BUCKET?: string;

      // Kitchen module
      ENABLE_KITCHEN: boolean;
      KITCHEN_DISABLE_ESTIMATION: boolean;
      KITCHEN_CONCURRENCY: number;
      KITCHEN_ESTIMATION_MODEL: string;
      KITCHEN_RECEIPT_MODEL: string;
      KITCHEN_PLAN_SESSION_MODEL?: string;
      KITCHEN_MAX_PHOTO_BYTES: number;
      KITCHEN_MAX_PHOTOS: number;
      KITCHEN_MEALBANK_REPO_PATH?: string;
      KITCHEN_MEALBANK_SHEET?: string;
      KITCHEN_TDEE_BASE?: number;
      KITCHEN_DAILY_TARGETS?: string;
      KITCHEN_OWNER_TZ?: string;
      KITCHEN_STRAVA_CLIENT_ID?: string;
      KITCHEN_STRAVA_CLIENT_SECRET?: string;
      KITCHEN_STRAVA_REFRESH_TOKEN?: string;
      KITCHEN_STRAVA_SYNC_MINUTES?: string;

      // Pages module
      ENABLE_PAGES: boolean;
      PAGES_BASE_URL?: string;

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

      // Per-meeting briefings (preps)
      ENABLE_MEETING_BRIEFINGS: boolean;
      MEETING_PREP_MODEL: string;
      MEETING_CONTEXT_BIN?: string;
      MEETING_CONTEXT_ARGS: string;
      MEETING_CRON: string;
      MEETING_REFRESH_AHEAD_HOURS: number;

      // Chat module
      ENABLE_CHAT: boolean;
      SLACK_BOT_TOKEN?: string;
      SLACK_APP_TOKEN?: string;
      SLACK_SIGNING_SECRET?: string;
      SLACK_OWNER_USER_ID?: string;
      AGENT_REPO_PATH?: string;
      BOT_USERNAME?: string;
      CLAUDE_CODE_OAUTH_TOKEN?: string;
      CHAT_CONTEXT_COMMANDS?: string;
      CHAT_MAX_TURNS?: number;

      // Notify module
      ENABLE_NOTIFY: boolean;
      PUSHOVER_TOKEN?: string;
      PUSHOVER_USER?: string;
      NOTIFY_AGENT_REPO_PATH?: string;
      /** @deprecated use NOTIFY_AGENT_REPO_PATH */
      NOTIFY_HARI_REPO_PATH?: string;
      NOTIFY_COVERAGE_LEDGERS?: string;
      NOTIFY_DISK_PATH: string;
      NOTIFY_DISK_MIN_FREE_GB: number;
      NOTIFY_DISK_MIN_FREE_PCT: number;
      NOTIFY_DISABLE_STALENESS: boolean;
      NOTIFY_STALENESS_CRON?: string;
      NOTIFY_DIGEST_FLUSH_CRON?: string;

      // Session-spawn module
      ENABLE_SESSION_SPAWN: boolean;
      SESSION_SPAWN_CMD?: string;
      SESSION_SPAWN_TIMEOUT_MS: number;
      SESSION_SPAWN_MODEL: string;

      // Ledger module
      ENABLE_LEDGER: boolean;
      LEDGER_DERIVE_CRON: string;
      LEDGER_DERIVE_BATCH_SIZE: number;
      LEDGER_DISABLE_DERIVE: boolean;

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
