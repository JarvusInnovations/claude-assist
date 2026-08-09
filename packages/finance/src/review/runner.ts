/**
 * The monthly batch: pull → compose → assist → publish → link → ping → beat.
 *
 * Three shapes worth naming, because they are what make this safe to leave
 * running unattended:
 *
 * **Preflight-and-exit-clean.** The source is probed before anything is pulled.
 * An unreachable or unconfigured source produces one `blocked` review with a
 * reason, no notification, and no heartbeat — so the coverage monitor pages on
 * the *absence of a completed review*, which is exactly the fact worth knowing.
 * What it must never produce is a confident, empty review.
 *
 * **The heartbeat is earned.** `beat()` fires only on a run that rendered
 * something. A batch that failed, or that exited blocked, deliberately leaves
 * the heartbeat where it was, so a month of quiet failures pages once the
 * staleness threshold passes.
 *
 * **Every surface after the pull degrades independently.** No page, no Tana, or
 * no notifier each subtract one thing from the outcome; none of them sinks the
 * review or loses the pulled data, which is already in the mirror by then.
 */

import type { FastifyBaseLogger } from 'fastify';
import type {
  HeartbeatRegistry,
  NotifyDispatcher,
  NotifyInput,
  PagePublisher,
} from '@jarvus/claude-assist-core';
import type { FinanceSource, SourceCategory } from '../source/types.js';
import type { FinanceStore } from '../store.js';
import type { ReviewRecord, ReviewSummary } from '../types.js';
import type { Period } from '../period.js';
import { periodFromKey, priorPeriodKey, periodToReview, todayIsoInTz } from '../period.js';
import { composeReview, headline } from './compose.js';
import { renderReviewPage, reviewSlug, reviewTitle } from './render.js';
import { tanaNodeLink, type ReviewTanaWriter } from './tana.js';
import type { TransactionAssist } from './assist.js';

export const FINANCE_PIPELINE = 'finance-review';

export interface ReviewRunnerDeps {
  store: FinanceStore;
  source: FinanceSource;
  assist: TransactionAssist | null;
  tana: ReviewTanaWriter | null;
  pages: PagePublisher | undefined;
  notify: NotifyDispatcher | undefined;
  heartbeats: HeartbeatRegistry | undefined;
  log: FastifyBaseLogger;
  timeZone: string;
  currency: string;
  coverageThreshold: string;
}

export interface ReviewRunResult {
  period: string;
  status: ReviewRecord['status'];
  blockedReason?: string;
  transactionsPulled: number;
  suggestions: number;
  pageUrl: string | null;
  tanaNodeId: string | null;
  notified: boolean;
}

export class ReviewRunner {
  constructor(private deps: ReviewRunnerDeps) {}

  /** Run the batch for the most recently closed month. */
  async runScheduled(now: Date = new Date()): Promise<ReviewRunResult> {
    return this.run(periodToReview(this.deps.timeZone, now), now);
  }

  /** Run the batch for a named `YYYY-MM` period (the manual-trigger path). */
  async runPeriod(periodKey: string, now: Date = new Date()): Promise<ReviewRunResult> {
    return this.run(periodFromKey(periodKey), now);
  }

