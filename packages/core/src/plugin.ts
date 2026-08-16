import type { FastifyPluginAsync, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type postgres from 'postgres';
import type { Scheduler } from './scheduler.js';
import type { NotifyDispatcher, HeartbeatRegistry } from './notify.js';
import type { SessionSpawner } from './session-spawn.js';
import type { Ledger } from './ledger.js';
import type { ModelInvoker, ModelTier } from './invoker.js';
import type { ApprovalService } from './approvals.js';
import type { PagePublisher } from './page-publisher.js';

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
    /**
     * Audit-ledger direct-write surface. Present only when the ledger module is
     * loaded; transcript-less services call `fastify.ledger?.record(...)` to log
     * an action they perform at execution time.
     */
    ledger?: Ledger;
    /**
     * Session-spawn service — warms an interactive session through a configured
     * command and dispatches its takeover link through `notify`. Present only
     * when the session-spawn module is loaded; callers guard with
     * `fastify.sessionSpawner?.…`. When present but unconfigured
     * (`SESSION_SPAWN_CMD` unset), `spawn()` returns a `not_configured` record.
     */
    sessionSpawner?: SessionSpawner;
    /**
     * The single choke point for metered model calls. Present only when the
     * invoker module is loaded; a module that needs a model takes it from here
     * at registration and skips constructing its service when
     * `invoker.enabled` is false. See `specs/modules/invoker.md`.
     */
    invoker?: ModelInvoker;
    /**
     * Human-approval gates. Present only when the approvals module is loaded;
     * callers guard with `fastify.approvals?.…`. Never awaited — `request()`
     * records and notifies, and the caller returns.
     */
    approvals?: ApprovalService;
    /**
     * Server-side page publishing. Present only when the pages module is
     * loaded; a pipeline that renders a review page guards with
     * `fastify.pages?.publish(...)` and reports the surface as unavailable
     * rather than failing when it is absent.
     */
    pages?: PagePublisher;
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
  /** Configuration for slack-urgency plugin */
  slackUrgencyConfig?: SlackUrgencyPluginConfig;
  /** Configuration for briefing plugin */
  briefingConfig?: BriefingPluginConfig;
  /** Configuration for pages plugin */
  pagesConfig?: PagesPluginConfig;
  /** Configuration for ledger plugin */
  ledgerConfig?: LedgerPluginConfig;
  /** Configuration for kitchen plugin */
  kitchenConfig?: KitchenPluginConfig;
  /** Configuration for the training plugin */
  trainingConfig?: TrainingPluginConfig;
  /** Configuration for the invoker plugin */
  invokerConfig?: InvokerPluginConfig;
  /** Configuration for the approvals plugin */
  approvalsConfig?: ApprovalsPluginConfig;
  /** Configuration for the personal-finance plugin */
  financeConfig?: FinancePluginConfig;
}

/**
 * Which source the finance module pulls the ledger from.
 *
 * `api` talks to the provider's own (unofficial, undocumented) HTTP API.
 * `command` shells out to an operator-supplied exporter that speaks the
 * documented JSON contract — the seam for a headless-browser session on a
 * machine that stays logged in, for providers with no usable API or an API
 * that has drifted. There is deliberately no third mode: a source that cannot
 * be reached reports unavailable and the batch exits clean.
 */
export type FinanceSourceMode = 'api' | 'command';

/**
 * Configuration for the personal-finance plugin (ledger pull + monthly review
 * batch + transaction-workflow assist).
 *
 * PERSONAL DOMAIN. Every credential here belongs to the instance owner as a
 * private individual. Nothing this module reads or derives may be written to a
 * shared/team system of record — the module has no such write path, by
 * construction, and must not grow one.
 */
