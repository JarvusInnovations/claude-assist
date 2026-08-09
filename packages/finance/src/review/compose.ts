/**
 * Compose the monthly review — a pure function from a period's transactions to
 * the summary the page renders and the notification headlines.
 *
 * The design question this file answers is *what a monthly review is for*. It
 * is not a spending report; the provider already has one of those, prettier.
 * It is a reconciliation: what changed, what the automatic categorizer got
 * wrong or skipped, and what looks unlike the months before it. So the totals
 * are the cheap part, and the flagging rules below are the point.
 *
 * The flags are deliberately deterministic. A model's opinion arrives later, as
 * a suggestion attached to a flagged row, and never decides which rows appear.
 * A review whose contents depend on a model's mood is not a reconciliation.
 */

import type {
  AccountRecord,
  CategoryTotal,
  FlaggedTransaction,
  MerchantTotal,
  ReviewSummary,
  TransactionRecord,
} from '../types.js';
import type { Period } from '../period.js';

export interface ComposeInput {
  period: Period;
  transactions: TransactionRecord[];
  /** The month before, for deltas. Empty when there is no history yet. */
  priorTransactions?: TransactionRecord[];
  priorPeriodKey?: string | null;
  accounts?: AccountRecord[];
  currency?: string;
  warnings?: string[];
  /** Outflow above this, in a single transaction, is worth a look. Default 250. */
  largeTransactionThreshold?: number;
  /** How many merchants the summary lists. Default 8. */
  topMerchantCount?: number;
}

const UNCATEGORIZED = 'Uncategorized';

/** Outflow as a positive number; inflow as 0. Sign convention is provider-side. */
function outflow(t: TransactionRecord): number {
  return t.amount < 0 ? -t.amount : 0;
}

function inflow(t: TransactionRecord): number {
  return t.amount > 0 ? t.amount : 0;
}

function categoryOf(t: TransactionRecord): string {
  const name = t.categoryName?.trim();
  return name && name.length > 0 ? name : UNCATEGORIZED;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function composeReview(input: ComposeInput): ReviewSummary {
  const { period } = input;
  const transactions = input.transactions;
  const threshold = input.largeTransactionThreshold ?? 250;
  const topCount = input.topMerchantCount ?? 8;

  const totalOutflow = round2(transactions.reduce((sum, t) => sum + outflow(t), 0));
  const totalInflow = round2(transactions.reduce((sum, t) => sum + inflow(t), 0));

  const priorByCategory = totalsByCategory(input.priorTransactions ?? []);
  const categories: CategoryTotal[] = [...totalsByCategory(transactions).entries()]
    .map(([category, agg]) => ({
      category,
      outflow: round2(agg.outflow),
      inflow: round2(agg.inflow),
      count: agg.count,
      priorOutflow: priorByCategory.has(category)
        ? round2(priorByCategory.get(category)!.outflow)
        : null,
    }))
    .sort((a, b) => b.outflow - a.outflow);

  const merchantTotals = new Map<string, { outflow: number; count: number }>();
  for (const t of transactions) {
    const out = outflow(t);
    if (out === 0) continue;
    const key = t.merchant?.trim() || t.description?.trim() || 'Unknown';
    const agg = merchantTotals.get(key) ?? { outflow: 0, count: 0 };
    agg.outflow += out;
    agg.count += 1;
    merchantTotals.set(key, agg);
  }
  const topMerchants: MerchantTotal[] = [...merchantTotals.entries()]
    .map(([merchant, agg]) => ({ merchant, outflow: round2(agg.outflow), count: agg.count }))
    .sort((a, b) => b.outflow - a.outflow)
    .slice(0, topCount);

  const uncategorized = transactions
    .filter((t) => categoryOf(t) === UNCATEGORIZED)
    .map((t) => ({ transaction: t, reasons: ['no category'] }));

  const flagged = flagTransactions(transactions, {
    threshold,
    priorMerchants: new Set(
      (input.priorTransactions ?? []).map((t) => (t.merchant ?? '').toLowerCase()).filter(Boolean),
    ),
  });

  return {
    periodKey: period.key,
    periodLabel: period.label,
    periodStart: period.startDate,
    periodEnd: period.endDate,
    currency: input.currency ?? 'USD',
    transactionCount: transactions.length,
    totalOutflow,
    totalInflow,
    net: round2(totalInflow - totalOutflow),
    priorPeriodKey: input.priorPeriodKey ?? null,
    priorTotalOutflow:
      input.priorTransactions && input.priorTransactions.length > 0
        ? round2(input.priorTransactions.reduce((sum, t) => sum + outflow(t), 0))
        : null,
    categories,
    topMerchants,
    uncategorized,
    flagged,
    accounts: input.accounts ?? [],
    warnings: input.warnings ?? [],
  };
}

function totalsByCategory(
  transactions: TransactionRecord[],
): Map<string, { outflow: number; inflow: number; count: number }> {
  const totals = new Map<string, { outflow: number; inflow: number; count: number }>();
  for (const t of transactions) {
    const key = categoryOf(t);
    const agg = totals.get(key) ?? { outflow: 0, inflow: 0, count: 0 };
    agg.outflow += outflow(t);
    agg.inflow += inflow(t);
    agg.count += 1;
    totals.set(key, agg);
  }
  return totals;
}

/**
 * The four things worth a human's attention in a closed month, in the order a
 * human would want them:
 *
 * - the provider itself asked for review (its own uncertainty, respected);
 * - large outflows, which are where a mistake is expensive;
 * - a merchant that never appeared before, which is where a subscription or a
 *   fraudulent charge first shows up;
 * - a still-pending row after month end, which usually means the mirror is
 *   stale rather than the charge is.
 *
 * Uncategorized rows are surfaced separately (they are their own section), so
 * they are not duplicated here unless another reason also applies.
 */
export function flagTransactions(
  transactions: TransactionRecord[],
  opts: { threshold: number; priorMerchants: Set<string> },
): FlaggedTransaction[] {
  const flagged: FlaggedTransaction[] = [];
  const haveHistory = opts.priorMerchants.size > 0;

  for (const t of transactions) {
    const reasons: string[] = [];
    if (t.needsReview) reasons.push('flagged for review by the source');
    if (outflow(t) >= opts.threshold) reasons.push(`large outflow (≥ ${opts.threshold})`);
    const merchant = (t.merchant ?? '').toLowerCase();
    // Only claim "first time" when there IS a prior month to have seen it in.
    if (haveHistory && merchant && !opts.priorMerchants.has(merchant) && outflow(t) > 0) {
      reasons.push('first charge from this merchant');
    }
    if (t.isPending) reasons.push('still pending after the period closed');
    if (reasons.length > 0) flagged.push({ transaction: t, reasons });
  }

  return flagged.sort((a, b) => outflow(b.transaction) - outflow(a.transaction));
}

/** One-line headline for the notification: the shape of the month, in words. */
export function headline(summary: ReviewSummary): string {
  const bits = [`${summary.transactionCount} transactions`];
  if (summary.priorTotalOutflow !== null && summary.priorTotalOutflow > 0) {
    const delta = ((summary.totalOutflow - summary.priorTotalOutflow) / summary.priorTotalOutflow) * 100;
    const direction = delta >= 0 ? 'up' : 'down';
    bits.push(`spend ${direction} ${Math.abs(Math.round(delta))}% vs ${summary.priorPeriodKey}`);
  }
  const needing = summary.uncategorized.length + summary.flagged.length;
  bits.push(`${needing} needing a look`);
  return bits.join(', ');
}
