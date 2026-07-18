/**
 * Classification event detector — the cheap-model (Haiku) pass over each new
 * message window. Mirrors the capture classifier and email triage patterns:
 * XML-tagged JSON output, one parse-correction retry, enum validation.
 *
 * A window usually yields an EMPTY array — that's the point. The prompt is
 * tuned for signal density so the weekly synthesis isn't drowning in trivia;
 * an event is only emitted for a clear, high-value signal.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { FastifyBaseLogger } from 'fastify';
import { CLASSIFICATION_EVENT_TYPES, type ClassificationEventType, type DetectedEvent } from './types.js';

class EventParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventParseError';
  }
}

export interface ClassificationConfig {
  apiKey: string;
  /** default: claude-haiku-4-5 */
  model?: string;
  maxTokens?: number;
}

export interface DeltaContext {
  sessionId: string;
  projectPath: string | null;
  gitBranch: string | null;
  /** Serialized transcript text of the new-message window. */
  deltaText: string;
}

export const CLASSIFICATION_SYSTEM_PROMPT = `<role>
You read a WINDOW of new messages from a Claude Code session where the owner (a consulting-business owner) works with a personal AI assistant across his business and personal systems. Your job is to detect high-value SIGNALS that should feed a weekly self-improvement review — nothing else. You never act on the content, and you never summarize the window.
</role>

<event_types>
- correction: the owner corrects the assistant's work, facts, approach, or output — "no, that's wrong", "actually it's X", reverting/redoing something the assistant did, or pointing out a mistake. This is the HIGHEST-VALUE class; capture it whenever it clearly occurs.
- friction: Repeated tool failures, permission blocks, commands that error and get retried, the assistant getting stuck, or the owner expressing frustration ("why did you...", "stop", "that's the third time"). One-off recoverable errors are NOT friction; a PATTERN or a block is.
- rule-candidate: An explicit durable instruction — an "always/never", a workflow decision, a stated preference meant to hold beyond this session ("always use X", "never commit without Y", "from now on ...").
- notable-decision: A meaningful decision or direction that a human reviewing the week would want on the record (an architecture choice, a go/no-go, a scope change). Not routine task completion.
</event_types>

<instructions>
1. Read the window. Detect ONLY clear, high-value signals matching the types above.
2. Most windows contain NO signal — return an empty array. Do not invent events to fill space. Do not emit routine progress, successful tool calls, or ordinary task work.
3. For each event: pick exactly one type, write a one-line summary, set confidence 0.0–1.0, and include a short VERBATIM quote (<= 200 chars) copied from the window that evidences it.
4. Prefer precision over recall. A trivial or speculative event is worse than none.
</instructions>

<response_format>
Return ONLY a JSON array inside <events> tags. No markdown, no prose outside the tags. An empty array is valid and expected for most windows.

<events>
[
  { "type": "correction", "summary": "...", "confidence": 0.0, "quote": "..." }
]
</events>
</response_format>`;

/** Build the user prompt for one delta window. Pure — unit-tested directly. */
export function buildClassificationPrompt(ctx: DeltaContext): string {
  return `<session>
<project>${ctx.projectPath ?? 'unknown'}</project>
<branch>${ctx.gitBranch ?? 'unknown'}</branch>
</session>
<window>
${ctx.deltaText}
</window>`;
}

/** Parse the model's <events> array, validating each event. Pure. */
export function parseClassificationEvents(text: string): DetectedEvent[] {
  const match = text.match(/<events>\s*([\s\S]*?)\s*<\/events>/);
  if (!match) {
    throw new EventParseError('No <events> tags found in response');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!.trim());
  } catch (error) {
    throw new EventParseError(
      `JSON parse error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new EventParseError('Expected a JSON array inside <events>');
  }

  const events: DetectedEvent[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const type = r.type;
    if (!CLASSIFICATION_EVENT_TYPES.includes(type as ClassificationEventType)) {
      // Skip an unknown-type row rather than failing the whole window.
      continue;
    }
    const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
    if (!summary) continue;
    const confidence =
      typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1
        ? r.confidence
        : 0.5;
    const quote =
      typeof r.quote === 'string' && r.quote.trim() ? r.quote.trim().slice(0, 500) : null;
    events.push({ type: type as ClassificationEventType, summary, confidence, quote });
  }
  return events;
}

/**
 * The Haiku classifier. One `classifyDelta` call per session delta window.
 */
export class ClassificationEventClassifier {
  private client: Anthropic;
  readonly model: string;
  private maxTokens: number;
  private log: FastifyBaseLogger;

  constructor(config: ClassificationConfig, log: FastifyBaseLogger) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model ?? 'claude-haiku-4-5';
    this.maxTokens = config.maxTokens ?? 1024;
    this.log = log;
  }

  async classifyDelta(ctx: DeltaContext): Promise<DetectedEvent[]> {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: buildClassificationPrompt(ctx) },
    ];

    const maxRetries = 1;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: CLASSIFICATION_SYSTEM_PROMPT,
        messages,
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      const rawText = textBlock?.type === 'text' ? textBlock.text : '';
      messages.push({ role: 'assistant', content: rawText });

      try {
        return parseClassificationEvents(rawText);
      } catch (error) {
        if (attempt < maxRetries && error instanceof EventParseError) {
          this.log.warn(
            { sessionId: ctx.sessionId, attempt, error: error.message },
            'Classification parse failed, requesting correction'
          );
          messages.push({
            role: 'user',
            content: `<error>Parse failed: ${error.message}</error>\n\nReturn the corrected JSON array inside <events> tags (an empty array is fine).`,
          });
        } else {
          throw error;
        }
      }
    }

    throw new Error('Unexpected: classifier retry loop exited without result');
  }
}
