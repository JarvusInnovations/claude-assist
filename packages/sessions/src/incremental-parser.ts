/**
 * Incremental transcript aggregation (specs/behaviors/session-transcript-storage.md:
 * "Incremental derivation").
 *
 * `parser.ts`'s `parseTranscript` computes session aggregates (tokens, tool
 * calls, activity ranges, ...) by scanning a whole transcript in memory. This
 * module computes the *same* aggregates from a transcript fed in pieces —
 * `resume(checkpoint) -> feed(lines) -> checkpoint + delta` — so a sync cycle
 * can process only the bytes a session grew by, carrying just enough state
 * forward to keep resuming.
 *
 * ## What the checkpoint holds (and why it stays small)
 *
 * A checkpoint is `{ msgIndex, openChains, lastActivityEnd }` — nothing else.
 * Everything else `parseTranscript` accumulates (user messages, tool names,
 * files touched, per-model tokens, ...) is *already* durable on the session
 * row from the previous cycle; a delta only needs to describe how to update
 * that row, not repeat it. So the checkpoint carries only the parser's
 * *transient* state — the part a full-corpus scan gets for free by holding
 * everything in memory, which an incremental scan has to persist explicitly:
 *
 * - `msgIndex` — the next message's ordinal position (== tool_calls.msg_index
 *   and the `transcript_messages.seq` counter). A single running integer.
 * - `lastActivityEnd` — the end timestamp of the most recently computed
 *   activity range, so a new user-message timestamp can be compared against
 *   it (extend vs. start a new range) without re-scanning history.
 * - `openChains` — the hard part. `parseTranscript` finds each streamed
 *   response's *chain root* by walking `parentUuid` pointers, and reports
 *   `output_tokens` cumulative per chain (`ToolCall` reports and token
 *   counting), only summing every chain's final max at the very end of the
 *   full scan. An incremental parse can't wait for "the end" — the file may
 *   never end (an always-on bot). So open chains are tracked as a small
 *   *tip-indexed* structure: at most `MAX_OPEN_CHAINS` entries, keyed by
 *   chain root, each holding only the chain's current tip uuid, model and
 *   running max output. A message extends a chain by naming the chain's tip
 *   uuid as its own `parentUuid` — Claude Code's transcript format never lets
 *   a later message name an *earlier*, already-superseded uuid as its parent,
 *   so "current tip" is all a continuation ever needs to find. When the
 *   number of distinct open chains would exceed the cap, the oldest
 *   (least-recently-extended) chain is evicted and *finalized* — its max
 *   output is folded into the delta's `outputTokens`/`modelTokens`, exactly
 *   as a full scan's final summation would. `finalize()` forces this for
 *   every remaining chain, for use at true end-of-transcript (a full
 *   single-pass parse, or a sync cycle that knows via `.ended.json` that no
 *   more lines are coming).
 *
 * This keeps checkpoint size bounded by concurrency (how many chains can be
 * simultaneously "open" — practically the main chain plus a handful of
 * concurrent subagents), not by transcript length.
 */

import type {
  TranscriptMessage,
  ContentBlock,
  ToolUseBlock,
  ModelTokens,
  ActivityRange,
  ToolCall,
} from './types.js';
import { extractToolTarget } from './transcript.js';
import { sanitizeText, sanitizeStringArray } from './sanitize.js';

/** Gap threshold for activity range segmentation (30 minutes) — matches parser.ts. */
const ACTIVITY_GAP_MS = 30 * 60 * 1000;

/** Cap on simultaneously open (not yet finalized) chains a checkpoint retains. */
export const MAX_OPEN_CHAINS = 128;

export interface OpenChainState {
  chainRoot: string;
  tipUuid: string;
  model: string | undefined;
  maxOutput: number;
}

export interface ParseCheckpoint {
  v: 1;
  /** Next message's ordinal position in the canonical parsed stream. */
  msgIndex: number;
  /** Not-yet-finalized chains, oldest (least-recently-extended) first. */
  openChains: OpenChainState[];
  /** ISO timestamp of the most recently computed activity range's end. */
  lastActivityEnd: string | null;
}