export interface FinancePluginConfig {
  /** Where transactions come from (default `api`). */
  sourceMode?: FinanceSourceMode;
  /**
   * Provider API base URL (FINANCE_API_BASE_URL). No default: which host
   * serves an unofficial API is instance data, and a wrong-but-plausible
   * default would send the owner's credentials somewhere they didn't choose.
   */
  apiBaseUrl?: string;
  /** Account identity for the provider login (FINANCE_API_EMAIL). */
  apiEmail?: string;
  /** Account password (FINANCE_API_PASSWORD). */
  apiPassword?: string;
  /**
   * Base32 TOTP secret for accounts with MFA (FINANCE_API_TOTP_SECRET).
   * Absent + MFA required ⇒ login fails loudly rather than half-succeeding.
   */
  apiTotpSecret?: string;
  /**
   * A pre-issued session token (FINANCE_API_TOKEN), for operators who would
   * rather mint one interactively than store a password. Present ⇒ the module
   * never sends credentials at all.
   */
  apiToken?: string;
  /**
   * Exporter binary for `command` mode (FINANCE_SOURCE_CMD), as a JSON argv
   * array. Receives the request as JSON on stdin and prints the documented
   * envelope to stdout. See the module's RUNBOOK.
   */
  sourceCommand?: string[];
  /** Wall-clock bound on an exporter run, ms (default 180000). */
  sourceCommandTimeoutMs?: number;
  /** IANA timezone the monthly period boundaries are computed in. Unset ⇒ UTC. */
  timeZone?: string;
  /** Currency code for rendering (default USD). */
  currency?: string;
  /** Cron for the monthly batch (default `0 13 3 * *` — the 3rd of the month). */
  reviewCron?: string;
  /** Skip the scheduled monthly batch (the API surface still works). */
  disableReview?: boolean;
  /**
   * Staleness threshold registered with the coverage ledger. Default
   * `40 days` — a month plus slack, so one skipped month pages and a batch
   * that merely runs late does not.
   */
  coverageThreshold?: string;
  /** Pin a model for the categorize/annotate assist, overriding the `classify` tier. */
  assistModel?: string;
  /** Max transactions handed to the assist per review (default 60). */
  assistLimit?: number;
  /** Skip the model-backed assist entirely; the review still renders. */
  disableAssist?: boolean;
  /** tana-local MCP endpoint for the review's Tana link. */
  tanaMcpUrl?: string;
  /** tana-local MCP Personal Access Token. */
  tanaMcpToken?: string;
  /** Tana workspace the review link is written into. Unset ⇒ no Tana link. */
  tanaWorkspaceId?: string;
}

/**
 * One recorded activity from the owner's exercise history, provider-agnostic.
 *
 * The generic shape exists so the module that owns the provider's OAuth
 * credentials also owns its token custody — exactly one refresh-token rotator
 * per upstream app — while any other module can consume the history without
 * holding a credential or importing the owning package.
 */
export interface ActivityHistoryRecord {
  id: string;
  /** The provider's sport/type string (e.g. `Run`, `Ride`). */
  sport: string;
  name: string;
  /** ISO instant the activity started. */
  startedAt: string;
  distanceMeters: number | null;
  movingSeconds: number | null;
  elevationGainMeters: number | null;
  averageHeartrate: number | null;
}

/** Activities on or after `since`, most-recent-inclusive. Throws on outage. */
export type ActivityHistoryProvider = (since: Date) => Promise<ActivityHistoryRecord[]>;

/**
 * Configuration for the training plugin (weekly adaptive training loop).
 */
