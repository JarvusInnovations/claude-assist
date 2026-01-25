import type {
  TranscriptMessage,
  ParsedSession,
  ContentBlock,
  ToolUseBlock,
} from './types.js';

/**
 * Parse a JSONL transcript and extract structured data
 * Following the Kuato pattern: extract user messages, tools, files, tokens
 */
export function parseTranscript(
  sessionId: string,
  jsonlContent: string
): ParsedSession {
  const lines = jsonlContent.trim().split('\n');

  const userMessages: string[] = [];
  const toolsUsed = new Set<string>();
  const filesTouched = new Set<string>();

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

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const msg: TranscriptMessage = JSON.parse(line);

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
        // Track token usage
        if (msg.message.usage) {
          inputTokens += msg.message.usage.input_tokens ?? 0;
          outputTokens += msg.message.usage.output_tokens ?? 0;
          cacheReadTokens += msg.message.usage.cache_read_input_tokens ?? 0;
        }

        // Extract tool uses
        const tools = extractToolUses(msg.message.content);
        for (const tool of tools) {
          toolsUsed.add(tool.name);

          // Extract file paths from file-related tools
          const filePath = extractFilePath(tool);
          if (filePath) {
            filesTouched.add(filePath);
          }
        }
      }
    } catch {
      // Track parse failures for debugging
      parseErrors++;
      continue;
    }
  }

  return {
    sessionId,
    userMessages,
    toolsUsed: [...toolsUsed],
    filesTouched: [...filesTouched],
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

/**
 * Extract file path from tool input
 * Handles Read, Edit, Write, Glob, Grep tools
 */
function extractFilePath(tool: ToolUseBlock): string | null {
  const input = tool.input;
  if (!input || typeof input !== 'object') return null;

  // Common file path keys used by Claude tools
  const pathKeys = ['file_path', 'path', 'file', 'filename', 'filePath', 'notebook_path'];

  for (const key of pathKeys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return null;
}
