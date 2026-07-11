/**
 * Email residue judge — the cheap-model (Haiku) pass over mail that cleared the
 * deterministic structural gates but lacked keyword certainty.
 *
 * The deterministic core (urgency.ts) can PROMOTE a known, directed human with a
 * deadline phrase straight to INTERRUPT, and it DROPS strangers and automated
 * mail with no model call. What it hands here is the ambiguous middle: a message
 * from a sender WITH standing where the tier turns on inference keywords can't
 * make. This judge answers three questions the tiers are defined by:
 *
 *   directedAsk       — is there a concrete ask ADDRESSED TO THE OWNER (in the To
 *                        line, or to the owner by name in the body)? This is the
 *                        ATTENTION bar and the action-item tightening rule: a bare
 *                        "thing the owner might do" is NOT a directed ask.
 *   cannotWaitAnHour  — does that ask carry blocking / time-sensitivity such that
 *                        the owner would regret seeing it an hour from now? This is
 *                        the INTERRUPT bar (keywords are a signal, not the test).
 *   emergency         — a genuine emergency that should pierce quiet hours.
 *
 * Mirrors the triage / slack-residue patterns exactly: XML-tagged JSON output,
 * one parse-correction retry, enum/shape validation.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { FastifyBaseLogger } from 'fastify';

class VerdictParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerdictParseError';
  }
}

export interface EmailModelVerdict {
  /** A concrete ask addressed to the owner (To line or by name in the body). */
  directedAsk: boolean;
  /** The ask is blocking / time-sensitive — cannot wait an hour (interrupt bar). */
  cannotWaitAnHour: boolean;
  /** A genuine emergency — pierces quiet hours. */
  emergency: boolean;
  /** One-line gist usable verbatim in an alert / briefing entry. */
  gist: string;
  confidence: number;
  rationale: string;
  model: string;
}

export interface EmailResidueJudge {
  judge(input: EmailJudgeInput): Promise<EmailModelVerdict>;
}

export interface EmailJudgeInput {
  ownerLabel: string;
  ownerAddresses: readonly string[];
  fromName: string | null;
  fromAddress: string | null;
  toAddresses: readonly string[];
  ccAddresses: readonly string[];
  subject: string | null;
  bodyText: string | null;
  snippet: string | null;
  /** Standing of the sender, for context (whitelist/client-contact/team-domain). */
  standing: string;
  /** Overview/parent-thread summary if available. */
  threadSummary?: string | null;
}

export interface EmailResidueConfig {
  apiKey: string;
  /** default: claude-haiku-4-5 */
  model?: string;
  maxTokens?: number;
}

const SYSTEM_PROMPT = `<role>
You are the email urgency gate for the owner of a consulting business. A message from a KNOWN sender (a client contact, a prior correspondent, or a teammate) has reached you that simple rules could not tier. Decide how it should surface.
</role>

<tiers>
- INTERRUPT ("bad if unseen for an hour"): a concrete ask directed at the owner that is blocking or time-sensitive — the owner would genuinely regret seeing it an hour from now. Set directedAsk=true AND cannotWaitAnHour=true.
- ATTENTION ("bad if unseen until tomorrow"): a concrete ask addressed to the owner, OR substantive business mail from a client contact (e.g. an accounts-payable / payments thread) that the owner should see today but that is not blocking. Set directedAsk=true, cannotWaitAnHour=false.
- NEITHER: FYI, social, status, "when you get a chance", a CC where nothing is asked of the owner specifically, or a "thing the owner might do" that no one actually asked for. Set directedAsk=false.
</tiers>

<rules>
- "Directed at the owner" means the owner is in the To line, OR the body addresses a request to the owner by name. A pure CC with no ask aimed at the owner is NOT directed — set directedAsk=false.
- Action-item tightening: only a CONCRETE ASK the sender is actually making of the owner counts. Do not invent tasks from the topic. "We should think about X" is not an ask.
- Keywords like "urgent"/"ASAP" are signals, not proof. Judge the real consequence of waiting. Ignore urgency theater.
- emergency=true ONLY for a genuine emergency (outage, a client escalation that is actively on fire, a hard legal/financial deadline expiring within the hour). This pierces quiet hours; use it sparingly.
- When genuinely unsure between tiers, choose the calmer one. An eroded interrupt bar is not recoverable; a missed digest item is.
</rules>

<instructions>
1. Read the metadata (who it's from, who is in To vs CC) and the body.
2. Decide directedAsk, cannotWaitAnHour, emergency per the rules above.
3. Write a one-line gist (who needs what) usable verbatim in an alert.
4. State confidence 0.0-1.0 and a one-sentence rationale.
</instructions>

<response_format>
Return ONLY a JSON object inside <verdict> tags. No markdown, no text outside the tags.

<verdict>
{
  "directedAsk": true,
  "cannotWaitAnHour": false,
  "emergency": false,
  "gist": "one line: who needs what",
  "confidence": 0.0,
  "rationale": "one sentence"
}
</verdict>
</response_format>`;