export interface TrainingPluginConfig {
  /**
   * IANA timezone the plan week and the weekly cron are evaluated in. Unset
   * falls back to UTC — correct, and obviously wrong to anyone who meant a
   * local week, which is the point.
   */
  timeZone?: string;
  /**
   * What the owner is training for, in free text (TRAINING_GOAL_CONTEXT): the
   * race, the block, the constraints. Instance data — the toolkit ships no
   * default and encodes no athlete, goal, or plan of its own.
   */
  goalContext?: string;
  /**
   * Activity-history seam. Composed by the server from whichever module owns
   * the provider credentials. Absent ⇒ the week is planned without history,
   * and the synthesis is told so explicitly.
   */
  activityHistoryProvider?: ActivityHistoryProvider;
  /** Trailing activity window in days (default 42). */
  activityWindowDays?: number;
  /** Forecast API key (TRAINING_WEATHER_API_KEY). Absent ⇒ no forecast. */
  weatherApiKey?: string;
  /** Provider's opaque location id for the training area. */
  weatherLocationKey?: string;
  /** Forecast API base URL override (tests / proxies). */
  weatherBaseUrl?: string;
  /** Forecast horizon the account is entitled to (1 | 5 | 10 | 15). Default 5. */
  weatherDays?: number;
  /** gws-axi binary path for the availability read (default: `gws-axi`). */
  gwsAxiBin?: string;
  /** Calendar account override (default: the calendar CLI's own default). */
  calendarAccount?: string;
  /** Pin a model for the weekly synthesis, overriding the `synthesize` tier. */
  plannerModel?: string;
  /** Cron for weekly plan generation, evaluated in `timeZone`. Default `0 7 * * 0`. */
  planCron?: string;
  /** Cron for the approval-reconciliation pass. Default every 10 minutes. */
  reconcileCron?: string;
  /** Coverage-ledger staleness threshold. Default `9 days`. */
  staleAfter?: string;
  /** Skip the weekly generation schedule (reads + reconciliation still run). */
  disablePlanning?: boolean;
}

/**
 * Configuration for the invoker plugin — the single metered-model choke point.
 *
 * Every field here is a lever on spend or on which model does which job. Model
 * ids appear in `tierModels` and nowhere else in the system.
 */
export interface InvokerPluginConfig {
  /** The one metered credential. Absent leaves the invoker disabled. */
  anthropicApiKey?: string;
  /** Per-tier model overrides. Unset tiers fall back to the built-in map. */
  tierModels?: Partial<Record<ModelTier, string>>;
  /** Per-model price overrides, USD per million tokens. */
  prices?: Record<string, ModelPriceConfig>;
  /** Stop all metered invocation while leaving the host healthy. */
  killSwitch?: boolean;
  /** Rolling-window dollar ceiling. Unset means no dollar ceiling. */
  dailyBudgetUsd?: number;
  /** Rolling-window token ceiling. Unset means no token ceiling. */
  dailyBudgetTokens?: number;
  /** Per-task dollar ceilings, keyed by task id. */
  taskBudgetsUsd?: Record<string, number>;
  /** Transport attempts per call, including the first. Default 3. */
  maxAttempts?: number;
  /** First retry delay in ms; doubles with jitter. Default 500. */
  retryBaseMs?: number;
  /** Default wall-clock timeout in ms. Default 120000. */
  timeoutMs?: number;
}

