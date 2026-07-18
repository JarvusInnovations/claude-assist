/**
 * Residue classifier — the cheap-model (Haiku) pass over messages the
 * deterministic core couldn't confidently decide.
 *
 * Mirrors the email-triage / capture-classifier patterns exactly: XML-tagged
 * JSON output, one parse-correction retry, enum/shape validation. It sees the
 * candidate plus a few lines of preceding thread context and answers one
 * question — the principle's regret test: would the owner regret seeing this an
 * hour later instead of now? If not, it's digest material.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { FastifyBaseLogger } from 'fastify';
import type { ModelVerdict, SlackCandidate } from './types.js';

class VerdictParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerdictParseError';
  }
}

export interface ResidueClassifierConfig {
  apiKey: string;
  /** default: claude-haiku-4-5 */
  model?: string;
  maxTokens?: number;
}

/** A prior message in the thread, for context (oldest → newest). */
export interface ThreadContextLine {
  who: string; // "the owner" | sender display name | user id
  text: string;
}

/**
 * The residue judgment surface the pipeline depends on. An interface (not the
 * concrete class) so the pipeline is testable with a stub — a class with private
 * fields is not structurally assignable.
 */
export interface ResidueJudge {
  classify(candidate: SlackCandidate, context: ThreadContextLine[]): Promise<ModelVerdict>;
}

const SYSTEM_PROMPT = `<role>
You are the urgency gate for the owner, a consulting-business owner. A message from a teammate has reached you that simple rules could not decide. Your ONLY job: decide whether it earns a push notification to the owner's phone and watch RIGHT NOW, or whether it can wait for his next digest.
</role>

<bar>
The bar is high on purpose. Silence must stay trustworthy — the owner relies on NOT being interrupted to mean nothing needs him. Fire ONLY for what genuinely can't wait:
- a teammate is blocked and waiting on the owner specifically,
- a time-sensitive request with a real near-term deadline,
- an explicit question or decision that is holding someone up.

The decisive test: would the owner regret seeing this an hour from now instead of now? If yes → urgent. If it is FYI, social, a heads-up, "when you get a chance", status, or something with no near-term consequence → NOT urgent (it batches into a digest). When genuinely unsure, choose NOT urgent: a missed digest item is recoverable; an eroded interrupt bar is not.
</bar>

<instructions>
1. Read the message and any thread context.
2. Judge against the bar above. Ignore politeness/urgency theater ("ASAP" with no real deadline is not urgent).
3. Write a one-line gist (who needs what) usable verbatim in a phone alert.
4. State confidence 0.0-1.0 and a one-sentence rationale.
</instructions>

<response_format>
Return ONLY a JSON object inside <verdict> tags. No markdown, no text outside the tags.

<verdict>
{
  "urgent": true,
  "gist": "one line: who needs what",
  "confidence": 0.0,
  "rationale": "one sentence"
}
</verdict>
</response_format>`;

export class ResidueClassifier implements ResidueJudge {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private log: FastifyBaseLogger;

  constructor(config: ResidueClassifierConfig, log: FastifyBaseLogger) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model ?? 'claude-haiku-4-5';
    this.maxTokens = config.maxTokens ?? 512;
    this.log = log;
  }

  async classify(
    candidate: SlackCandidate,
    context: ThreadContextLine[]
  ): Promise<ModelVerdict> {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: this.buildPrompt(candidate, context) },
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
        throw new Error('No text response from urgency classifier');
      }
      messages.push({ role: 'assistant', content: textContent.text });

      try {
        const parsed = this.parseVerdict(textContent.text);
        return { ...parsed, model: this.model };
      } catch (error) {
        if (attempt < maxRetries && error instanceof VerdictParseError) {
          this.log.warn(
            { channel: candidate.channel, ts: candidate.ts, attempt, error: error.message },
            'Urgency verdict parse failed, requesting correction'
          );
          messages.push({
            role: 'user',
            content: `<error>Parse failed: ${error.message}</error>\n\nReturn the corrected JSON inside <verdict> tags.`,
          });
        } else {
          throw error;
        }
      }
    }

    throw new Error('Unexpected: urgency classifier retry loop exited without result');
  }

  private buildPrompt(candidate: SlackCandidate, context: ThreadContextLine[]): string {
    const ctxBlock =
      context.length > 0
        ? `<thread_context>\n${context
            .map((l) => `<line who="${escapeAttr(l.who)}">${escapeText(l.text)}</line>`)
            .join('\n')}\n</thread_context>\n`
        : '';
    const from = candidate.senderName ?? candidate.sender;
    return `${ctxBlock}<message>
<from>${escapeAttr(from)}</from>
<channel_type>${candidate.channelType}</channel_type>
<text>
${escapeText(candidate.text)}
</text>
</message>`;
  }

  private parseVerdict(text: string): Omit<ModelVerdict, 'model'> {
    const match = text.match(/<verdict>\s*([\s\S]*?)\s*<\/verdict>/);
    if (!match) throw new VerdictParseError('No <verdict> tags found in response');

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(match[1]!.trim());
    } catch (error) {
      throw new VerdictParseError(
        `JSON parse error: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (typeof parsed.urgent !== 'boolean') {
      throw new VerdictParseError(`Invalid "urgent": ${String(parsed.urgent)} (must be boolean)`);
    }
    const confidence =
      typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : 0.5;
    return {
      urgent: parsed.urgent,
      gist: typeof parsed.gist === 'string' ? parsed.gist.trim() : '',
      confidence,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    };
  }
}

/** Model input is untrusted content; keep it from breaking the XML envelope. */
function escapeText(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}
