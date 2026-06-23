import type {
  TranscriptMessage,
  ParsedSession,
  ContentBlock,
  ToolUseBlock,
  ModelTokens,
  FilesTouched,
  ActivityRange,
  ToolCall,
} from './types.js';
import { extractToolTarget } from './transcript.js';

/**
 * File operation type for classification
 */
type FileOperation = 'read' | 'write';

/**
 * Tool to file operation mapping
 * Read operations: tools that read file contents
 * Write operations: tools that modify file contents
 */
const TOOL_OPERATIONS: Record<string, FileOperation | null> = {
  // Read operations
  Read: 'read',
  Glob: 'read',
  Grep: 'read',

  // Write operations
  Edit: 'write',
  Write: 'write',
  NotebookEdit: 'write',

  // Tools that don't directly touch files (or are ambiguous)
  Bash: null,
  Task: null,
};

/** Gap threshold for activity range segmentation (30 minutes) */
const ACTIVITY_GAP_MS = 30 * 60 * 1000;

/**
 * Compute contiguous activity ranges from user message timestamps.
 * A new range starts when the gap between consecutive messages exceeds the threshold.
 */
function computeActivityRanges(timestamps: Date[]): ActivityRange[] {
  if (timestamps.length < 2) return [];

  const sorted = [...timestamps].sort((a, b) => a.getTime() - b.getTime());
  const ranges: ActivityRange[] = [];

  let rangeStart = sorted[0]!;
  let rangeEnd = sorted[0]!;

  for (let i = 1; i < sorted.length; i++) {
    const ts = sorted[i]!;
    if (ts.getTime() - rangeEnd.getTime() > ACTIVITY_GAP_MS) {
      ranges.push({ start: rangeStart.toISOString(), end: rangeEnd.toISOString() });
      rangeStart = ts;
    }
    rangeEnd = ts;
  }
  ranges.push({ start: rangeStart.toISOString(), end: rangeEnd.toISOString() });

  return ranges;
}

/**
 * Parse a JSONL transcript and extract structured data
 * Following the Kuato pattern: extract user messages, tools, files, tokens
 *
 * Note: Claude's transcript logs multiple messages per API response (streaming updates).
 * Token counting requires careful handling:
 * - input_tokens and cache_read_input_tokens: constant within a chain, count from first message
 * - output_tokens: cumulative during streaming, count from last message (max value in chain)
 *
 * A "chain" is identified by messages linked via parentUuid where each has usage data.
 * The first message in a chain has a parentUuid pointing to a non-usage message (e.g., user).
 */