/** USD per million tokens, by token class. */
export interface ModelPriceConfig {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

/** Configuration for the approvals plugin. */
export interface ApprovalsPluginConfig {
  /** Default lifetime of a pending request, ms. Default 24h. */
  defaultExpiryMs?: number;
  /** Cron for the expiry sweep. Default every 15 minutes. */
  expireCron?: string;
  /** Base URL a notification links to, so a human can act on the request. */
  baseUrl?: string;
}

/**
 * Configuration for the kitchen plugin (consumption journal — entries,
 * estimation, recipes).
 */
export interface KitchenPluginConfig {
  /**
   * Pin a model for the vision estimation call, overriding the `vision` tier.
   * Unset — the normal case — lets the invoker's tier map decide.
   */
  estimationModel?: string;
  /**
   * Pin a model for receipt-line extraction, overriding the `extract` tier.
   * The work is mechanical, which is why the cheap tier is the right default.
   */
  receiptModel?: string;
  /**
   * Model for the spawned interactive meal-planning session
   * (`KITCHEN_PLAN_SESSION_MODEL`) — this caller's override of the
   * instance-wide `SESSION_SPAWN_MODEL`. Unset ⇒ the instance default applies.
   *
   * NOT one of the metered models above: it selects the model an interactive
   * HUMAN session runs on under subscription auth (see
   * `specs/modules/session-spawn.md` § Model selection).
   */
  planSessionModel?: string;
  /** Parallelism for the estimation sweep (default 3). */
  concurrency?: number;
  /** Disable the scheduled estimation sweep. */
  disableEstimation?: boolean;
  /** Max bytes per uploaded photo (default 10 MiB). */
  maxPhotoBytes?: number;
  /** Max photo parts per entry (default 6). */
  maxPhotos?: number;
  /**
   * Absolute path to the instance's own repo clone, for the meal-bank
   * gitsheet read (KITCHEN_MEALBANK_REPO_PATH). Both this and
   * `mealBankSheet` are optional — unset degrades to recents-only reselect.
   */
  mealBankRepoPath?: string;
  /** Sheet name declared under that repo's .gitsheets/ (KITCHEN_MEALBANK_SHEET). */
  mealBankSheet?: string;
  /**
   * Owner's estimated non-exercise daily expenditure in kcal
   * (KITCHEN_TDEE_BASE) — opaque instance config the module never guesses or
   * auto-tunes (§ Expenditure & net energy). Unset ⇒ the net line is omitted.
   */
  tdeeBase?: number;
  /**
   * Owner-set per-nutrient daily reference lines (KITCHEN_DAILY_TARGETS) —
   * raw JSON mapping panel fields to exactly one of {"max": N} / {"min": N},
   * parsed and validated at plugin init (§ Daily targets). Malformed ⇒ boot
   * failure; unset ⇒ the summary's targets block is omitted.
   */
  dailyTargets?: string;
  /**
   * Owner's IANA timezone (KITCHEN_OWNER_TZ) — the one source of truth for
   * every local-day boundary the module computes (§ Timezone & local-day
   * bucketing). Unset ⇒ UTC fallback, stated in affected output; a
   * present-but-invalid zone fails boot loudly at plugin init.
   */
  ownerTz?: string;
  /**
   * Strava API application client id (KITCHEN_STRAVA_CLIENT_ID). All three
   * Strava credentials present ⇒ the scheduled activity sync runs; any
   * absent ⇒ the feature is entirely off (§ Strava activity sync).
   */
  stravaClientId?: string;
  /** Strava API application client secret (KITCHEN_STRAVA_CLIENT_SECRET). */
  stravaClientSecret?: string;
  /**
   * Strava refresh token (KITCHEN_STRAVA_REFRESH_TOKEN) — the FIRST-BOOT
   * SEED only. Strava rotates refresh tokens, so once kitchen.strava_oauth
   * has a row the stored token is authoritative and this value is ignored
   * (delete the row to re-seed after a revocation).
   */
  stravaRefreshToken?: string;
  /**
   * Sync cadence in minutes (KITCHEN_STRAVA_SYNC_MINUTES, default 30) — raw
   * string, parsed boot-loud at plugin init (malformed ⇒ startup failure,
   * same doctrine as dailyTargets).
   */
  stravaSyncMinutes?: string;
  /** Skip the scheduled Strava sync (folded from DISABLE_SYNCS). */
  disableStravaSync?: boolean;
}

/**
 * Configuration for the ledger plugin (derived audit ledger + direct writes).
 */
export interface LedgerPluginConfig {
  /**
   * Instance-specific extraction rules, appended after the built-in set.
   * The seam that keeps one operator's CLI names out of a public toolkit —
   * see the ledger module's `EXAMPLE_EXTRA_RULES`.
   */
  extraRules?: Array<{
    name: string;
    tool: string;
    toolPrefix?: boolean;
    pattern: string;
    exclude?: string;
    actionType: string;
    targetSystem: string;
    summary?: string;
  }>;
  /**
   * Suffix appended to the built-in `RULES_VERSION`. Bump it after changing
   * `extraRules` to re-derive the historical corpus under the new ruleset.
   */
  rulesVersionSuffix?: string;
  /** Cron for the incremental derivation pass (default every 15 min). */
  deriveCron?: string;
  /** Tool-calls scanned per derivation batch (default 1000). */
  batchSize?: number;
  /** Skip the scheduled derivation pass (direct writes + queries still work). */
  disableDerivation?: boolean;
}

/**
 * Configuration for the slack-urgency plugin (read-only urgency listener).
 */
export interface SlackUrgencyPluginConfig {
  /** Slack USER token (xoxp-…) — the poller reads AS the owner (same token slack-axi stores). */
  userToken?: string;
  /** Slack user id of the owner. Messages from this id never interrupt. */
  ownerId?: string;
  /** Team roster: CSV/newline `id=Name` pairs (SLACK_URGENCY_ROSTER). */
  roster?: string;
  /** Channel ids to watch beyond DMs. */
  watchChannels?: string[];
  /** Pin a model for the residue pass, overriding the `classify` tier. */
  model?: string;
  /** IANA time zone for quiet hours. Unset falls back to UTC. */
  timeZone?: string;
  /** Quiet-hours window start hour 0–23 (default 22). */
  quietStartHour?: number;
  /** Quiet-hours window end hour 0–23 (default 7). */
  quietEndHour?: number;
  /** Per-thread interrupt cooldown in minutes (default 30). */
  cooldownMinutes?: number;
  /** Max messages pulled per conversation per cycle (default 50). */
  historyLimit?: number;
  /** Cron for the poll loop (default every minute). */
  pollCron?: string;
  /**
   * Target wall-clock time (ms) to sweep every DM + watch channel once.
   * `conversations.history` calls are staggered evenly across this window
   * instead of bursting, to stay under Slack's history rate limits
   * (SLACK_URGENCY_POLL_INTERVAL_MS; default 5 minutes).
   */
  cycleIntervalMs?: number;
  /** Disable the poll loop. */
  disablePolling?: boolean;
}

/**
 * Configuration for the briefing plugin (daily briefing + meeting alerts).
 */
export interface BriefingPluginConfig {
  /**
   * Pin a model for the join-required residue classifier, overriding the
   * `classify` tier.
   */
  classifierModel?: string;
  /** IANA timezone for "today" + the briefing cron. Unset falls back to UTC. */
  timeZone?: string;
  /** gws-axi binary path (default: `gws-axi` on PATH). */
  gwsAxiBin?: string;
  /**
   * Optional "open commitments" source: path to any CLI that emits the
   * documented TOON commitments table. When unset, the commitments section is
   * omitted from the briefing.
   */
  commitmentsBin?: string;
  /** Args passed to the commitments CLI (default: ['commitment', 'list']). */
  commitmentsArgs?: string[];
  /** Calendar account override (default: the calendar CLI's own default account). */
  calendarAccount?: string;
  /** tana-local MCP endpoint (default: http://127.0.0.1:8262/mcp). */
  tanaMcpUrl?: string;
  /** tana-local MCP Personal Access Token (render target). */
  tanaMcpToken?: string;
  /** Tana workspace whose day node the briefing is written into. */
  tanaWorkspaceId?: string;
  /** Base URL for links out to richer claude-assist pages. */
  pageBaseUrl?: string;
  /** Cron for the morning briefing (evaluated in timeZone). Default 30 6 * * *. */
  briefingCron?: string;
  /** Cron for the alert evaluation cycle. Default every 2 min. */
  alertCron?: string;
  /** Rolling look-ahead (minutes) for the alert cycle window. Default 60. */
  alertWindowMinutes?: number;
  /** Skip the morning briefing schedule. */
  disableBriefing?: boolean;
  /** Skip the meeting-alert schedule. */
  disableAlerts?: boolean;

