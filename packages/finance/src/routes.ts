/**
 * Finance HTTP surface, under `/api/finance`.
 *
 * Read routes for the reviews and their proposals, a decide route the rendered
 * page posts to, a manual run trigger, and the apply route. The apply route is
 * the only one that can reach the provider's ledger, and it exists as its own
 * verb precisely so that reaching it is a choice someone made.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { SuggestionApplier } from './apply.js';
import type { FinanceStore } from './store.js';
import type { FinanceSource } from './source/types.js';
import type { ReviewRunner } from './review/runner.js';

export interface FinanceRoutesConfig {
  store: FinanceStore;
  source: FinanceSource;
  runner: ReviewRunner;
  applier: SuggestionApplier;
}

const PERIOD_KEY = /^\d{4}-\d{2}$/;

export const registerFinanceRoutes: FastifyPluginAsync<FinanceRoutesConfig> = async (
  fastify: FastifyInstance,
  config: FinanceRoutesConfig,
) => {
  const { store, source, runner, applier } = config;

  /** Is the configured source reachable right now? The runbook's first question. */
  fastify.get('/finance/source', async () => {
    const preflight = await source.preflight();
    return { source: preflight };
  });

  fastify.get<{ Querystring: { limit?: number } }>('/finance/reviews', async (request) => {
    const limit = Math.min(Math.max(request.query.limit ?? 12, 1), 60);
    return { reviews: await store.listReviews(limit) };
  });

  fastify.get<{ Params: { period: string } }>(
    '/finance/reviews/:period',
    async (request, reply) => {
      const { period } = request.params;
      const review = PERIOD_KEY.test(period)
        ? await store.getReview(period)
        : await store.getReviewById(Number(period));
      if (!review) {
        reply.status(404);
        return { error: 'No review for that period' };
      }
      return { review, suggestions: await store.listSuggestions(review.id) };
    },
  );

  /**
   * Run the monthly batch now. `period` defaults to the most recently closed
   * month. Runs the same code path the scheduler does — including the same
   * advisory lock, since the scheduler's `trigger()` is what the operator
   * should normally use; this route exists for a period other than the current
   * one.
   */
  fastify.post<{ Body?: { period?: string } }>('/finance/reviews/run', async (request, reply) => {
    const period = request.body?.period;
    if (period !== undefined && !PERIOD_KEY.test(period)) {
      reply.status(400);
      return { error: 'period must be YYYY-MM' };
    }
    const result = period ? await runner.runPeriod(period) : await runner.runScheduled();
    return { result };
  });

  /**
   * Record a human's decision on a proposal. Deciding is NOT applying: this
   * route never touches the provider, which is what lets the rendered page
   * offer one-tap Accept without that tap being a ledger edit.
   */
  fastify.post<{
    Params: { id: string; suggestionId: string };
    Body: { decision?: string; by?: string };
  }>('/finance/reviews/:id/suggestions/:suggestionId/decide', async (request, reply) => {
    const decision = request.body?.decision;
    if (decision !== 'accepted' && decision !== 'rejected') {
      reply.status(400);
      return { error: 'decision must be "accepted" or "rejected"' };
    }
    const suggestionId = Number(request.params.suggestionId);
    const existing = await store.getSuggestion(suggestionId);
    if (!existing || existing.reviewId !== Number(request.params.id)) {
      reply.status(404);
      return { error: 'No such suggestion on that review' };
    }
    if (existing.status === 'applied') {
      // Already written to the ledger — a decision now would be a lie about
      // what happened. 409 rather than a silent no-op.
      reply.status(409);
      return { error: 'That suggestion was already applied' };
    }
    const suggestion = await store.decideSuggestion(suggestionId, decision, request.body?.by ?? 'owner');
    if (!suggestion) {
      reply.status(409);
      return { error: 'That suggestion could not be decided' };
    }
    return { suggestion };
  });

  /**
   * Apply the accepted proposals of a review to the provider's ledger.
   *
   * The only route in this module that writes to an external system of record.
   * It applies nothing that a human did not explicitly accept, and it reports
   * every row it skipped and why.
   */
  fastify.post<{ Params: { id: string }; Body?: { suggestionIds?: number[] } }>(
    '/finance/reviews/:id/apply',
    async (request, reply) => {
      const reviewId = Number(request.params.id);
      const review = await store.getReviewById(reviewId);
      if (!review) {
        reply.status(404);
        return { error: 'No such review' };
      }
      const preflight = await source.preflight();
      if (!preflight.ok) {
        reply.status(503);
        return { error: `Source unavailable (${preflight.reason}): ${preflight.detail ?? ''}`.trim() };
      }
      const ids = request.body?.suggestionIds;
      if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(id)))) {
        reply.status(400);
        return { error: 'suggestionIds must be an array of integers' };
      }
      return { result: await applier.applyReview(reviewId, ids) };
    },
  );
};