export const EMPTY_CHECKPOINT: ParseCheckpoint = {
  v: 1,
  msgIndex: 0,
  openChains: [],
  lastActivityEnd: null,
};

/**
 * The incremental analogue of `ParsedSession`: everything a `feed()` call
 * discovered in *its* lines, to be merged onto the session's existing
 * aggregate (see `mergeParseDelta`). Arrays are the new/discovered items for
 * this call, not the running total.
 */
export interface ParseDelta {
  userMessages: string[];
  toolsUsed: string[];
  filesRead: string[];
  filesWritten: string[];
  toolCalls: ToolCall[];
  /** (seq, uuid) for every message this feed processed that carried a uuid. */
  messageIndexRows: Array<{ seq: number; uuid: string }>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Non-null when a main-chain reading occurred in this feed (overwrite). */
  contextFinalTokens: number | null;
  /** Local peak within this feed, or null if none (merge = max with existing). */
  contextPeakCandidate: number | null;
  contextModel: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  messageCount: number;
  /** First non-null value seen this feed (merge keeps the session's existing
   * value if already set — "first message overall wins"). */
  gitBranch: string | null;
  claudeVersion: string | null;
  cwd: string | null;
  parseErrors: number;
  modelsUsed: string[];
  modelTokens: Record<string, ModelTokens>;
  /** New ranges to append as-is. */
  newActivityRanges: ActivityRange[];
  /** Non-null means the session's current last activity range's `end` should
   * be updated to this value (the delta's first timestamp continued it). */
  extendLastRangeEnd: string | null;
  /** True if a custom-title line appeared in this feed — see `sessionName`. */
  sessionNameChanged: boolean;
  /** The resulting session name if `sessionNameChanged` (last one wins;
   * possibly null, which means a rename-to-empty cleared the name). */
  sessionName: string | null;
}

function emptyDelta(): ParseDelta {
  return {
    userMessages: [],
    toolsUsed: [],
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    messageIndexRows: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    contextFinalTokens: null,
    contextPeakCandidate: null,
    contextModel: null,
    startedAt: null,
    endedAt: null,
    messageCount: 0,
    gitBranch: null,
    claudeVersion: null,
    cwd: null,
    parseErrors: 0,
    modelsUsed: [],
    modelTokens: {},
    newActivityRanges: [],
    extendLastRangeEnd: null,
    sessionNameChanged: false,
    sessionName: null,
  };
}

// ── message-content helpers (mirrors parser.ts; kept local so this module has
// no dependency on parser.ts, matching the plan's "independently implemented,
// proven equal by the property test" design) ────────────────────────────────

function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function extractToolUses(content: string | ContentBlock[]): ToolUseBlock[] {
  if (typeof content === 'string') return [];
  return content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
}

type FileOperation = 'read' | 'write';

const TOOL_OPERATIONS: Record<string, FileOperation | null> = {
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  Edit: 'write',
  Write: 'write',
  NotebookEdit: 'write',
  Bash: null,
  Task: null,
};

function extractFileTouch(tool: ToolUseBlock): { path: string; operation: FileOperation } | null {
  const operation = TOOL_OPERATIONS[tool.name];
  if (!operation) return null;
  const input = tool.input;
  if (!input || typeof input !== 'object') return null;
  const pathKeys = ['file_path', 'path', 'file', 'filename', 'filePath', 'notebook_path'];
  for (const key of pathKeys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) return { path: value, operation };
  }
  return null;
}

/** Merge new user-activity timestamps (already chronological) against a
 * checkpoint's `lastActivityEnd`, producing an extend-signal plus any new
 * ranges — equivalent to recomputing `computeActivityRanges` over the whole
 * session's timestamps, without re-scanning history. */