export function parseTranscript(
  sessionId: string,
  jsonlContent: string
): ParsedSession {
  const lines = jsonlContent.trim().split('\n');

  const userMessages: string[] = [];
  const userTimestamps: Date[] = [];
  const toolsUsed = new Set<string>();
  const toolCalls: ToolCall[] = [];
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  const modelsUsed = new Set<string>();
  const modelTokens: Record<string, ModelTokens> = {};

  let inputTokens = 0;
  let cacheReadTokens = 0;
  let startedAt: Date | null = null;
  let endedAt: Date | null = null;
  let messageCount = 0;
  let gitBranch: string | null = null;
  let claudeVersion: string | null = null;
  let cwd: string | null = null;
  let parseErrors = 0;

  // First pass: collect UUIDs of messages that have usage data
  // This allows us to deduplicate streaming messages in the second pass
  const messagesWithUsage = new Set<string>();
  const parsedMessages: TranscriptMessage[] = [];
  // User-set custom session name (last occurrence wins — renames overwrite the line)
  let sessionName: string | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const raw = JSON.parse(line) as { type?: string; customTitle?: string };

      // Special line type written by Claude Code when the user renames the session
      if (raw.type === 'custom-title' && typeof raw.customTitle === 'string') {
        const trimmed = raw.customTitle.trim();
        sessionName = trimmed.length > 0 ? trimmed : null;
        continue;
      }

      const msg = raw as TranscriptMessage;
      parsedMessages.push(msg);

      // Track UUIDs of messages with usage data
      if (msg.type === 'assistant' && msg.message?.usage && msg.uuid) {
        messagesWithUsage.add(msg.uuid);
      }
    } catch {
      parseErrors++;
    }
  }

  // Track max output tokens per chain root (for cumulative output token handling)
  // Key is the chain root (parentUuid of first message), value is {model, maxOutput}
  const chainOutputs = new Map<string, { model: string | undefined; maxOutput: number }>();

  // Second pass: process messages, deduplicating token counts.
  // The loop index is the message's ordinal position in the parsed stream — it
  // becomes msg_index in the tool_calls table and the windowing anchor offset.
  for (let msgIndex = 0; msgIndex < parsedMessages.length; msgIndex++) {
    const msg = parsedMessages[msgIndex]!;
    // Track timestamps
    if (msg.timestamp) {
      const ts = new Date(msg.timestamp);
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!endedAt || ts > endedAt) endedAt = ts;
    }

    // Track metadata from first message
    if (msg.gitBranch && !gitBranch) {
      gitBranch = msg.gitBranch;
    }
    if (msg.version && !claudeVersion) {
      claudeVersion = msg.version;
    }
    if (msg.cwd && !cwd) {
      cwd = msg.cwd;
    }

    // Skip queue operations
    if (msg.type === 'queue-operation') continue;

    messageCount++;

    // Extract user messages
    if (msg.type === 'user' && msg.message) {
      const text = extractTextContent(msg.message.content);
      if (text) {
        userMessages.push(text);
        if (msg.timestamp) {
          userTimestamps.push(new Date(msg.timestamp));
        }
      }
    }

    // Extract queued user prompts (typed while assistant was busy).
    // Claude Code persists these as attachments with attachment.type === 'queued_command'
    // and the user's text in attachment.prompt — not as type === 'user' messages.
    if (
      msg.type === 'attachment' &&
      msg.attachment?.type === 'queued_command' &&
      typeof msg.attachment.prompt === 'string' &&
      msg.attachment.prompt.length > 0
    ) {
      userMessages.push(msg.attachment.prompt);
      if (msg.timestamp) {
        userTimestamps.push(new Date(msg.timestamp));
      }
    }

    // Extract tools and files from assistant messages
    if (msg.type === 'assistant' && msg.message) {
      // Track model usage
      const model = msg.message.model;
      if (model) {
        modelsUsed.add(model);
        if (!modelTokens[model]) {
          modelTokens[model] = { input: 0, output: 0, cacheRead: 0 };
        }
      }

      // Track token usage with proper deduplication
      if (msg.message.usage) {
        const usage = msg.message.usage;
        const isFirstInChain = !msg.parentUuid || !messagesWithUsage.has(msg.parentUuid);

        // Input and cache_read are constant within a chain - count from first message only
        if (isFirstInChain) {
          inputTokens += usage.input_tokens ?? 0;
          cacheReadTokens += usage.cache_read_input_tokens ?? 0;

          // Per-model tracking for input/cache_read
          if (model) {
            modelTokens[model]!.input += usage.input_tokens ?? 0;
            modelTokens[model]!.cacheRead += usage.cache_read_input_tokens ?? 0;
          }
        }

        // Output tokens are cumulative - track max per chain
        // Find the chain root by walking up to the first message
        let chainRoot = msg.parentUuid || msg.uuid;
        if (isFirstInChain) {
          chainRoot = msg.parentUuid || msg.uuid;
        } else {
          // Walk up the chain to find the root
          let current = msg.parentUuid;
          while (current && messagesWithUsage.has(current)) {
            // Find the message with this UUID to get its parent
            const parentMsg = parsedMessages.find(m => m.uuid === current);
            if (parentMsg?.parentUuid && messagesWithUsage.has(parentMsg.parentUuid)) {
              current = parentMsg.parentUuid;
            } else {
              chainRoot = parentMsg?.parentUuid || current;
              break;
            }
          }
        }

        const outputValue = usage.output_tokens ?? 0;
        const existing = chainOutputs.get(chainRoot);
        if (!existing || outputValue > existing.maxOutput) {
          chainOutputs.set(chainRoot, { model, maxOutput: outputValue });
        }
      }

      // Extract tool uses
      const tools = extractToolUses(msg.message.content);
      for (const tool of tools) {
        toolsUsed.add(tool.name);

        // Index this call for cross-session tool search (#48)
        if (msg.uuid) {
          toolCalls.push({
            msgUuid: msg.uuid,
            msgIndex,
            ts: msg.timestamp ? new Date(msg.timestamp) : null,
            toolName: tool.name,
            target: extractToolTarget(tool),
            isSidechain: msg.isSidechain ?? false,
          });
        }

        // Extract file paths and classify by operation type
        const fileTouch = extractFileTouch(tool);
        if (fileTouch) {
          if (fileTouch.operation === 'read') {
            filesRead.add(fileTouch.path);
          } else {
            filesWritten.add(fileTouch.path);
          }
        }
      }
    }
  }

  // Sum up output tokens from chain maximums and update per-model tracking
  let outputTokens = 0;
  for (const [, { model, maxOutput }] of chainOutputs) {
    outputTokens += maxOutput;
    if (model && modelTokens[model]) {
      modelTokens[model]!.output += maxOutput;
    }
  }

  return {
    sessionId,
    userMessages,
    toolsUsed: [...toolsUsed],
    filesTouched: {
      reads: [...filesRead],
      writes: [...filesWritten],
    },
    inputTokens,
    outputTokens,
    cacheReadTokens,
    startedAt,
    endedAt,
    messageCount,
    gitBranch,
    claudeVersion,
    cwd,
    parseErrors,
    modelsUsed: [...modelsUsed],
    modelTokens,
    activityRanges: computeActivityRanges(userTimestamps),
    sessionName,
    toolCalls,
  };
}

/**
 * Extract text content from message content (string or array of blocks)
 */
function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Extract tool use blocks from message content
 */
function extractToolUses(content: string | ContentBlock[]): ToolUseBlock[] {
  if (typeof content === 'string') {
    return [];
  }

  return content.filter(
    (block): block is ToolUseBlock => block.type === 'tool_use'
  );
}

interface FileTouch {
  path: string;
  operation: FileOperation;
}

/**
 * Extract file path and operation type from tool input
 * Handles Read, Edit, Write, Glob, Grep, NotebookEdit tools
 */
function extractFileTouch(tool: ToolUseBlock): FileTouch | null {
  const operation = TOOL_OPERATIONS[tool.name];
  if (!operation) return null;

  const input = tool.input;
  if (!input || typeof input !== 'object') return null;

  // Common file path keys used by Claude tools
  const pathKeys = ['file_path', 'path', 'file', 'filename', 'filePath', 'notebook_path'];

  for (const key of pathKeys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) {
      return { path: value, operation };
    }
  }

  return null;
}
