/**
 * Sonnet-class prep composer.
 *
 * Mirrors the digest summarizer / join classifier pattern already used in this
 * codebase (single Anthropic invoker, model id from config, plain
 * `messages.create`, graceful fallback): a Sonnet-class model turns the
 * assembled inputs into a tight, Tana-paste-ready prep. It SYNTHESIZES; it does
 * not re-decide whether the meeting is join-required (that's the shared
 * classifier's job). Any failure falls back to the deterministic assembly, so
 * the cycle never blocks on the model.
 *
 * The model id is configurable (MEETING_PREP_MODEL) and defaults to the repo's
 * Sonnet-class default (claude-sonnet-5), matching the sessions-synthesis job.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { FastifyBaseLogger } from 'fastify';
import type { PrepInputs } from './compose.js';
import { buildPrepPrompt, deterministicPrep } from './compose.js';

export interface PrepComposer {
  /** Compose the prep body (Tana-paste-ready bullet outline). Never throws. */
  compose(inputs: PrepInputs): Promise<string>;
  /** Model id recorded against the prep. */
  readonly modelId: string;
}

const SYSTEM_PROMPT = `<role>
You write a concise pre-meeting prep briefing for the owner. You are given a meeting, its prior occurrences, prior-occurrence notes/transcript context, and any items captured since the last time it met. Synthesize them into a prep they can skim right before the meeting.
</role>

<guidance>
- Lead with what matters: open threads from last time, decisions owed, and the specific items captured since. Do not restate the calendar metadata.
- Ground every claim in the provided inputs. Do not invent attendees, decisions, or history that isn't there. If there's little to say, say little.
- Prefer a short "since last time / open threads / to raise" shape over a generic agenda.
</guidance>

<response_format>
Return ONLY a Tana-style bullet outline: lines beginning with "- " (two-space indent for nesting). No supertags, no "#", no numbered lists, no preamble, no closing remarks.
</response_format>`;

export class AnthropicPrepComposer implements PrepComposer {
  private client: Anthropic;
  readonly modelId: string;
  private maxTokens: number;
  private log: FastifyBaseLogger;

  constructor(config: { apiKey: string; model?: string; maxTokens?: number }, log: FastifyBaseLogger) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.modelId = config.model ?? 'claude-sonnet-5';
    this.maxTokens = config.maxTokens ?? 1500;
    this.log = log;
  }

  async compose(inputs: PrepInputs): Promise<string> {
    try {
      const res = await this.client.messages.create({
        model: this.modelId,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildPrepPrompt(inputs) }],
      });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      // Guard against an empty / non-bullet reply — fall back rather than render junk.
      if (!text || !text.includes('- ')) return deterministicPrep(inputs);
      return normalizeBullets(text);
    } catch (err) {
      this.log.warn(
        { err, occurrence: inputs.occurrence.occurrenceKey },
        'Prep composition failed — using deterministic fallback'
      );
      return deterministicPrep(inputs);
    }
  }
}

/** Strip any stray leading prose and ensure every kept line is a bullet. */
export function normalizeBullets(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const kept = lines.filter((l) => l.trimStart().startsWith('- '));
  return (kept.length > 0 ? kept : lines.map((l) => `- ${l.trim()}`)).join('\n');
}
