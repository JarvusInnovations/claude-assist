/**
 * Cheap-tier residue pass for the join-required classifier.
 *
 * Only the genuinely ambiguous events (structurally join-worthy but soft-noise
 * flagged — see join-required.ts) reach this; the deterministic pre-pass is
 * what makes the classifier affordable. With the invoker unavailable the
 * residue falls back to a conservative default (don't fire — a near-miss
 * surfaces in the daily briefing per the false-negative-backstop principle).
 */

import type { FastifyBaseLogger } from 'fastify';
import type { ModelInvoker } from '@jarvus/claude-assist-core';
import type { CalendarEvent, JoinClassification, VenueKind } from '../types.js';

class JoinParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JoinParseError';
  }
}

export interface JoinModelConfig {
  /** The single metered-model choke point (specs/modules/invoker.md). */
  invoker: ModelInvoker;
  /** Pin a model for this call site. Prefer moving the tier instead. */
  model?: string;
  maxTokens?: number;
}

const SYSTEM_PROMPT = `<role>
You decide whether one calendar event is a "join-required meeting" for the owner — a real meeting he must actively attend at its start time — versus calendar noise (a soft hold, an optional/FYI block, a tentatively-placed slot, or something already cancelled). A deterministic pre-pass already confirmed this event has a venue (video link or physical location) and other attendees; you are only resolving the ambiguous framing (words like optional / tentative / maybe / FYI, or a tentative RSVP).
</role>

<guidance>
- join_required = true when the owner genuinely needs to show up: a scheduled call or in-person meeting with others that is really happening.
- join_required = false when the event is optional-for-the owner, a tentative placeholder he need not attend, an FYI/broadcast he isn't expected to join live, or cancelled.
- When truly balanced, prefer false: a missed alert on a borderline-optional item is cheaper than a false alarm (the item still surfaces in the owner's daily briefing).
</guidance>

<response_format>
Return ONLY a JSON object inside <join> tags. No prose outside the tags.

<join>
{
  "join_required": true,
  "confidence": 0.0,
  "rationale": "one sentence"
}
</join>
</response_format>`;

export class JoinRequiredModel {
  private invoker: ModelInvoker;
  private model: string | undefined;
  private maxTokens: number;
  private log: FastifyBaseLogger;

  constructor(config: JoinModelConfig, log: FastifyBaseLogger) {
    this.invoker = config.invoker;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 512;
    this.log = log;
  }

  /** Resolve one ambiguous event. `venue` carries through from the pre-pass. */
  async classify(event: CalendarEvent, venue: VenueKind): Promise<JoinClassification> {
    // Retries, the parse-correction turn, and spend accounting live in the
    // invoker; the deterministic pre-pass upstream is what keeps this call
    // site cheap, and it is unchanged.
    const parsed = await this.invoker.invokeTagged<{ joinRequired: boolean; confidence: number }>({
      task: 'briefing.join-required',
      tier: 'classify',
      maxTokens: this.maxTokens,
      ...(this.model ? { model: this.model } : {}),
      system: SYSTEM_PROMPT,
      tag: 'join',
      parse: parseJoin,
      messages: [{ role: 'user', content: buildPrompt(event) }],
    });

    return {
      joinRequired: parsed.joinRequired,
      reason: `model:${parsed.joinRequired ? 'join' : 'noise'}`,
      venue,
      source: 'model',
      confidence: parsed.confidence,
    };
  }
}

export function buildPrompt(event: CalendarEvent): string {
  return `<event>
<summary>${event.summary}</summary>
<start>${event.start}</start>
<my_response>${event.myResponse || '(none)'}</my_response>
<attendee_count>${event.attendeeCount}</attendee_count>
<location>${event.location || '(none)'}</location>
<has_video_link>${event.hangoutLink ? 'yes' : 'no'}</has_video_link>
${event.description ? `<description>${event.description.slice(0, 600)}</description>` : ''}
</event>`;
}

/** Receives the contents of the `<join>` block; the invoker extracts it. */
export function parseJoin(raw: string): { joinRequired: boolean; confidence: number } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (error) {
    throw new JoinParseError(
      `JSON parse error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (typeof parsed.join_required !== 'boolean') {
    throw new JoinParseError(`join_required must be a boolean, got ${typeof parsed.join_required}`);
  }
  const confidence =
    typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0.5;
  return { joinRequired: parsed.join_required, confidence };
}
