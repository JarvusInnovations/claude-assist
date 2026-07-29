// Scheduler
export {
  createScheduler,
  type ScheduledTask,
  type Scheduler,
} from './scheduler.js';

// Migrations
export {
  runMigrations,
  getMigrationStatus,
  type MigrationConfig,
} from './migrations.js';

// Search
export {
  createSearchHelpers,
  createSearchTriggerSQL,
  type SearchHelpers,
  type ParameterizedSQL,
} from './search.js';

// Plugin
export {
  createPlugin,
  type PluginOptions,
  type ModulePlugin,
  type SessionsPluginConfig,
  type GooglePluginConfig,
  type ChatPluginConfig,
  type NotifyPluginConfig,
  type CoverageLedgerConfig,
  type CapturePluginConfig,
  type SlackUrgencyPluginConfig,
  type BriefingPluginConfig,
  type PagesPluginConfig,
  type WorksheetCookSink,
  type WorksheetCookRequest,
  type WorksheetCookOutcome,
  type WorksheetCookDisposition,
  type LedgerPluginConfig,
  type KitchenPluginConfig,
  type KitchenEventResolver,
  type KitchenEventOutcome,
  type KitchenRecipesProvider,
  type KitchenRecipeSummary,
} from './plugin.js';

// Tana MCP client (shared by capture's inbox executor + the briefing render)
export {
  TanaMcpClient,
  parseMcpBody,
  type TanaMcpConfig,
} from './tana-mcp.js';

// Notification + heartbeat contracts
export type {
  NotificationPriority,
  NotificationChannel,
  NotificationStatus,
  NotifyInput,
  NotifyResult,
  NotifyDispatcher,
  HeartbeatOptions,
  HeartbeatRegistration,
  HeartbeatRow,
  HeartbeatRegistry,
} from './notify.js';

// Audit-ledger contract (direct-write surface)
export type { Ledger, LedgerActor, LedgerRecordInput } from './ledger.js';

// Session-spawn contract (warm an interactive session, dispatch its takeover link)
export type {
  SpawnRequest,
  SpawnStatus,
  SpawnRecord,
  SessionSpawner,
} from './session-spawn.js';
