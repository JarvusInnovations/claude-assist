/**
 * Haiku residue pass for the join-required classifier.
 *
 * Only the genuinely ambiguous events (structurally join-worthy but soft-noise
 * flagged — see join-required.ts) reach this. Mirrors the email-triage /
 * capture-classifier API patterns: cheap model, XML-tagged JSON output, one
 * parse-correction retry, validated boolean. Absent an API key the residue
 * falls back to a conservative default (don't fire — a near-miss surfaces in
 * the daily briefing per the false-negative-backstop principle).
 */

import Anthropic from '@anthropic-ai/sdk';
import type { FastifyBaseLogger } from 'fastify';
import type { CalendarEvent, JoinClassification, VenueKind } from '../types.js';

class JoinParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JoinParseError';
  }
}

export interface JoinModelConfig {
  apiKey: string;
  /** default: claude-haiku-4-5 */
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
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private log: FastifyBaseLogger;

  constructor(config: JoinModelConfig, log: FastifyBaseLogger) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model ?? 'claude-haiku-4-5';
    this.maxTokens = config.maxTokens ?? 512;
    this.log = log;
  }

  /** Resolve one ambiguous event. `venue` carries through from the pre-pass. */
  async classify(event: CalendarEvent, venue: VenueKind): Promise<JoinClassification> {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: buildPrompt(event) },
    ];

    const maxRetries = 1;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        messages,
      });
      const textContent = response.content.find((c) => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        throw new Error('No text response from join classifier');
      }
      messages.push({ role: 'assistant', content: textContent.text });

      try {
        const parsed = parseJoin(textContent.text);
        return {
          joinRequired: parsed.joinRequired,
          reason: `model:${parsed.joinRequired ? 'join' : 'noise'}`,
          venue,
          source: 'model',
          confidence: parsed.confidence,
        };
      } catch (error) {
        if (attempt < maxRetries && error instanceof JoinParseError) {
          this.log.warn(
            { eventId: event.id, attempt, error: error.message },
            'Join classification parse failed, requesting correction'
          );
          messages.push({
            role: 'user',
            content: `<error>Parse failed: ${error.message}</error>\n\nReturn the corrected JSON inside <join> tags.`,
          });
        } else {
          throw error;
        }
      }
    }
    throw new Error('Unexpected: join classifier retry loop exited without result');
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

export function parseJoin(text: string): { joinRequired: boolean; confidence: number } {
  const match = text.match(/<join>\s*([\s\S]*?)\s*<\/join>/);
  if (!match) throw new JoinParseError('No <join> tags found in response');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[1]!.trim());
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
