import type { TranscriptMessage, ContentBlock, ToolUseBlock } from './types.js';

/**
 * Tool result block type (from user messages containing tool responses)
 */
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
}

/**
 * Check if text contains ONLY XML tags with no meaningful content outside them.
 * Handles nested tags by iteratively removing innermost balanced tag pairs.
 */
function isXmlOnlyContent(text: string): boolean {
  let remaining = text.trim();

  // Quick check: must start with a tag to be XML-only
  if (!remaining.startsWith('<')) return false;

  // Iteratively remove balanced tag pairs from innermost outward
  let changed = true;
  while (changed) {
    changed = false;

    // Match tag pairs using non-greedy match, but only remove if
    // the content doesn't contain a nested opening tag of the same name
    remaining = remaining.replace(
      /<([a-zA-Z][\w-]*)[^>]*>([\s\S]*?)<\/\1>/g,
      (match, tagName, content) => {
        // Check if content contains an opening tag of the same name (nested)
        const nestedOpenTag = new RegExp(`<${tagName}[\\s>]`);
        if (!nestedOpenTag.test(content)) {
          changed = true;
          return ''; // Remove this innermost tag pair
        }
        return match; // Keep it, will be processed in later iteration
      }
    );
  }

  // Remove self-closing tags
  remaining = remaining.replace(/<[a-zA-Z][\w-]*[^>]*\/>/g, '');

  // Check if anything meaningful remains
  return remaining.trim().length === 0;
}

/**
 * Extract tool_result blocks from user message content.
 * Note: tool_result blocks exist in the actual transcript data but aren't
 * part of the ContentBlock type definition (which covers assistant messages).
 */
function extractToolResults(
  content: string | ContentBlock[]
): ToolResultBlock[] {
  if (typeof content === 'string') return [];
  // Cast to unknown[] first since tool_result isn't in ContentBlock union
  return (content as unknown[]).filter(
    (block): block is ToolResultBlock =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: string }).type === 'tool_result'
  );
}

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
    return inputObj.command;
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
 * Format a question tool call with full context
 */
function formatQuestionTool(tool: ToolUseBlock): string | null {
  const input = tool.input as {
    questions?: Array<{
      question: string;
      header?: string;
      options: string[] | Array<{ label: string; description?: string }>;
    }>;
  };

  if (!input.questions?.length) return null;

  const formatted = input.questions
    .map((q, i) => {
      // Format options - handle both string[] and {label,description}[] formats
      const opts = (q.options ?? [])
        .map((o, j) => {
          if (typeof o === 'string') {
            return `  ${j + 1}. ${o}`;
          } else {
            return `  ${j + 1}. ${o.label}${o.description ? ` - ${o.description}` : ''}`;
          }
        })
        .join('\n');

      const header = q.header ? `[${q.header}] ` : '';
      return `${i + 1}. ${header}${q.question}\n${opts}`;
    })
    .join('\n');

  return formatted;
}

export interface SerializeTranscriptOptions {
  after?: Date;
  before?: Date;
}

/**
 * Serialize raw JSONL transcript to token-efficient format
 * Format: [U] user message, [A] assistant message, [T] tool + target
 *         [?] question with options, [>] user response to question
 *         [S] skill loaded (skill name + path)
 *
 * This is the same format used for AI outline generation.
 */
export function serializeTranscript(
  rawTranscript: string,
  options?: SerializeTranscriptOptions
): string {
  const lines = rawTranscript.trim().split('\n');
  const output: string[] = [];

  // Track pending question tool_use_ids to match with responses
  const pendingQuestions = new Set<string>();

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const msg: TranscriptMessage = JSON.parse(line);

      // Time-range filtering: skip messages without timestamps when filtering is active
      if (options?.after || options?.before) {
        if (!msg.timestamp) continue;
        const msgTime = new Date(msg.timestamp);
        if (options.after && msgTime < options.after) continue;
        if (options.before && msgTime > options.before) continue;
      }

      // Skip queue operations
      if (msg.type === 'queue-operation') continue;

      if (msg.type === 'user' && msg.message) {
        // First, check for tool_results (responses to questions)
        const results = extractToolResults(msg.message.content);
        for (const result of results) {
          if (pendingQuestions.has(result.tool_use_id)) {
            const responseText =
              typeof result.content === 'string'
                ? result.content
                : (result.content as ContentBlock[])
                    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                    .map((b) => b.text)
                    .join('\n');
            if (responseText) {
              output.push(`[>] ${responseText}`);
            }
            pendingQuestions.delete(result.tool_use_id);
          }
        }

        // Then handle text content (skip if only XML tags)
        const text = extractTextContent(msg.message.content);
        if (text) {
          // Check if this is a skill injection
          if (text.startsWith('Base directory for this skill:')) {
            const match = text.match(/^Base directory for this skill: ([^\n]+)/);
            if (match?.[1]) {
              const skillPath = match[1];
              const skillName = skillPath.split('/').pop() || 'unknown';
              output.push(`[S] ${skillName} (${skillPath})`);
            } else {
              output.push(`[S] unknown`);
            }
          } else {
            // Extract command-args from skill invocations before XML check
            const argsMatch = text.match(/<command-args>([\s\S]+?)<\/command-args>/);
            const commandArgs = argsMatch?.[1]?.trim();

            if (commandArgs) {
              // Skill invocation with user-provided arguments
              const nameMatch = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
              const skillName = nameMatch?.[1]?.trim();
              output.push(`[U] /${skillName ?? 'unknown'} ${commandArgs}`);
            } else if (!isXmlOnlyContent(text)) {
              output.push(`[U] ${text}`);
            }
          }
        }
      }

      if (msg.type === 'assistant' && msg.message) {
        const text = extractTextContent(msg.message.content);
        if (text) {
          output.push(`[A] ${text}`);
        }

        // Extract tool calls
        const tools = extractToolUses(msg.message.content);
        for (const tool of tools) {
          // Check if this is a question tool (Claude Code native or Conductor MCP)
          const isQuestionTool =
            tool.name === 'AskUserQuestion' ||
            tool.name === 'mcp__conductor__AskUserQuestion';

          if (isQuestionTool) {
            const formatted = formatQuestionTool(tool);
            if (formatted) {
              output.push(`[?] ${formatted}`);
              pendingQuestions.add(tool.id);
            }
          } else {
            const target = extractToolTarget(tool);
            output.push(`[T] ${tool.name}${target ? ' ' + target : ''}`);
          }
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