function mergeActivityRanges(
  lastEnd: Date | null,
  timestamps: Date[]
): { extendLastRangeEnd: string | null; newActivityRanges: ActivityRange[] } {
  if (timestamps.length === 0) return { extendLastRangeEnd: null, newActivityRanges: [] };

  let idx = 0;
  let extendLastRangeEnd: string | null = null;

  if (lastEnd && timestamps[0]!.getTime() - lastEnd.getTime() <= ACTIVITY_GAP_MS) {
    let rangeEnd = timestamps[0]!;
    idx = 1;
    while (idx < timestamps.length && timestamps[idx]!.getTime() - rangeEnd.getTime() <= ACTIVITY_GAP_MS) {
      rangeEnd = timestamps[idx]!;
      idx++;
    }
    extendLastRangeEnd = rangeEnd.toISOString();
  }

  const newActivityRanges: ActivityRange[] = [];
  if (idx < timestamps.length) {
    let rangeStart = timestamps[idx]!;
    let rangeEnd = timestamps[idx]!;
    idx++;
    for (; idx < timestamps.length; idx++) {
      const ts = timestamps[idx]!;
      if (ts.getTime() - rangeEnd.getTime() > ACTIVITY_GAP_MS) {
        newActivityRanges.push({ start: rangeStart.toISOString(), end: rangeEnd.toISOString() });
        rangeStart = ts;
      }
      rangeEnd = ts;
    }
    newActivityRanges.push({ start: rangeStart.toISOString(), end: rangeEnd.toISOString() });
  }

  return { extendLastRangeEnd, newActivityRanges };
}

/**
 * Feed a batch of raw JSONL lines (must be complete lines, in file order,
 * immediately following whatever the checkpoint already covers) and get back
 * the delta they produced plus a checkpoint to resume from. Feeding a whole
 * transcript's lines in one call against `EMPTY_CHECKPOINT` is equivalent to
 * a full parse (see `parser.test.ts`'s property test) — `feed` and `finalize`
 * are the only primitives; a full parse is just `feed(all lines)` followed by
 * `finalize()`.
 */
export interface FeedResult {
  checkpoint: ParseCheckpoint;
  delta: ParseDelta;
  /**
   * One entry per input line, in order: the `seq` it was assigned, or `null`
   * for a line that consumed no seq (blank, a parse error, or a
   * `custom-title` line). This is what lets a caller split the same lines
   * into byte-sized chunk rows while still knowing each chunk's exact
   * message-seq range, without chunking and parsing needing to agree on
   * anything beyond "same lines, same order" (see `chunkLines` in
   * chunked-ingest.ts).
   */
  lineSeqs: Array<number | null>;
}

