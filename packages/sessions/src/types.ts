/**
 * Session signal file format (from ~/.claude/session-signals/*.ended.json)
 */
export interface SessionSignal {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name?: string;
  reason?: string;
  ended_at: string; // Unix timestamp as string
}

/**
 * Content block types in Claude messages
 */
export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;

/**
 * Token usage stats from assistant messages
 */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Transcript message format (JSONL line)
 */
export interface TranscriptMessage {
  type: 'user' | 'assistant' | 'queue-operation';
  sessionId: string;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  slug?: string;
  agentId?: string;
  isSidechain?: boolean;
  userType?: string;
  message?: {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
    model?: string;
    id?: string;
    type?: string;
    usage?: TokenUsage;
    stop_reason?: string | null;
  };
  // Queue operation specific
  operation?: 'queue' | 'dequeue';
}

/**
 * Per-model token breakdown
 */
export interface ModelTokens {
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * Files touched with operation type differentiation
 */
export interface FilesTouched {
  /** Files that were read (Read, Glob, Grep tools) */
  reads: string[];
  /** Files that were written/modified (Edit, Write, NotebookEdit tools) */
  writes: string[];
}

/**
 * A contiguous time range of user activity within a session
 */
export interface ActivityRange {
  start: string;
  end: string;
}

/**
 * Parsed session data extracted from transcript
 */
export interface ParsedSession {
  sessionId: string;
  userMessages: string[];
  toolsUsed: string[];
  filesTouched: FilesTouched;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  startedAt: Date | null;
  endedAt: Date | null;
  messageCount: number;
  gitBranch: string | null;
  claudeVersion: string | null;
  /** Working directory extracted from transcript messages */
  cwd: string | null;
  /** Number of JSONL lines that failed to parse */
  parseErrors: number;
  /** Models used in this session */
  modelsUsed: string[];
  /** Per-model token breakdown */
  modelTokens: Record<string, ModelTokens>;
  /** Contiguous time ranges of user activity (30-min gap threshold) */
  activityRanges: ActivityRange[];
  /** User-set custom session name (from Claude Code's /title rename), null if none */
  sessionName: string | null;
}

/**
 * Discovered session from filesystem scan
 * Signal is optional - sessions may be discovered by scanning projects directory
 * without a corresponding .ended.json signal file
 */
export interface DiscoveredSession {
  signal?: SessionSignal;
  sessionId: string;
  transcriptPath: string;
  transcriptContent: string;
  transcriptHash: string;
}

/**
 * Push payload from satellite machines
 */
export interface PushPayload {
  machineId: string;
  hostname?: string;
  sessions: SessionPushData[];
  /** Force re-parsing of sessions even if hash matches (for parser upgrades) */
  forceReparse?: boolean;
}

export interface SessionPushData {
  signal?: SessionSignal;
  sessionId: string;
  transcriptPath: string;
  transcript: string; // Raw JSONL content
}

/**
 * Sync operation result
 */
export interface SyncResult {
  sessionsScanned: number;
  sessionsIngested: number;
  sessionsUpdated: number;
  sessionsSkipped: number;
  errors: string[];
}

/**
 * Database record types
 */
export interface MachineRecord {
  id: number;
  machine_id: string;
  hostname: string | null;
  is_localhost: boolean;
  first_seen_at: Date;
  last_sync_at: Date | null;
  session_count: number;
}

export interface SessionRecord {
  id: string;
  machine_id: number;
  project_path: string | null;
  git_branch: string | null;
  started_at: Date;
  ended_at: Date | null;
  user_messages: string[];
  tools_used: string[];
  files_touched: FilesTouched;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  transcript_path: string | null;
  transcript_hash: string;
  raw_transcript: string;
  search_text: string | null;
  message_count: number;
  user_message_count: number;
  claude_version: string | null;
  synced_at: Date;
  /** AI-generated outline summarizing the session */
  outline: string | null;
  /** AI-generated concise title for the session */
  title: string | null;
  /** User-set custom session name (from Claude Code's /title rename) */
  session_name: string | null;
  /** transcript_hash when outline was generated (for regeneration detection) */
  outline_hash: string | null;
  /** Models used in this session */
  models_used: string[];
  /** Per-model token breakdown */
  model_tokens: Record<string, ModelTokens>;
  /** Contiguous time ranges of user activity */
  activity_ranges: ActivityRange[];
}

/**
 * Lightweight session inventory item for two-phase sync
 * Contains hash without full transcript content
 */
export interface SessionInventoryItem {
  sessionId: string;
  transcriptHash: string;
  transcriptPath: string;
  signal?: SessionSignal;
}

/**
 * Inventory payload for Phase 1 of two-phase sync
 */
export interface InventoryPayload {
  machineId: string;
  hostname?: string;
  inventory: SessionInventoryItem[];
  /** Force re-parsing of sessions even if hash matches (for parser upgrades) */
  forceReparse?: boolean;
}

/**
 * Server response to inventory request
 */
export interface InventoryResponse {
  /** Session IDs that the server needs (new or changed hash) */
  neededSessionIds: string[];
  /** Sessions already up-to-date on server */
  upToDateCount: number;
}