  // ── Per-meeting briefings (preps on the virtuous cycle) ──────────────────
  /** Skip the per-meeting briefing (prep) cycle. */
  disableMeetingBriefings?: boolean;
  /**
   * Pin a model for the prep composer, overriding the `synthesize` tier.
   * Composing a prep is judgment work, which is why it defaults to the strong
   * tier rather than the classifier's.
   */
  meetingPrepModel?: string;
  /**
   * Optional pluggable prior-occurrence context source: a CLI that receives
   * occurrence metadata as JSON on stdin (+ --series-key/--occurrence-key args)
   * and returns context text (HQ timelines, transcripts, Slack) on stdout.
   * Unset → the prior-context section is simply omitted.
   */
  meetingContextBin?: string;
  /** Args passed to the context CLI before the derived flags. */
  meetingContextArgs?: string[];
  /** Cron for the meeting-cycle pass (server local / UTC). Default every 30 min. */
  meetingCron?: string;
  /** Refresh occurrences starting within this many hours (the ~24h trigger). Default 26. */
  meetingRefreshAheadHours?: number;
  /**
   * Phase-2 kitchen seam: provider of the kitchen module's merged recipe view
   * (sheet + pushed + promoted) for stock-aware meal suggestions. Composed by
   * the server from the kitchen module's decorated `fastify.kitchenRecipes`
   * surface. When absent, the briefing source falls back to a direct SQL read
   * of DB-persisted recipes only (sheet recipes won't participate).
   */
  kitchenRecipesProvider?: KitchenRecipesProvider;
}

/**
 * One external coverage ledger the staleness monitor watches: a markdown file
 * in the agent repo whose "through <date>" line is the coverage watermark.
 */
export interface CoverageLedgerConfig {
  /** Pipeline name the ledger registers as (e.g. `harvest-coverage`). */
  name: string;
  /** Postgres interval string — alert when the watermark is older (e.g. `14 days`). */
  threshold: string;
  /** Ledger file path relative to `agentRepoPath`. */
  path: string;
}

/**
 * Configuration for the notify (notification dispatcher + heartbeat) plugin
 */
export interface NotifyPluginConfig {
  /** Pushover application API token (the sole delivery channel). */
  pushoverToken?: string;
  /** Pushover user/group key (recipient). */
  pushoverUser?: string;
  /** Absolute path to the owner's agent repo clone (for manual coverage-ledger files). */
  agentRepoPath?: string;
  /**
   * External coverage ledgers to watch (instance data — from
   * NOTIFY_COVERAGE_LEDGERS). Paths are relative to `agentRepoPath`.
   */
  coverageLedgers?: CoverageLedgerConfig[];
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
  /** Concurrency for outline generation */
  outlineConcurrency?: number;
  /** Disable local filesystem scanning */
  disableLocalIngest?: boolean;
  /** Disable AI outline generation */
  disableGenerateOutlines?: boolean;
  /**
   * Prompt substrings that mark a session for ingest suppression — the seam
   * for whatever local automation floods this instance's archive. Which
   * automation that is, is instance data; the toolkit ships no defaults.
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
  /**
   * Commands (argv arrays) whose stdout is injected as live context on every
   * agent turn via a UserPromptSubmit hook. Run with cwd = agentRepoPath.
   */
  contextCommands?: string[][];
  /**
   * Maximum agent turns per query before the SDK aborts the run. Working
   * sessions that drive CLIs burn a turn per tool round, so size this to the
   * longest workflow the agent should finish, not to a chat-length exchange.
   */
  maxTurns?: number;
}

/**
 * Configuration for the capture plugin
 */
/**
 * Outcome of handing an ambient remark to the kitchen module's event
 * resolver. Intentionally minimal + kitchen-type-free so the capture package
 * can depend on it without importing the kitchen package (the server composes
 * the concrete resolver from the kitchen module's decorated surface).
 */
export interface KitchenEventOutcome {
  matched: boolean;
  itemUlid?: string;
  eventType?: string;
}

export type KitchenEventResolver = (remark: string) => Promise<KitchenEventOutcome>;

/**
 * One recipe in the kitchen module's merged recipe view (sheet + pushed +
 * promoted — whatever the reselect pipeline merges), reduced to what a
 * stock-aware consumer needs. Kitchen-type-free so the briefing package can
 * depend on it without importing the kitchen package.
 */
export interface KitchenRecipeSummary {
  name: string;
  /** Component/ingredient labels ([] for a componentless recipe). */
  component_labels: string[];
}

export type KitchenRecipesProvider = () => Promise<KitchenRecipeSummary[]>;

export interface CapturePluginConfig {
  /** Pin a model for capture classification, overriding the `classify` tier. */
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
  /**
   * Object-store bucket for capture attachments. When unset, the attachment
   * feature is disabled (sign endpoint 503s; attachment-bearing captures are
   * rejected). Credentials come from Google Application Default Credentials.
   */
  attachmentsBucket?: string;
  /**
   * Phase-2 seam: resolver for the `kitchen_event` capture type. Composed by
   * the server from the kitchen module's decorated `fastify.kitchenEvents`
   * surface and injected here. When absent, a `kitchen_event` capture parks in
   * awaiting_executor (no executor registered) until the resolver is wired.
   */
  kitchenEventResolver?: KitchenEventResolver;
}

export interface GooglePluginConfig {
  /** Google OAuth client ID */
  clientId: string;
  /** Google OAuth client secret */
  clientSecret: string;
  /** OAuth redirect URI */
  redirectUri: string;
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
  /** IANA time zone for the urgency quiet-hours window. Unset falls back to UTC. */
  urgencyTimeZone?: string;
  /** Quiet-hours window start hour 0–23 (default 22). INTERRUPTs inside it are held. */
  urgencyQuietStartHour?: number;
  /** Quiet-hours window end hour 0–23 (default 7). */
  urgencyQuietEndHour?: number;
  /**
   * Path to a newline-delimited file of individual client-contact addresses. These
   * get "individual standing" in the urgency bar (substantive mail from them can
   * reach ATTENTION). Instance data — the toolkit only knows "a list of emails".
   */
  contactsFile?: string;
  /** Alternatively, a CLI that prints contact addresses (one per line) to stdout. */
  contactsBin?: string;
  /** Args for the contacts CLI. */
  contactsArgs?: string[];
  /**
   * Path to an owner-maintained interest specification used to evaluate
   * solicitation-class (RFP/RFQ/RFI) mail. When unset, the opportunity path is
   * off. Instance data — its contents never enter the toolkit.
   */
  opportunityPromptFile?: string;
  /** Cron for the daily confirm-to-execute digest (default '0 12 * * *' ~08:00 ET). */
  emailDigestCron?: string;
  /** Cron for the weekly spam-quarantine review digest (default '0 13 * * 1'). */
  spamQuarantineDigestCron?: string;
  /**
   * Absolute URL of the interactive digest page — carried in the daily digest
   * Pushover notice's button slot so the ping opens the dashboard. Instance
   * data (e.g. https://assist.example.com/digest); the ping omits the button
   * when unset.
   */
  emailDigestPageUrl?: string;

