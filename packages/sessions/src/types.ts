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
 * Parsed session data extracted from transcript
 */
export interface ParsedSession {
  sessionId: string;
  userMessages: string[];
  toolsUsed: string[];
  filesTouched: string[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  startedAt: Date | null;
  endedAt: Date | null;
  messageCount: number;
  gitBranch: string | null;
  claudeVersion: string | null;
}

/**
 * Discovered session from filesystem scan
 */
export interface DiscoveredSession {
  signal: SessionSignal;
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
}

export interface SessionPushData {
  signal: SessionSignal;
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
  files_touched: string[];
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  transcript_path: string | null;
  transcript_hash: string;
  raw_transcript: string;
  search_text: string | null;
  message_count: number;
  claude_version: string | null;
  synced_at: Date;
}
