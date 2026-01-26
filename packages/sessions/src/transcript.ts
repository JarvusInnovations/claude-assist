import type { TranscriptMessage, ContentBlock, ToolUseBlock } from './types.js';

/**
 * Extract text content from message content
 */
function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter(
      (block): block is { type: 'text'; text: string } => block.type === 'text'
    )
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
 * Extract primary target from tool input (file path, command, etc.)
 */
function extractToolTarget(tool: ToolUseBlock): string | null {
  const input = tool.input;
  if (!input || typeof input !== 'object') return null;

  const inputObj = input as Record<string, unknown>;

  // File path keys
  const pathKeys = [
    'file_path',
    'path',
    'file',
    'filename',
    'filePath',
    'notebook_path',
  ];
  for (const key of pathKeys) {
    const value = inputObj[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  // Command for Bash
  if (tool.name === 'Bash' && typeof inputObj.command === 'string') {
    const cmd = inputObj.command;
    return cmd.length > 50 ? cmd.slice(0, 50) + '...' : cmd;
  }

  // Pattern for search tools
  if (typeof inputObj.pattern === 'string') {
    return inputObj.pattern;
  }

  // Query for search tools
  if (typeof inputObj.query === 'string') {
    return inputObj.query;
  }

  return null;
}

/**
 * Serialize raw JSONL transcript to token-efficient format
 * Format: [U] user message, [A] assistant snippet, [T] tool + target
 *
 * This is the same format used for AI outline generation.
 */
export function serializeTranscript(rawTranscript: string): string {
  const lines = rawTranscript.trim().split('\n');
  const output: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const msg: TranscriptMessage = JSON.parse(line);

      // Skip queue operations
      if (msg.type === 'queue-operation') continue;

      if (msg.type === 'user' && msg.message) {
        const text = extractTextContent(msg.message.content);
        if (text) {
          output.push(`[U] ${text}`);
        }
      }

      if (msg.type === 'assistant' && msg.message) {
        // Extract brief text snippet (first ~280 chars)
        const text = extractTextContent(msg.message.content);
        if (text) {
          const snippet =
            text.length > 280 ? text.slice(0, 280) + '...' : text;
          output.push(`[A] ${snippet}`);
        }

        // Extract tool calls
        const tools = extractToolUses(msg.message.content);
        for (const tool of tools) {
          const target = extractToolTarget(tool);
          output.push(`[T] ${tool.name}${target ? ' ' + target : ''}`);
        }
      }
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  const result = output.join('\n');

  // Truncate to stay within Haiku's 200K token context
  // Reserve ~2K tokens for response + prompt overhead, leaving ~198K for transcript
  // At ~3.5 chars/token (conservative for code): 198K × 3.5 ≈ 693K chars
  const MAX_TRANSCRIPT_CHARS = 680000;
  if (result.length > MAX_TRANSCRIPT_CHARS) {
    return (
      result.slice(0, MAX_TRANSCRIPT_CHARS) + '\n[...transcript truncated]'
    );
  }

  return result;
}