  // ── Tiered unsubscribe automation ─────────────────────────────────────────
  /**
   * Master switch for unsubscribe automation. OFF by default: it acts
   * irreversibly on the owner's list memberships, so it turns on by explicit
   * choice, never by upgrade. Also requires the action layer (disabled whenever
   * `disableEmailActions` is set).
   */
  unsubscribeEnabled?: boolean;
  /** Cron for the unsubscribe cycle (default '17 * * * *' — hourly). */
  unsubscribeCron?: string;
  /** Cron for the tier-3 review-queue digest (default '0 14 * * 1'). */
  unsubscribeReviewCron?: string;
  /** Attempts worked per cycle (default 10). */
  unsubscribeMaxPerRun?: number;
  /** Rolling rate-limit window in minutes (default 60). */
  unsubscribeRateWindowMinutes?: number;
  /** Max executed unsubscribes per sender-domain per window (default 3). */
  unsubscribeRateMaxPerDomain?: number;
  /**
   * Tier 2 (browser-driven forms). Needs a reachable browser-automation bridge,
   * usually on a separate always-on host; opted into separately from tier 1
   * because that dependency can simply be absent. Without it, tier-2 senders
   * route to the review queue instead.
   */
  unsubscribeBrowserEnabled?: boolean;
  /**
   * The browser-automation CLI (e.g. a Chrome DevTools bridge client). Instance
   * data — the toolkit knows the verb set (`open` / `eval` / `screenshot`), not
   * which binary or host provides it.
   */
  unsubscribeBrowserBin?: string;
  /** Per-command timeout for the browser CLI (default 60000). */
  unsubscribeBrowserTimeoutMs?: number;
  /** Directory tier-2 screenshots are written to; the ledger carries the path. */
  unsubscribeProofDir?: string;
}

/**
 * A worksheet's `cook_mode` disposition — what submitting it WRITES.
 *
 * The distinction is doctrine, not a flag: **packing is a conversion, eating is
 * an entry.** Packing food creates stock that will be eaten later, possibly
 * differently than planned; pre-logging it as consumption makes the journal lie
 * the moment plans change. See specs/modules/kitchen.md § Cook mode.
 */
export type WorksheetCookDisposition = 'eaten' | 'packed';

/**
 * What the pages module hands its cook sink on a worksheet submission —
 * deliberately domain-type-free (plain strings and numbers), so the pages
 * package never imports the kitchen package. `totals` keys are the worksheet's
 * declared field keys; validating them against a real nutrition panel is the
 * SINK's job, because that is where the domain lives.
 */
/** One component <-> stock binding for an `eaten` sheet. */
export interface WorksheetConsumeBinding {
  /** Must match a component's `label` exactly. */
  component: string;
  item_ulid: string;
  /**
   * How the item is quantified. `divisible` reads the component quantity as a
   * mass and needs the product's `net_content_g`; `counted` reads it as whole
   * units. Stated by the publisher — never inferred from the number itself.
   */
  model: 'divisible' | 'counted';
}

export interface WorksheetCookRequest {
  /**
   * The client-supplied idempotency key — the submitted worksheet's
   * `submission_key`, a ULID. The sink must treat it as the identity of the
   * write it performs (the entry's ULID when eaten, the derived item's when
   * packed) so a resubmission cannot double-write.
   */
  ulid: string;
  disposition: WorksheetCookDisposition;
  /** Names the resulting entry / derived item. */
  label: string;
  /** Server-computed totals: field key → value, null when unknown. */
  totals: Record<string, number | null>;
  /** What was weighed, for the provenance note. */
  components: { label: string; quantity: number }[];
  /** Quantity unit the components are stated in (e.g. `g`). */
  unit: string;
  /** Event time (ISO); the sink defaults to now. */
  at?: string;
  /** The submitter's free-text remark, if any. */
  note?: string;
  /**
   * `eaten` only — component↔stock bindings to decrement, carried through from
   * the published directive. The sink resolves each binding's SUBMITTED
   * quantity from `components`.
   */
  consumes?: WorksheetConsumeBinding[];
  /** `packed` only — describes the derived item and what it was made from. */
  packed?: {
    units?: number;
    shelf_life_class?: string;
    recipe_ulid?: string;
    sources?: { item_ulid: string; amount?: number }[];
  };
}

export interface WorksheetCookOutcome {
  /** `entry` = a journal entry (eaten); `item` = prepped stock (packed). */
  kind: 'entry' | 'item';
  /** The ULID of the written row — equal to the request's `ulid`. */
  ulid: string;
  /** False on an idempotent replay: nothing was written a second time. */
  created: boolean;
}

/**
 * The cook-mode seam. Composed by the server from a domain module's decorated
 * surface and injected here; the pages module calls it and knows nothing else
 * about it. Absent → a cook-mode worksheet submission reports `unavailable`
 * rather than silently landing in the queue as if it had been logged.
 */
export interface WorksheetCookSink {
  cook(request: WorksheetCookRequest): Promise<WorksheetCookOutcome>;
}

/**
 * Configuration for the pages plugin (publish + collect interactive HTML pages).
 */
export interface PagesPluginConfig {
  /**
   * Override for the base URL used in publish responses + notify links
   * (default: derived from the request's forwarded-proto/host headers).
   */
  baseUrl?: string;
  /**
   * Sink for worksheet cook-mode submissions (§ Cook mode). Injected by the
   * server from the kitchen module's decorated surface, so the two packages
   * never import each other.
   */
  worksheetCookSink?: WorksheetCookSink;
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
      slackUrgencyConfig: opts.slackUrgencyConfig,
      briefingConfig: opts.briefingConfig,
      pagesConfig: opts.pagesConfig,
      ledgerConfig: opts.ledgerConfig,
      kitchenConfig: opts.kitchenConfig,
      trainingConfig: opts.trainingConfig,
      invokerConfig: opts.invokerConfig,
      approvalsConfig: opts.approvalsConfig,
      financeConfig: opts.financeConfig,
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