export class EmailResidueClassifier implements EmailResidueJudge {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private log: FastifyBaseLogger;

  constructor(config: EmailResidueConfig, log: FastifyBaseLogger) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model ?? 'claude-haiku-4-5';
    this.maxTokens = config.maxTokens ?? 512;
    this.log = log;
  }

  async judge(input: EmailJudgeInput): Promise<EmailModelVerdict> {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: this.buildPrompt(input) },
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
        throw new Error('No text response from email residue judge');
      }
      messages.push({ role: 'assistant', content: textContent.text });

      try {
        const parsed = this.parseVerdict(textContent.text);
        return { ...parsed, model: this.model };
      } catch (error) {
        if (attempt < maxRetries && error instanceof VerdictParseError) {
          this.log.warn({ attempt, error: error.message }, 'Email residue verdict parse failed, retrying');
          messages.push({
            role: 'user',
            content: `<error>Parse failed: ${error.message}</error>\n\nReturn the corrected JSON inside <verdict> tags.`,
          });
        } else {
          throw error;
        }
      }
    }
    throw new Error('Unexpected: email residue judge retry loop exited without result');
  }

  private buildPrompt(input: EmailJudgeInput): string {
    const from = input.fromName
      ? `${escapeText(input.fromName)} <${escapeText(input.fromAddress ?? '')}>`
      : escapeText(input.fromAddress ?? 'unknown');
    const threadBlock = input.threadSummary
      ? `<thread_summary>${escapeText(input.threadSummary)}</thread_summary>\n`
      : '';
    return `<owner>${escapeText(input.ownerLabel)} (${input.ownerAddresses.map(escapeText).join(', ')})</owner>
<sender_standing>${escapeText(input.standing)}</sender_standing>
${threadBlock}<email>
<from>${from}</from>
<to>${input.toAddresses.map(escapeText).join(', ') || '(none)'}</to>
<cc>${input.ccAddresses.map(escapeText).join(', ') || '(none)'}</cc>
<subject>${escapeText(input.subject ?? '(no subject)')}</subject>
<body>
${escapeText(input.bodyText ?? input.snippet ?? '(empty)')}
</body>
</email>`;
  }

  private parseVerdict(text: string): Omit<EmailModelVerdict, 'model'> {
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
    if (typeof parsed.directedAsk !== 'boolean') {
      throw new VerdictParseError(`Invalid "directedAsk": ${String(parsed.directedAsk)} (must be boolean)`);
    }
    const confidence =
      typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : 0.5;
    return {
      directedAsk: parsed.directedAsk,
      cannotWaitAnHour: parsed.cannotWaitAnHour === true,
      emergency: parsed.emergency === true,
      gist: typeof parsed.gist === 'string' ? parsed.gist.trim() : '',
      confidence,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    };
  }
}

function escapeText(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
