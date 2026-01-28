import type {
  TranscriptMessage,
  ParsedSession,
  ContentBlock,
  ToolUseBlock,
  ModelTokens,
  FilesTouched,
} from './types.js';

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

/**
 * Parse a JSONL transcript and extract structured data
 * Following the Kuato pattern: extract user messages, tools, files, tokens
 *
 * Note: Claude's transcript logs multiple messages per API response (streaming updates).
 * Each message in a response chain has the same usage data. To avoid over-counting,
 * we only count tokens from the first message in each chain (identified by parentUuid
 * not being another message with usage data).
 */
export function parseTranscript(
  sessionId: string,
  jsonlContent: string
): ParsedSession {
  const lines = jsonlContent.trim().split('\n');

  const userMessages: string[] = [];
  const toolsUsed = new Set<string>();
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  const modelsUsed = new Set<string>();
  const modelTokens: Record<string, ModelTokens> = {};

  let inputTokens = 0;
  let outputTokens = 0;
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

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const msg: TranscriptMessage = JSON.parse(line);
      parsedMessages.push(msg);

      // Track UUIDs of messages with usage data
      if (msg.type === 'assistant' && msg.message?.usage && msg.uuid) {
        messagesWithUsage.add(msg.uuid);
      }
    } catch {
      parseErrors++;
    }
  }

  // Second pass: process messages, deduplicating token counts
  for (const msg of parsedMessages) {
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

      // Track token usage, but only from first message in each response chain
      // A message is "first in chain" if its parentUuid is NOT another message with usage
      if (msg.message.usage) {
        const isFirstInChain = !msg.parentUuid || !messagesWithUsage.has(msg.parentUuid);

        if (isFirstInChain) {
          const usage = msg.message.usage;
          inputTokens += usage.input_tokens ?? 0;
          outputTokens += usage.output_tokens ?? 0;
          cacheReadTokens += usage.cache_read_input_tokens ?? 0;

          // Per-model tracking
          if (model) {
            modelTokens[model]!.input += usage.input_tokens ?? 0;
            modelTokens[model]!.output += usage.output_tokens ?? 0;
            modelTokens[model]!.cacheRead += usage.cache_read_input_tokens ?? 0;
          }
        }
      }

      // Extract tool uses
      const tools = extractToolUses(msg.message.content);
      for (const tool of tools) {
        toolsUsed.add(tool.name);

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
