/**
 * Applying accepted proposals — the module's only write to the provider.
 *
 * Everything about this file is a refusal to be autonomous:
 *
 * - It runs **only** from an explicit HTTP call. No scheduler registers it, and
 *   the monthly runner does not import it.
 * - It applies **only** suggestions in `accepted` state. A proposal the assist
 *   made and nobody looked at is skipped, reported as skipped, and left alone.
 * - It is **not** a bulk categorizer. Each write is a single transaction update
 *   traceable to a single accepted row, and a failure on one does not roll the
 *   others back or stop the rest — a partial apply that says what it did is more
 *   useful than an all-or-nothing that says nothing.
 *
 * The reason for the shape is in the plan it implements: assist, not autonomous
 * ledger edits. The ledger is the owner's record of their own money; an agent
 * gets to have opinions about it and does not get to change it.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { FinanceSource, SourceCategory } from './source/types.js';
import type { FinanceStore } from './store.js';
import type { SuggestionRecord } from './types.js';

export interface ApplyOutcome {
  suggestionId: number;
  transactionId: string;
  kind: SuggestionRecord['kind'];
  status: 'applied' | 'failed' | 'skipped';
  detail?: string;
}

export interface ApplyResult {
  reviewId: number;
  applied: number;
  failed: number;
  skipped: number;
  outcomes: ApplyOutcome[];
}

export class SuggestionApplier {
  constructor(
    private store: FinanceStore,
    private source: FinanceSource,
    private log: FastifyBaseLogger,
  ) {}

  /**
   * Apply the accepted proposals of one review.
   *
   * `only` narrows to specific suggestion ids — the path a human takes when
   * they want three of the eight they accepted. Omitted means "everything
   * accepted", which is still a human-initiated act, just a broader one.
   */
  async applyReview(reviewId: number, only?: number[]): Promise<ApplyResult> {
    const wanted = only ? new Set(only) : null;
    const suggestions = (await this.store.listSuggestions(reviewId)).filter(
      (s) => !wanted || wanted.has(s.id),
    );

    // Categories are applied by id, and the model proposed a name. Resolve the
    // names once, up front: an unresolvable name is a skip, not a write of
    // whatever happened to sort first.
    let categoriesByName = new Map<string, string>();
    if (suggestions.some((s) => s.status === 'accepted' && s.kind === 'category')) {
      try {
        const categories: SourceCategory[] = await this.source.listCategories();
        categoriesByName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
      } catch (err) {
        this.log.error({ err, reviewId }, 'Finance apply: category list unavailable');
      }
    }

    const outcomes: ApplyOutcome[] = [];
    for (const suggestion of suggestions) {
      if (suggestion.status !== 'accepted') {
        outcomes.push({
          suggestionId: suggestion.id,
          transactionId: suggestion.transactionId,
          kind: suggestion.kind,
          status: 'skipped',
          detail: `not accepted (${suggestion.status})`,
        });
        continue;
      }

      if (suggestion.kind === 'category') {
        const categoryId = categoriesByName.get(suggestion.suggestedValue.toLowerCase());
        if (!categoryId) {
          const detail = `no category named "${suggestion.suggestedValue}" exists`;
          await this.store.markSuggestionApplied(suggestion.id, detail);
          outcomes.push({
            suggestionId: suggestion.id,
            transactionId: suggestion.transactionId,
            kind: suggestion.kind,
            status: 'failed',
            detail,
          });
          continue;
        }
        outcomes.push(
          await this.write(suggestion, { id: suggestion.transactionId, categoryId }),
        );
        continue;
      }

      outcomes.push(
        await this.write(suggestion, {
          id: suggestion.transactionId,
          notes: suggestion.suggestedValue,
        }),
      );
    }

    return {
      reviewId,
      applied: outcomes.filter((o) => o.status === 'applied').length,
      failed: outcomes.filter((o) => o.status === 'failed').length,
      skipped: outcomes.filter((o) => o.status === 'skipped').length,
      outcomes,
    };
  }

  private async write(
    suggestion: SuggestionRecord,
    update: { id: string; categoryId?: string; notes?: string },
  ): Promise<ApplyOutcome> {
    try {
      await this.source.updateTransaction(update);
      await this.store.markSuggestionApplied(suggestion.id);
      return {
        suggestionId: suggestion.id,
        transactionId: suggestion.transactionId,
        kind: suggestion.kind,
        status: 'applied',
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await this.store.markSuggestionApplied(suggestion.id, detail);
      this.log.error({ err, suggestionId: suggestion.id }, 'Finance apply failed for one suggestion');
      return {
        suggestionId: suggestion.id,
        transactionId: suggestion.transactionId,
        kind: suggestion.kind,
        status: 'failed',
        detail,
      };
    }
  }
}
