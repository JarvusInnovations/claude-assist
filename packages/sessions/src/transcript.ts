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
export function extractToolTarget(tool: ToolUseBlock): string | null {
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

  // Description for Agent tool
  if (tool.name === 'Agent' && typeof inputObj.description === 'string') {
    return inputObj.description;
  }

  // Skill name for Skill tool
  if (tool.name === 'Skill' && typeof inputObj.skill === 'string') {
    return inputObj.skill;
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

/**
 * Emit a user-side text payload using the right marker:
 * [N] task-notification, [S] skill injection, [U] user message (or /skill).
 * Used for both type:user messages and queued_command attachments.
 */
function emitUserText(text: string, output: string[]): void {
  if (text.includes('<task-notification>')) {
    const summary = text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
    const status = text.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim();
    if (summary) {
      output.push(`[N] ${summary}${status ? ` (${status})` : ''}`);
    }
    return;
  }

  if (text.startsWith('Base directory for this skill:')) {
    const match = text.match(/^Base directory for this skill: ([^\n]+)/);
    if (match?.[1]) {
      const skillPath = match[1];
      const skillName = skillPath.split('/').pop() || 'unknown';
      output.push(`[S] ${skillName} (${skillPath})`);
    } else {
      output.push(`[S] unknown`);
    }
    return;
  }

  const argsMatch = text.match(/<command-args>([\s\S]+?)<\/command-args>/);
  const commandArgs = argsMatch?.[1]?.trim();
  if (commandArgs) {
    const nameMatch = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
    const skillName = nameMatch?.[1]?.trim();
    output.push(`[U] /${skillName ?? 'unknown'} ${commandArgs}`);
    return;
  }

  if (!isXmlOnlyContent(text)) {
    output.push(`[U] ${text}`);
  }
}

export interface SerializeTranscriptOptions {
  after?: Date;
  before?: Date;
  includeTools?: boolean;
}

/**
 * Serialize raw JSONL transcript to token-efficient format
 * Format: [U] user message, [A] assistant message, [T] tool + target
 *         [?] question with options, [>] user response to question
 *         [S] skill loaded (skill name + path)
 *         [N] subagent notification (summary + status)
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
          emitUserText(text, output);
        }
      }

      // Queued user prompts are persisted as attachments, not type:user messages.
      // attachment.prompt may contain a real user message OR a system-generated
      // <task-notification> — both shapes are already handled by emitUserText().
      if (msg.type === 'attachment' && msg.attachment?.type === 'queued_command') {
        const prompt = msg.attachment.prompt;
        if (typeof prompt === 'string' && prompt.length > 0) {
          emitUserText(prompt, output);
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
          } else if (options?.includeTools) {
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

// ───────────────────────────────────────────────────────────────────────────
// Rich transcript search + anchor-based exploration (#48)
// ───────────────────────────────────────────────────────────────────────────

/** Per-call cap on a window's serialized size; oversized ranges page instead. */
const MAX_WINDOW_CHARS = 12000;

/**
 * Parse JSONL into the canonical ordered message stream — the same ordering the
 * parser uses to assign msg_index, so a tool_calls row's index lines up here.
 * Skips Claude Code's `custom-title` lines and any malformed JSON.
 */
function parseMessages(rawTranscript: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const line of rawTranscript.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as { type?: string };
      if (raw.type === 'custom-title') continue;
      out.push(raw as TranscriptMessage);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** Flatten a tool_result block's content to text. */
function toolResultText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content.trim();
  return (content as unknown[])
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: string })?.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Serialize a single message to its display line(s) (no cross-message state). */
function serializeMessage(msg: TranscriptMessage): string[] {
  const out: string[] = [];
  if (msg.type === 'user' && msg.message) {
    const text = extractTextContent(msg.message.content);
    if (text) emitUserText(text, out);
    // Tool results so exploration windows aren't blank around tool calls.
    for (const result of extractToolResults(msg.message.content)) {
      const rt = toolResultText(result.content);
      if (rt) out.push(`[R] ${rt.length > 240 ? rt.slice(0, 240) + '…' : rt}`);
    }
  }
  if (
    msg.type === 'attachment' &&
    msg.attachment?.type === 'queued_command' &&
    typeof msg.attachment.prompt === 'string' &&
    msg.attachment.prompt.length > 0
  ) {
    emitUserText(msg.attachment.prompt, out);
  }
  if (msg.type === 'assistant' && msg.message) {
    const text = extractTextContent(msg.message.content);
    if (text) out.push(`[A] ${text}`);
    for (const tool of extractToolUses(msg.message.content)) {
      const isQuestion =
        tool.name === 'AskUserQuestion' || tool.name === 'mcp__conductor__AskUserQuestion';
      if (isQuestion) {
        const formatted = formatQuestionTool(tool);
        if (formatted) out.push(`[?] ${formatted}`);
      } else {
        const target = extractToolTarget(tool);
        out.push(`[T] ${tool.name}${target ? ' ' + target : ''}`);
      }
    }
  }
  return out;
}

export interface MessageWindow {
  /** Serialized lines, anchor message prefixed `> `, the rest `  `. */
  lines: string[];
  anchor: string;
  /** uuid at the window's first/last message — the next anchors to page from. */
  head: string | null;
  tail: string | null;
  /** Messages remaining before/after the window (0 = at session boundary). */
  moreBefore: number;
  moreAfter: number;
  truncated: boolean;
}

/** Build a ±range window of serialized messages centered on `centerIdx`. */
function buildWindow(
  msgs: TranscriptMessage[],
  centerIdx: number,
  before: number,
  after: number,
  markSuffix?: string
): MessageWindow {
  const startIdx = Math.max(0, centerIdx - Math.max(0, before));
  const endIdx = Math.min(msgs.length - 1, centerIdx + Math.max(0, after));

  const lines: string[] = [];
  let truncated = false;
  let chars = 0;
  for (let i = startIdx; i <= endIdx; i++) {
    const isAnchor = i === centerIdx;
    const prefix = isAnchor ? '> ' : '  ';
    const msgLines = serializeMessage(msgs[i]!);
    for (let j = 0; j < msgLines.length; j++) {
      let line = `${prefix}${msgLines[j]}`;
      if (isAnchor && j === msgLines.length - 1 && markSuffix) line += `   ${markSuffix}`;
      if (chars + line.length > MAX_WINDOW_CHARS) {
        truncated = true;
        break;
      }
      lines.push(line);
      chars += line.length + 1;
    }
    if (truncated) break;
  }

  return {
    lines,
    anchor: msgs[centerIdx]?.uuid ?? '',
    // Edge anchors must be usable: skip past any uuid-less messages (e.g. queue
    // operations) at the window boundary to the nearest real anchor.
    head: nearestUuid(msgs, startIdx, 1),
    tail: nearestUuid(msgs, endIdx, -1),
    moreBefore: startIdx,
    moreAfter: msgs.length - 1 - endIdx,
    truncated,
  };
}

/** Nearest message with a uuid scanning from `idx` in direction `dir` (+1/-1). */
function nearestUuid(msgs: TranscriptMessage[], idx: number, dir: 1 | -1): string | null {
  for (let i = idx; i >= 0 && i < msgs.length; i += dir) {
    if (msgs[i]?.uuid) return msgs[i]!.uuid;
  }
  return null;
}

export type MatchDimension = 'tool' | 'target' | 'text' | 'any';

export interface FindOptions {
  /** Substring (case-insensitive) the tool name must contain. */
  tool?: string;
  /** Substring (case-insensitive) to find in the chosen dimension. */
  match?: string;
  /** Which dimension `match` applies to (default 'any'). */
  in?: MatchDimension;
  /** Messages of context on each side of a hit (default 1). */
  context?: number;
  /** Resume scanning after this message uuid. */
  afterUuid?: string;
  /** Stop scanning at this message uuid (exclusive). */
  beforeUuid?: string;
  /** Max matches to return (default 10). */
  limit?: number;
  /** Include subagent (sidechain) messages (default false). */
  includeSidechain?: boolean;
}

export interface TranscriptMatch {
  anchor: string;
  index: number;
  ts: string | null;
  /** First tool name on the matched message, if any. */
  tool: string | null;
  /** Its derived target, if any. */
  target: string | null;
  window: MessageWindow;
}

function indexOfUuid(msgs: TranscriptMessage[], uuid: string | undefined): number {
  if (!uuid) return -1;
  return msgs.findIndex((m) => m.uuid === uuid);
}

/** Does a message satisfy the tool/match/in filters? Returns the hit's tool/target. */
function messageMatches(
  msg: TranscriptMessage,
  opts: FindOptions
): { tool: string | null; target: string | null } | null {
  const tool = opts.tool?.toLowerCase();
  const match = opts.match?.toLowerCase();
  const dim = opts.in ?? 'any';

  const tools = msg.type === 'assistant' && msg.message ? extractToolUses(msg.message.content) : [];
  const text =
    msg.message ? extractTextContent(msg.message.content) : msg.attachment?.prompt ?? '';
  const textLower = (text ?? '').toLowerCase();

  // Tool-name filter: at least one tool must contain `tool`.
  const toolHits = tool ? tools.filter((t) => t.name.toLowerCase().includes(tool)) : tools;
  if (tool && toolHits.length === 0) return null;

  if (!match) {
    // Tool-only query: hit if a tool matched (tool filter required when no match).
    if (!tool) return null;
    const first = toolHits[0]!;
    return { tool: first.name, target: extractToolTarget(first) };
  }

  // Match within the chosen dimension(s).
  const scanTools = tool ? toolHits : tools;
  const targetHit = scanTools.find((t) => (extractToolTarget(t) ?? '').toLowerCase().includes(match));
  const toolNameHit = scanTools.find((t) => t.name.toLowerCase().includes(match));
  const textHit = textLower.includes(match);

  let matched = false;
  if (dim === 'target') matched = !!targetHit;
  else if (dim === 'text') matched = textHit;
  else if (dim === 'tool') matched = !!toolNameHit;
  else matched = !!targetHit || !!toolNameHit || textHit; // 'any'

  if (!matched) return null;
  const hit = targetHit ?? toolNameHit ?? scanTools[0] ?? null;
  return { tool: hit?.name ?? null, target: hit ? extractToolTarget(hit) : null };
}

/**
 * Find messages matching tool/text criteria within a transcript, each returned
 * with a ±context window and paging anchors. `uuid` is the durable anchor.
 */
export function findInTranscript(rawTranscript: string, opts: FindOptions): TranscriptMatch[] {
  const msgs = parseMessages(rawTranscript);
  const context = opts.context ?? 1;
  const limit = opts.limit ?? 10;

  let start = 0;
  let end = msgs.length;
  const afterIdx = indexOfUuid(msgs, opts.afterUuid);
  if (afterIdx >= 0) start = afterIdx + 1;
  const beforeIdx = indexOfUuid(msgs, opts.beforeUuid);
  if (beforeIdx >= 0) end = beforeIdx;

  const matches: TranscriptMatch[] = [];
  for (let i = start; i < end && matches.length < limit; i++) {
    const msg = msgs[i]!;
    if (!msg.uuid) continue; // can't anchor a message without a uuid
    if (!opts.includeSidechain && msg.isSidechain) continue;
    const hit = messageMatches(msg, opts);
    if (!hit) continue;
    matches.push({
      anchor: msg.uuid,
      index: i,
      ts: msg.timestamp ?? null,
      tool: hit.tool,
      target: hit.target,
      window: buildWindow(msgs, i, context, context, '<- match'),
    });
  }
  return matches;
}

/**
 * Read a variable range of messages around an anchor uuid — the exploration
 * follow-up. Returns the window plus head/tail anchors and how much transcript
 * remains in each direction, so a caller can keep walking outward.
 */
export function readAround(
  rawTranscript: string,
  anchorUuid: string,
  before: number,
  after: number
): MessageWindow | null {
  const msgs = parseMessages(rawTranscript);
  const idx = indexOfUuid(msgs, anchorUuid);
  if (idx < 0) return null;
  return buildWindow(msgs, idx, before, after);
}