  private async run(period: Period, now: Date): Promise<ReviewRunResult> {
    const { store, source, log } = this.deps;
    const review = await store.ensureReview({
      key: period.key,
      startDate: period.startDate,
      endDate: period.endDate,
    });

    // ── preflight ─────────────────────────────────────────────────────────
    const preflight = await source.preflight();
    if (!preflight.ok) {
      const reason = `${preflight.reason ?? 'unavailable'}: ${preflight.detail ?? 'no detail'}`;
      log.warn({ period: period.key, preflight }, 'Finance review blocked — source unavailable');
      await store.updateReview(review.id, { status: 'blocked', blockedReason: reason });
      return {
        period: period.key,
        status: 'blocked',
        blockedReason: reason,
        transactionsPulled: 0,
        suggestions: 0,
        pageUrl: null,
        tanaNodeId: null,
        notified: false,
      };
    }

    await store.updateReview(review.id, { status: 'running', blockedReason: null });

    // ── pull ──────────────────────────────────────────────────────────────
    const warnings: string[] = [];
    const pulled = await source.listTransactions({
      startDate: period.startDate,
      endDate: period.endDate,
    });
    await store.upsertTransactions(pulled);

    // The prior month is pulled too, and only for the deltas. It is a small
    // extra request against a rate-limited API, so a failure here downgrades
    // to "no comparison" rather than failing the review.
    const priorKey = priorPeriodKey(period.key);
    const prior = periodFromKey(priorKey);
    try {
      await store.upsertTransactions(
        await source.listTransactions({ startDate: prior.startDate, endDate: prior.endDate }),
      );
    } catch (err) {
      log.warn({ err, period: priorKey }, 'Finance: prior-period pull failed — no month-over-month deltas');
      warnings.push('Month-over-month comparison unavailable: the prior period could not be pulled.');
    }

    try {
      await store.upsertAccounts(await source.listAccounts());
    } catch (err) {
      log.warn({ err }, 'Finance: account pull failed — balances omitted from the review');
      warnings.push('Account balances were unavailable at pull time.');
    }

    // ── compose ───────────────────────────────────────────────────────────
    const transactions = await store.listTransactions(period.startDate, period.endDate);
    const priorTransactions = await store.listTransactions(prior.startDate, prior.endDate);
    const summary = composeReview({
      period,
      transactions,
      priorTransactions,
      priorPeriodKey: priorKey,
      accounts: await store.listAccounts(),
      currency: this.deps.currency,
      warnings,
    });
    await this.deps.store.updateReview(review.id, { summary });

    // ── assist (proposals only; never a ledger edit) ───────────────────────
    let proposalCount = 0;
    if (this.deps.assist) {
      let categories: SourceCategory[] = [];
      try {
        categories = await source.listCategories();
      } catch (err) {
        log.warn({ err }, 'Finance: category list unavailable — the assist will not propose categories');
      }
      const proposals = await this.deps.assist.propose(summary, categories);
      proposalCount = await store.replaceSuggestions(review.id, proposals);
    }
    const suggestions = await store.listSuggestions(review.id);

    // ── publish ───────────────────────────────────────────────────────────
    let pageUrl: string | null = null;
    let pageSlug: string | null = null;
    if (this.deps.pages) {
      try {
        const published = await this.deps.pages.publish({
          slug: reviewSlug(period.key),
          title: reviewTitle(summary),
          html: renderReviewPage({ reviewId: review.id, summary, suggestions, generatedAt: now }),
        });
        pageUrl = published.url;
        pageSlug = published.slug;
      } catch (err) {
        log.error({ err, period: period.key }, 'Finance review page publish failed');
      }
    } else {
      log.warn('Finance: the pages module is not loaded — the review has no rendered surface');
    }

    // ── Tana link ─────────────────────────────────────────────────────────
    let tanaNodeId: string | null = null;
    if (this.deps.tana) {
      try {
        const result = await this.deps.tana.write(
          summary,
          pageUrl,
          todayIsoInTz(this.deps.timeZone, now),
        );
        tanaNodeId = result.dayNodeId;
      } catch (err) {
        log.error({ err, period: period.key }, 'Finance review Tana link failed');
      }
    }

    await store.updateReview(review.id, {
      status: 'rendered',
      pageSlug,
      pageUrl,
      tanaNodeId,
    });

    // ── ping ──────────────────────────────────────────────────────────────
    let notified = false;
    if (this.deps.notify) {
      try {
        const result = await this.deps.notify.notify(
          buildReviewNotification(summary, pageUrl, tanaNodeId),
        );
        notified = result.status !== 'error';
        if (notified) await store.updateReview(review.id, { notifiedAt: new Date() });
      } catch (err) {
        log.error({ err }, 'Finance review notification dispatch failed');
      }
    }

    // ── heartbeat — only a run that rendered something counts ──────────────
    await this.deps.heartbeats?.beat(FINANCE_PIPELINE, {
      threshold: this.deps.coverageThreshold,
      metadata: { period: period.key, transactions: transactions.length },
    });

    return {
      period: period.key,
      status: 'rendered',
      transactionsPulled: pulled.length,
      suggestions: proposalCount,
      pageUrl,
      tanaNodeId,
      notified,
    };
  }
}

/**
 * The "review ready" ping. `notice` and not `interrupt`: a closed month is
 * never the thing that has to be handled in the next five minutes, and a ping
 * that interrupts for something that can wait teaches its reader to ignore the
 * next one.
 */
export function buildReviewNotification(
  summary: ReviewSummary,
  pageUrl: string | null,
  tanaNodeId: string | null,
): NotifyInput {
  const url = pageUrl ?? tanaNodeLink(tanaNodeId);
  return {
    priority: 'notice',
    title: `Finance review ready · ${summary.periodLabel}`,
    body: headline(summary),
    ...(url ? { url, urlTitle: 'Open review' } : {}),
  };
}
