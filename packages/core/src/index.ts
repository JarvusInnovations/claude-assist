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
