/**
 * Opportunity evaluator — the owner-interest gate for procurement / RFP mail.
 *
 * The owner receives many procurement / bid-opportunity alerts. Most are noise;
 * a few match what the business actually pursues, and a rare handful are on an
 * actively-tracked watchlist. Rather than bake any interest criteria into this
 * PUBLIC toolkit, the evaluator loads an OWNER-MAINTAINED interest spec from a
 * file (path in GOOGLE_OPPORTUNITY_PROMPT_FILE — instance data, wired at deploy)
 * and asks a cheap model (Haiku) one question about a solicitation-class email:
 * does this opportunity match the owner's interests, and is it a high-priority
 * (watchlist-style) hit?
 *
 * The toolkit only knows "a prompt file"; its contents never appear here, in
 * tests, or in the repo. Mirrors the triage / residue classifier patterns:
 * XML-tagged JSON, one parse-correction retry, enum/shape validation.
 */

import { readFileSync } from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import type { ModelInvoker } from '@jarvus/claude-assist-core';

class VerdictParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerdictParseError';
  }
}

/** The stored result of an opportunity evaluation (also lands on analysis JSONB). */
export interface OpportunityVerdict {
  match: boolean;
  /** Watchlist-style / actively-tracked hit — routes to prominent attention. */
  high: boolean;
  /** One-line reasoning shown on the briefing's attention entry. */
  reasoning: string;
  model: string;
}

/**
 * The evaluation surface the pipeline depends on. An interface (not the concrete
 * class) so the pipeline is testable with a stub (a class with private fields is
 * not structurally assignable).
 */
export interface OpportunityJudge {
  evaluate(email: OpportunityEmail): Promise<OpportunityVerdict>;
}

export interface OpportunityEvaluatorConfig {
  /** The single metered-model choke point (specs/modules/invoker.md). */
  invoker: ModelInvoker;
  /** The owner's interest spec, already loaded from GOOGLE_OPPORTUNITY_PROMPT_FILE. */
  interestSpec: string;
  /** Pin a model for this call site. Prefer moving the tier instead. */
  model?: string;
  maxTokens?: number;
}

export interface OpportunityEmail {
  fromName: string | null;
  fromAddress: string | null;
  subject: string | null;
  bodyText: string | null;
  snippet: string | null;
}

/**
 * Load the owner's interest spec from disk. Returns null (feature off) when no
 * path is configured; throws only on a genuinely unreadable configured path so a
 * typo is loud rather than silently disabling the feature.
 */
export function loadOpportunityPrompt(path: string | undefined): string | null {
  if (!path) return null;
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) throw new Error(`GOOGLE_OPPORTUNITY_PROMPT_FILE at ${path} is empty`);
  return raw;
}

const SYSTEM_PROMPT_HEAD = `<role>
You screen inbound procurement / bid-opportunity emails for a consulting business against the owner's own interest specification. Decide whether THIS opportunity is one the owner would want surfaced.
</role>

<owner_interest_spec>
The owner maintains the following specification of what they are and are not interested in, plus a watchlist of actively-tracked upcoming procurements. Judge strictly against it.

`;

const SYSTEM_PROMPT_TAIL = `
</owner_interest_spec>

<instructions>
1. Read the email (a procurement notice, RFP/RFQ/RFI, or bid opportunity).
2. Decide "match": true only if it fits an interest type in the spec AND is not excluded by a NOT-interested rule. When genuinely unsure, prefer match=false — a missed item is recoverable from the calm digest; a false match erodes the attention tier.
3. Decide "high": true only if it matches a specific watchlist entry (by agency, title, project name, or subject matter) or the spec explicitly says to score that kind of thing high.
4. Write a one-line reasoning (which interest type or watchlist entry it matched, or why it did not) usable verbatim in a morning briefing.
</instructions>

<response_format>
Return ONLY a JSON object inside <verdict> tags. No markdown, no text outside the tags.

<verdict>
{
  "match": true,
  "high": false,
  "reasoning": "one line"
}
</verdict>
</response_format>`;

export class OpportunityEvaluator implements OpportunityJudge {
  private invoker: ModelInvoker;
  private interestSpec: string;
  private model: string | undefined;
  private maxTokens: number;
  private log: FastifyBaseLogger;

  constructor(config: OpportunityEvaluatorConfig, log: FastifyBaseLogger) {
    this.invoker = config.invoker;
    this.interestSpec = config.interestSpec;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 512;
    this.log = log;
  }

  private systemPrompt(): string {
    return `${SYSTEM_PROMPT_HEAD}${this.interestSpec}${SYSTEM_PROMPT_TAIL}`;
  }

  async evaluate(email: OpportunityEmail): Promise<OpportunityVerdict> {
    // Tag extraction, the parse-correction turn, retries, timeout, and spend
    // accounting live in the invoker; the interest-spec assembly and the shape
    // validation stay here, where the judgment is.
    const parsed = await this.invoker.invokeTagged<Omit<OpportunityVerdict, 'model'>>({
      task: 'google.opportunity',
      tier: 'classify',
      maxTokens: this.maxTokens,
      ...(this.model ? { model: this.model } : {}),
      system: this.systemPrompt(),
      tag: 'verdict',
      parse: (raw) => this.parseVerdict(raw),
      messages: [{ role: 'user', content: this.buildPrompt(email) }],
    });

    return { ...parsed, model: this.model ?? this.invoker.modelFor('classify') };
  }

  private buildPrompt(email: OpportunityEmail): string {
    const from = email.fromName
      ? `${escapeText(email.fromName)} <${escapeText(email.fromAddress ?? '')}>`
      : escapeText(email.fromAddress ?? 'unknown');
    return `<email>
<from>${from}</from>
<subject>${escapeText(email.subject ?? '(no subject)')}</subject>
<body>
${escapeText(email.bodyText ?? email.snippet ?? '(empty)')}
</body>
</email>`;
  }

  /** Receives the contents of the `<verdict>` block; the invoker extracts it. */
  private parseVerdict(raw: string): Omit<OpportunityVerdict, 'model'> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw.trim());
    } catch (error) {
      throw new VerdictParseError(
        `JSON parse error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (typeof parsed.match !== 'boolean') {
      throw new VerdictParseError(`Invalid "match": ${String(parsed.match)} (must be boolean)`);
    }
    return {
      match: parsed.match,
      high: parsed.high === true,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.trim() : '',
    };
  }
}

function escapeText(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
