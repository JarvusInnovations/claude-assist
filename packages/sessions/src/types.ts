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
  type: 'user' | 'assistant' | 'queue-operation' | 'attachment';
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
  // Attachment-specific (Claude Code logs queued user prompts here)
  attachment?: {
    type: string;
    prompt?: string;
    commandMode?: string;
    [key: string]: unknown;
  };
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
 * A single tool invocation extracted from a transcript, for the tool_calls
 * index that powers cross-session tool search (#48). `msgUuid` is the durable
 * anchor; `msgIndex` is the message's ordinal position in the parsed stream.
 */
export interface ToolCall {
  msgUuid: string;
  msgIndex: number;
  ts: Date | null;
  toolName: string;
  target: string | null;
  isSidechain: boolean;
}

/** One row of `sessions.transcript_chunks` — an immutable slice of the archive. */
export interface TranscriptChunkRecord {
  id: number;
  sessionId: string;
  seq: number;
  byteStart: number;
  byteEnd: number;
  msgSeqStart: number;
  msgSeqEnd: number;
  content: string;
  contentHash: string;
}

/** One row of `sessions.transcript_messages` — (session, seq) -> uuid + chunk. */
export interface TranscriptMessageIndexRow {
  seq: number;
  uuid: string | null;
  chunkSeq: number;
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
  /** Prompt size on the last main-chain API call; null when never measured */
  contextFinalTokens: number | null;
  /** Largest prompt size observed on a main-chain API call */
  contextPeakTokens: number | null;
  /** Context window of the model that served the last main-chain call */
  contextLimitTokens: number | null;
  /** Model that served the last main-chain call */
  contextModel: string | null;
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
  /** Per-message tool invocations, for the tool_calls index (#48) */
  toolCalls: ToolCall[];
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
  /**
   * Raw JSONL content. A CLI built for the chunked-ingest protocol sends only
   * the tail after `sinceBytes` (from the inventory response's baseline for
   * this session); an older CLI sends the whole file and omits `sinceBytes`
   * (specs/behaviors/session-transcript-storage.md: "Satellite push"). The
   * server accepts both shapes — see `SyncService.processPush`.
   */
  transcript: string;
  /**
   * Byte offset in the on-disk file where `transcript` begins. Omitted means
   * `transcript` is the whole file (the legacy shape).
   */
  sinceBytes?: number;
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
  context_final_tokens: number | null;
  context_peak_tokens: number | null;
  context_limit_tokens: number | null;
  context_model: string | null;
  user_messages: string[];
  tools_used: string[];
  files_touched: FilesTouched;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  transcript_path: string | null;
  transcript_hash: string;
  search_text: string | null;
  /** Bytes of the on-disk transcript archived as chunks so far */
  ingested_bytes: number;
  /** Opaque incremental-parser resume state */
  parse_checkpoint: unknown | null;
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
  /** Failed outline-generation attempts; automatic sweeps stop retrying past OutlineService.MAX_OUTLINE_ATTEMPTS */
  outline_attempts: number;
  /** Models used in this session */
  models_used: string[];
  /** Per-model token breakdown */
  model_tokens: Record<string, ModelTokens>;
  /** Contiguous time ranges of user activity */
  activity_ranges: ActivityRange[];
}

/**
 * `SessionRecord` has no archive-content column to begin with — the archive
 * lives entirely in `sessions.transcript_chunks` (specs/behaviors/
 * session-transcript-storage.md: "Readers take ranges"). A caller that needs
 * transcript content fetches it separately through `TranscriptReader`, so a
 * session-detail lookup never pulls a potentially multi-GB archive over the
 * wire just to answer "what tools did this session use." Kept as its own
 * alias (rather than inlining `SessionRecord`) so routes that only need
 * metadata say so at the type level.
 */
export type SessionSummaryRecord = SessionRecord;

/**
 * Lightweight session inventory item for two-phase sync. `size` (the on-disk
 * byte count) is the chunked-ingest change signal — cheap (`stat` only) and
 * what lets the server tell the satellite exactly how many bytes to send
 * (specs/behaviors/session-transcript-storage.md: "Change detection uses size
 * and the last-chunk hash, not a whole-file MD5"). `transcriptHash` is kept
 * only so an older CLI's inventory item (no `size`) still round-trips; the
 * server falls back to whole-content hash comparison for those.
 */
export interface SessionInventoryItem {
  sessionId: string;
  transcriptPath: string;
  /** On-disk file size in bytes. Absent only from a pre-chunking CLI. */
  size?: number;
  signal?: SessionSignal;
  /** @deprecated legacy whole-file MD5, sent only by a pre-chunking CLI. */
  transcriptHash?: string;
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

/** Per-session baseline a satellite needs to send only its tail. */
export interface InventoryBaseline {
  /** Bytes already archived — the offset the satellite should read from. */
  ingestedBytes: number;
  /** Content hash of the last archived chunk, for the satellite's own
   * continuity check before it decides to trust `ingestedBytes` (optional —
   * today's CLI trusts the server and always sends from `ingestedBytes`). */
  lastChunkHash: string | null;
}

/**
 * Server response to inventory request
 */
export interface InventoryResponse {
  /** Session IDs that the server needs (new or changed) */
  neededSessionIds: string[];
  /** Sessions already up-to-date on server */
  upToDateCount: number;
  /**
   * Per-needed-session baseline so a chunked-ingest-aware CLI sends only the
   * tail. A session absent from this map (e.g. one the server has never seen)
   * has no baseline — the satellite sends the whole file from byte zero.
   */
  baselines: Record<string, InventoryBaseline>;
}