export function feed(checkpoint: ParseCheckpoint, lines: readonly string[]): FeedResult {
  let msgIndex = checkpoint.msgIndex;
  const openChains = new Map<string, OpenChainState>(
    checkpoint.openChains.map((c) => [c.chainRoot, { ...c }])
  );
  const tipIndex = new Map<string, string>(checkpoint.openChains.map((c) => [c.tipUuid, c.chainRoot]));

  const lineSeqs: Array<number | null> = [];
  const delta = emptyDelta();
  const modelTokens: Record<string, ModelTokens> = {};
  const toolsUsed = new Set<string>();
  const modelsUsed = new Set<string>();
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  const newActivityTimestamps: Date[] = [];

  const ensureModel = (model: string): ModelTokens => {
    if (!modelTokens[model]) modelTokens[model] = { input: 0, output: 0, cacheRead: 0 };
    return modelTokens[model]!;
  };

  const flushChain = (chainRoot: string): void => {
    const c = openChains.get(chainRoot);
    if (!c) return;
    openChains.delete(chainRoot);
    tipIndex.delete(c.tipUuid);
    delta.outputTokens += c.maxOutput;
    if (c.model) ensureModel(c.model).output += c.maxOutput;
  };

  const touchChain = (chainRoot: string, patch: OpenChainState): void => {
    openChains.delete(chainRoot); // re-insert for Map's insertion-order LRU
    openChains.set(chainRoot, patch);
    tipIndex.set(patch.tipUuid, chainRoot);
    while (openChains.size > MAX_OPEN_CHAINS) {
      const oldest = openChains.keys().next().value as string;
      flushChain(oldest);
    }
  };

  for (const line of lines) {
    if (!line.trim()) {
      lineSeqs.push(null);
      continue;
    }

    let raw: { type?: string; customTitle?: string };
    try {
      raw = JSON.parse(line);
    } catch {
      delta.parseErrors++;
      lineSeqs.push(null);
      continue;
    }

    if (raw.type === 'custom-title' && typeof raw.customTitle === 'string') {
      const trimmed = raw.customTitle.trim();
      delta.sessionNameChanged = true;
      delta.sessionName = trimmed.length > 0 ? sanitizeText(trimmed) : null;
      lineSeqs.push(null);
      continue;
    }

    const msg = raw as TranscriptMessage;
    const seq = msgIndex++;
    lineSeqs.push(seq);

    if (msg.timestamp) {
      const ts = new Date(msg.timestamp);
      if (!delta.startedAt || ts < delta.startedAt) delta.startedAt = ts;
      if (!delta.endedAt || ts > delta.endedAt) delta.endedAt = ts;
    }
    if (msg.gitBranch && !delta.gitBranch) delta.gitBranch = msg.gitBranch;
    if (msg.version && !delta.claudeVersion) delta.claudeVersion = msg.version;
    if (msg.cwd && !delta.cwd) delta.cwd = msg.cwd;

    if (msg.uuid) delta.messageIndexRows.push({ seq, uuid: msg.uuid });

    if (msg.type === 'queue-operation') continue;
    delta.messageCount++;

    if (msg.type === 'user' && msg.message) {
      const text = extractTextContent(msg.message.content);
      if (text) {
        delta.userMessages.push(text);
        if (msg.timestamp) newActivityTimestamps.push(new Date(msg.timestamp));
      }
    }

    if (
      msg.type === 'attachment' &&
      msg.attachment?.type === 'queued_command' &&
      typeof msg.attachment.prompt === 'string' &&
      msg.attachment.prompt.length > 0
    ) {
      delta.userMessages.push(msg.attachment.prompt);
      if (msg.timestamp) newActivityTimestamps.push(new Date(msg.timestamp));
    }

    if (msg.type === 'assistant' && msg.message) {
      const model = msg.message.model;
      if (model) {
        modelsUsed.add(model);
        ensureModel(model);
      }

      if (msg.message.usage) {
        const usage = msg.message.usage;
        // A message extends an open chain iff its parentUuid names that
        // chain's current tip. Nothing in Claude Code's transcript format
        // ever names an older, already-superseded uuid as a parent.
        const isFirstInChain = !msg.parentUuid || !tipIndex.has(msg.parentUuid);

        if (isFirstInChain && !msg.isSidechain) {
          const contextTokens =
            (usage.input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0);
          if (contextTokens > 0) {
            delta.contextFinalTokens = contextTokens;
            delta.contextPeakCandidate = Math.max(delta.contextPeakCandidate ?? 0, contextTokens);
            if (model) delta.contextModel = model;
          }
        }

        if (isFirstInChain) {
          delta.inputTokens += usage.input_tokens ?? 0;
          delta.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
          if (model) {
            const mt = ensureModel(model);
            mt.input += usage.input_tokens ?? 0;
            mt.cacheRead += usage.cache_read_input_tokens ?? 0;
          }
        }

        const chainRoot = isFirstInChain
          ? msg.parentUuid || msg.uuid!
          : tipIndex.get(msg.parentUuid!)!;

        const outputValue = usage.output_tokens ?? 0;
        if (msg.uuid) {
          const existingMax = openChains.get(chainRoot)?.maxOutput ?? 0;
          touchChain(chainRoot, {
            chainRoot,
            tipUuid: msg.uuid,
            model,
            maxOutput: Math.max(outputValue, existingMax),
          });
        }
      }

      const tools = extractToolUses(msg.message.content);
      for (const tool of tools) {
        // tool.name is typed as always-present, but a malformed or exotic
        // tool_use block in real transcript data can't be relied on for
        // that at runtime (see PR #243's UNDEFINED_VALUE root cause: a
        // transcript line missing an expected field). Normalize before it
        // ever reaches a bind parameter.
        const toolName = tool.name ?? '';
        toolsUsed.add(toolName);
        if (msg.uuid) {
          const target = extractToolTarget(tool);
          delta.toolCalls.push({
            msgUuid: msg.uuid,
            msgIndex: seq,
            ts: msg.timestamp ? new Date(msg.timestamp) : null,
            toolName: sanitizeText(toolName),
            target: target ? sanitizeText(target) : null,
            isSidechain: msg.isSidechain ?? false,
          });
        }
        const fileTouch = extractFileTouch(tool);
        if (fileTouch) {
          if (fileTouch.operation === 'read') filesRead.add(fileTouch.path);
          else filesWritten.add(fileTouch.path);
        }
      }
    }
  }

  delta.userMessages = sanitizeStringArray(delta.userMessages);
  delta.gitBranch = delta.gitBranch ? sanitizeText(delta.gitBranch) : null;
  delta.toolsUsed = sanitizeStringArray([...toolsUsed]);
  delta.modelsUsed = sanitizeStringArray([...modelsUsed]);
  delta.filesRead = sanitizeStringArray([...filesRead]);
  delta.filesWritten = sanitizeStringArray([...filesWritten]);
  delta.modelTokens = modelTokens;

  const { extendLastRangeEnd, newActivityRanges } = mergeActivityRanges(
    checkpoint.lastActivityEnd ? new Date(checkpoint.lastActivityEnd) : null,
    newActivityTimestamps
  );
  delta.extendLastRangeEnd = extendLastRangeEnd;
  delta.newActivityRanges = newActivityRanges;

  const newLastActivityEnd =
    newActivityRanges.length > 0
      ? newActivityRanges[newActivityRanges.length - 1]!.end
      : (extendLastRangeEnd ?? checkpoint.lastActivityEnd);

  const newCheckpoint: ParseCheckpoint = {
    v: 1,
    msgIndex,
    openChains: [...openChains.values()],
    lastActivityEnd: newLastActivityEnd,
  };

  return { checkpoint: newCheckpoint, delta, lineSeqs };
}

