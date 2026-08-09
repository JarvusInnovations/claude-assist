/**
 * Finance module domain types.
 *
 * PERSONAL DOMAIN. These records describe the instance owner's private
 * finances. The module has no write path to any shared or team system of
 * record, and none of these types is ever serialized into one.
 */

export type ReviewStatus = 'pending' | 'running' | 'rendered' | 'failed' | 'blocked';

export interface TransactionRecord {
  externalId: string;
  postedOn: string;
  amount: number;
  currency: string | null;
  merchant: string | null;
  description: string | null;
  accountId: string | null;
  categoryId: string | null;
  categoryName: string | null;
  notes: string | null;
  tags: string[];
  isPending: boolean;
  needsReview: boolean;
}

export interface AccountRecord {
  externalId: string;
  name: string;
  type: string | null;
  institution: string | null;
  balance: number | null;
  isAsset: boolean | null;
}

export interface ReviewRecord {
  id: number;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  status: ReviewStatus;
  pageSlug: string | null;
  pageUrl: string | null;
  tanaNodeId: string | null;
  notifiedAt: Date | null;
  summary: ReviewSummary | Record<string, never>;
  blockedReason: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What the assist proposes. A proposal, never an edit. */
export type SuggestionKind = 'category' | 'note';

export type SuggestionStatus = 'proposed' | 'accepted' | 'rejected' | 'applied' | 'failed';

export interface SuggestionRecord {
  id: number;
  reviewId: number;
  transactionId: string;
  kind: SuggestionKind;
  currentValue: string | null;
  suggestedValue: string;
  rationale: string | null;
  confidence: string | null;
  status: SuggestionStatus;
  decidedAt: Date | null;
  decidedBy: string | null;
  appliedAt: Date | null;
  applyError: string | null;
}

// ── the composed review ───────────────────────────────────────────────────

export interface CategoryTotal {
  category: string;
  outflow: number;
  inflow: number;
  count: number;
  /** Same category in the prior period, when there was one. */
  priorOutflow: number | null;
}

export interface MerchantTotal {
  merchant: string;
  outflow: number;
  count: number;
}

/**
 * A transaction the review wants a human to look at, with the reason it was
 * surfaced. The reason is part of the record because "here are 40 rows" is not
 * a review; "here are 6 rows and why each one is here" is.
 */
export interface FlaggedTransaction {
  transaction: TransactionRecord;
  reasons: string[];
}

export interface ReviewSummary {
  periodKey: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  transactionCount: number;
  /** Money out, as a positive number. */
  totalOutflow: number;
  /** Money in, as a positive number. */
  totalInflow: number;
  net: number;
  priorPeriodKey: string | null;
  priorTotalOutflow: number | null;
  categories: CategoryTotal[];
  topMerchants: MerchantTotal[];
  uncategorized: FlaggedTransaction[];
  flagged: FlaggedTransaction[];
  /** Balances as of the pull, for context. Empty when the source gave none. */
  accounts: AccountRecord[];
  /** Populated when the pull was partial or the source was degraded. */
  warnings: string[];
}
