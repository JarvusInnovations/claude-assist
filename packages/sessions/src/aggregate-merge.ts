/**
 * Folds an incremental-parser `ParseDelta` onto a session's already-persisted
 * aggregate fields, producing the row values a chunked-ingest cycle should
 * write. Pure and side-effect free so it's unit-testable without a database.
 */

import type { ActivityRange, FilesTouched, ModelTokens } from './types.js';
import type { ParseDelta } from './incremental-parser.js';

export interface SessionAggregate {
  userMessages: string[];
  toolsUsed: string[];
  filesTouched: FilesTouched;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  contextFinalTokens: number | null;
  contextPeakTokens: number | null;
  contextModel: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  messageCount: number;
  gitBranch: string | null;
  claudeVersion: string | null;
  /** First-seen working directory (mirrors parseTranscript's `cwd` field). */
  cwd: string | null;
  parseErrors: number;
  modelsUsed: string[];
  modelTokens: Record<string, ModelTokens>;
  activityRanges: ActivityRange[];
  sessionName: string | null;
}

export const EMPTY_AGGREGATE: SessionAggregate = {
  userMessages: [],
  toolsUsed: [],
  filesTouched: { reads: [], writes: [] },
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  contextFinalTokens: null,
  contextPeakTokens: null,
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
  activityRanges: [],
  sessionName: null,
};

function union(existing: readonly string[], added: readonly string[]): string[] {
  if (added.length === 0) return [...existing];
  const set = new Set(existing);
  for (const v of added) set.add(v);
  return [...set];
}

function mergeModelTokens(
  existing: Record<string, ModelTokens>,
  delta: Record<string, ModelTokens>
): Record<string, ModelTokens> {
  const result: Record<string, ModelTokens> = {};
  for (const [model, tokens] of Object.entries(existing)) result[model] = { ...tokens };
  for (const [model, tokens] of Object.entries(delta)) {
    const cur = result[model] ?? { input: 0, output: 0, cacheRead: 0 };
    result[model] = {
      input: cur.input + tokens.input,
      output: cur.output + tokens.output,
      cacheRead: cur.cacheRead + tokens.cacheRead,
    };
  }
  return result;
}

/** Fold one delta onto an existing aggregate. Pure — returns a new object. */
export function mergeParseDelta(existing: SessionAggregate, delta: ParseDelta): SessionAggregate {
  const activityRanges = [...existing.activityRanges];
  if (delta.extendLastRangeEnd !== null && activityRanges.length > 0) {
    activityRanges[activityRanges.length - 1] = {
      ...activityRanges[activityRanges.length - 1]!,
      end: delta.extendLastRangeEnd,
    };
  }
  activityRanges.push(...delta.newActivityRanges);

  return {
    userMessages: [...existing.userMessages, ...delta.userMessages],
    toolsUsed: union(existing.toolsUsed, delta.toolsUsed),
    filesTouched: {
      reads: union(existing.filesTouched.reads, delta.filesRead),
      writes: union(existing.filesTouched.writes, delta.filesWritten),
    },
    inputTokens: existing.inputTokens + delta.inputTokens,
    outputTokens: existing.outputTokens + delta.outputTokens,
    cacheReadTokens: existing.cacheReadTokens + delta.cacheReadTokens,
    contextFinalTokens: delta.contextFinalTokens ?? existing.contextFinalTokens,
    contextPeakTokens:
      existing.contextPeakTokens === null && delta.contextPeakCandidate === null
        ? null
        : Math.max(existing.contextPeakTokens ?? 0, delta.contextPeakCandidate ?? 0),
    contextModel: delta.contextFinalTokens !== null ? delta.contextModel : existing.contextModel,
    startedAt:
      existing.startedAt && delta.startedAt
        ? (existing.startedAt < delta.startedAt ? existing.startedAt : delta.startedAt)
        : (existing.startedAt ?? delta.startedAt),
    endedAt:
      existing.endedAt && delta.endedAt
        ? (existing.endedAt > delta.endedAt ? existing.endedAt : delta.endedAt)
        : (existing.endedAt ?? delta.endedAt),
    messageCount: existing.messageCount + delta.messageCount,
    gitBranch: existing.gitBranch ?? delta.gitBranch,
    claudeVersion: existing.claudeVersion ?? delta.claudeVersion,
    cwd: existing.cwd ?? delta.cwd,
    parseErrors: existing.parseErrors + delta.parseErrors,
    modelsUsed: union(existing.modelsUsed, delta.modelsUsed),
    modelTokens: mergeModelTokens(existing.modelTokens, delta.modelTokens),
    activityRanges,
    sessionName: delta.sessionNameChanged ? delta.sessionName : existing.sessionName,
  };
}

/**
 * Full-text search input is bounded to the most recent user messages within
 * `maxBytes` (specs/behaviors/session-transcript-storage.md: "Search text is
 * bounded"), not an ever-growing concatenation of the whole history. Walks
 * from the end so a session with thousands of messages costs only the tail.
 */
export function boundedSearchText(userMessages: readonly string[], maxBytes = 256 * 1024): string {
  const parts: string[] = [];
  let bytes = 0;
  for (let i = userMessages.length - 1; i >= 0; i--) {
    const msg = userMessages[i]!;
    const msgBytes = Buffer.byteLength(msg, 'utf8') + 1; // +1 for the joining space
    if (bytes + msgBytes > maxBytes && parts.length > 0) break;
    parts.unshift(msg);
    bytes += msgBytes;
    if (bytes >= maxBytes) break;
  }
  return parts.join(' ');
}
