/**
 * Transaction-workflow assist — categorize and annotate, as PROPOSALS.
 *
 * The invariant this file exists to hold: **the assist never edits a ledger.**
 * It reads the rows the deterministic composer already flagged, asks a model
 * what each one probably is, and writes rows to `finance.suggestions`. Nothing
 * downstream of that happens without a human decision, and the only code that
 * can reach the provider is the apply path, which refuses to act on anything
 * not explicitly accepted.
 *
 * Two smaller decisions worth stating:
 *
 * - **Categories are constrained to the ones that exist.** The model picks from
 *   the account's own category list; a free-text category would be a suggestion
 *   the apply path could not honor, which is worse than no suggestion.
 * - **A suggestion that matches the current value is dropped.** Proposing what
 *   is already true is how an assist teaches its owner to stop reading it.
 */

import type { FastifyBaseLogger } from 'fastify';
import {
  isTransientModelError,
  type ModelInvoker,
} from '@jarvus/claude-assist-core';
import type { NewSuggestion } from '../store.js';
import type { FlaggedTransaction, ReviewSummary, TransactionRecord } from '../types.js';
import type { SourceCategory } from '../source/types.js';

export const ASSIST_TASK = 'finance.assist';

export interface AssistConfig {
  /** Pin a model, overriding the `classify` tier. */
  model?: string;
  /** Transactions handed to the model per review (default 60). */
  limit?: number;
}

interface ModelSuggestion {
  id: string;
  category?: string;
  note?: string;
  rationale?: string;
  confidence?: string;
}

const SYSTEM_PROMPT = [
  'You help reconcile a personal finance ledger at the end of a month.',
  '',
  'You are given transactions the reconciliation flagged, and the exact list of',
  'categories the ledger allows. For each transaction, propose at most one',
  'category (which MUST be copied verbatim from the allowed list) and at most',
  'one short annotation note.',
  '',
  'Rules:',
  '- Propose a category only when the merchant makes it reasonably clear. Say',
  '  nothing rather than guess; an unhelpful suggestion costs the reader more',
  '  than a missing one.',
  '- Never propose the category a transaction already has.',
  '- A note is for what the reader would otherwise have to reconstruct: a',
  '  likely subscription, a probable duplicate, an amount out of line with the',
  '  same merchant earlier in the month. Not a restatement of the row.',
  '- Confidence is one of high, medium, low.',
  '- Omit a transaction entirely when you have nothing useful to say about it.',
  '',
  'Answer inside <suggestions> tags as a JSON array of objects with keys:',
  'id, category, note, rationale, confidence. No prose outside the tags.',
].join('\n');

export class TransactionAssist {
  constructor(
    private invoker: ModelInvoker,
    private log: FastifyBaseLogger,
    private config: AssistConfig = {},
  ) {}

  /**
   * Produce proposals for a composed review. Returns `[]` — never throws — when
   * the model is unavailable: a review without an assist is still a review, and
   * failing the whole batch over a spend ceiling would be the tail wagging the
   * dog.
   */
  async propose(
    summary: ReviewSummary,
    categories: SourceCategory[],
  ): Promise<NewSuggestion[]> {
    const candidates = selectCandidates(summary, this.config.limit ?? 60);
    if (candidates.length === 0) return [];

    const allowed = categories.map((c) => c.name).filter(Boolean);
    try {
      const suggestions = await this.invoker.invokeTagged<ModelSuggestion[]>({
        task: ASSIST_TASK,
        tier: 'classify',
        ...(this.config.model ? { model: this.config.model } : {}),
        maxTokens: 4000,
        system: SYSTEM_PROMPT,
        // The system prompt is long, static, and hit once a month per period —
        // below the point where a cache breakpoint pays for itself.
        tag: 'suggestions',
        parse: parseSuggestions,
        messages: [
          {
            role: 'user',
            content: [
              allowed.length > 0
                ? `Allowed categories:\n${allowed.map((c) => `- ${c}`).join('\n')}`
                : 'Allowed categories: (unknown — do not propose a category)',
              '',
              'Transactions:',
              JSON.stringify(candidates.map(toModelRow), null, 1),
            ].join('\n'),
          },
        ],
      });
      return toSuggestions(suggestions, candidates, allowed);
    } catch (err) {
      if (isTransientModelError(err)) {
        this.log.warn({ err }, 'Finance assist skipped — model unavailable this run');
      } else {
        this.log.error({ err }, 'Finance assist failed — the review renders without proposals');
      }
      return [];
    }
  }
}

/**
 * Which rows get the model's attention: the ones the composer already decided a
 * human should look at, uncategorized first (that is the work the assist can
 * most directly reduce), deduplicated, and capped.
 */
export function selectCandidates(summary: ReviewSummary, limit: number): TransactionRecord[] {
  const seen = new Set<string>();
  const out: TransactionRecord[] = [];
  const push = (items: FlaggedTransaction[]) => {
    for (const item of items) {
      if (out.length >= limit) return;
      if (seen.has(item.transaction.externalId)) continue;
      seen.add(item.transaction.externalId);
      out.push(item.transaction);
    }
  };
  push(summary.uncategorized);
  push(summary.flagged);
  return out;
}

function toModelRow(t: TransactionRecord): Record<string, unknown> {
  return {
    id: t.externalId,
    date: t.postedOn,
    amount: t.amount,
    merchant: t.merchant ?? t.description ?? 'unknown',
    current_category: t.categoryName ?? null,
    current_note: t.notes ?? null,
  };
}

export function parseSuggestions(raw: string): ModelSuggestion[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('expected a JSON array of suggestions');
  return parsed.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('each suggestion is an object');
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) throw new Error('each suggestion needs a string id');
    return {
      id: row.id,
      ...(typeof row.category === 'string' ? { category: row.category } : {}),
      ...(typeof row.note === 'string' ? { note: row.note } : {}),
      ...(typeof row.rationale === 'string' ? { rationale: row.rationale } : {}),
      ...(typeof row.confidence === 'string' ? { confidence: row.confidence } : {}),
    };
  });
}

/**
 * Turn model output into storable proposals, dropping everything that would be
 * unusable or pointless: unknown transaction ids, categories that aren't in the
 * allowed list, and suggestions that restate the current value.
 */
export function toSuggestions(
  suggestions: ModelSuggestion[],
  candidates: TransactionRecord[],
  allowedCategories: string[],
): NewSuggestion[] {
  const byId = new Map(candidates.map((t) => [t.externalId, t]));
  // Case-insensitive match, canonical casing preserved from the allowed list.
  const canonical = new Map(allowedCategories.map((c) => [c.toLowerCase(), c]));
  const out: NewSuggestion[] = [];

  for (const suggestion of suggestions) {
    const transaction = byId.get(suggestion.id);
    if (!transaction) continue;
    const confidence = normalizeConfidence(suggestion.confidence);

    if (suggestion.category) {
      const match = canonical.get(suggestion.category.trim().toLowerCase());
      if (match && match !== transaction.categoryName) {
        out.push({
          transactionId: transaction.externalId,
          kind: 'category',
          currentValue: transaction.categoryName,
          suggestedValue: match,
          rationale: suggestion.rationale ?? null,
          confidence,
        });
      }
    }

    const note = suggestion.note?.trim();
    if (note && note !== transaction.notes) {
      out.push({
        transactionId: transaction.externalId,
        kind: 'note',
        currentValue: transaction.notes,
        suggestedValue: note,
        rationale: suggestion.rationale ?? null,
        confidence,
      });
    }
  }
  return out;
}

function normalizeConfidence(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'high' || normalized === 'medium' || normalized === 'low'
    ? normalized
    : null;
}