/**
 * Force-finalize every remaining open chain — folding its running max output
 * into a delta exactly as a full scan's end-of-transcript summation would.
 * Call this after the true last `feed()` of a transcript (a full single-pass
 * parse, or a sync cycle that knows the session has ended) so no session's
 * final `output_tokens` is left short by whatever chain was still "open" at
 * the last byte. Safe to call on an already-empty checkpoint (no-op delta).
 */
export function finalize(checkpoint: ParseCheckpoint): { checkpoint: ParseCheckpoint; delta: ParseDelta } {
  const delta = emptyDelta();
  const modelTokens: Record<string, ModelTokens> = {};
  for (const c of checkpoint.openChains) {
    delta.outputTokens += c.maxOutput;
    if (c.model) {
      if (!modelTokens[c.model]) modelTokens[c.model] = { input: 0, output: 0, cacheRead: 0 };
      modelTokens[c.model]!.output += c.maxOutput;
    }
  }
  delta.modelTokens = modelTokens;
  return {
    checkpoint: { v: 1, msgIndex: checkpoint.msgIndex, openChains: [], lastActivityEnd: checkpoint.lastActivityEnd },
    delta,
  };
}

/** A fresh checkpoint to `feed()` from — semantically identical to `EMPTY_CHECKPOINT`. */
export function resume(checkpoint: ParseCheckpoint | null): ParseCheckpoint {
  return checkpoint ?? EMPTY_CHECKPOINT;
}
