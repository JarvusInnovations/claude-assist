/**
 * The finance source contract.
 *
 * Two implementations satisfy it: a client for the provider's own unofficial
 * HTTP API, and an operator-supplied exporter command (the seam for a
 * headless-browser session on a machine that stays logged in). Everything
 * downstream — the pull, the review, the assist — depends only on this
 * interface, so which one is in play is a config decision and not a code path
 * that leaks into the domain.
 *
 * Note what is NOT here: no "sync everything", no delete, no bulk write. The
 * only mutation is `updateTransaction`, and the module calls it from exactly
 * one place — an explicit, human-initiated apply.
 */

/** A transaction as the source reports it, before any local interpretation. */
export interface SourceTransaction {
  id: string;
  /** ISO date (YYYY-MM-DD) the transaction posted. */
  date: string;
  /**
   * Signed amount in the account's currency, in the SOURCE's sign convention,
   * preserved verbatim. Normalizing it here would bake one provider's choice
   * into the schema; the renderer normalizes for display instead.
   */
  amount: number;
  currency?: string;
  merchant?: string;
  description?: string;
  accountId?: string;
  categoryId?: string;
  categoryName?: string;
  notes?: string;
  tags?: string[];
  pending?: boolean;
  needsReview?: boolean;
  /** Whatever else the source returned, kept for forensics. */
  raw?: Record<string, unknown>;
}

export interface SourceAccount {
  id: string;
  name: string;
  type?: string;
  subtype?: string;
  institution?: string;
  currency?: string;
  balance?: number;
  isAsset?: boolean;
  raw?: Record<string, unknown>;
}

export interface SourceCategory {
  id: string;
  name: string;
  group?: string;
}

export interface TransactionQuery {
  /** Inclusive ISO start date. */
  startDate: string;
  /** Inclusive ISO end date. */
  endDate: string;
  /** Hard cap on rows pulled for a period (default 2000). */
  limit?: number;
}

export interface TransactionUpdate {
  id: string;
  categoryId?: string;
  notes?: string;
}

/**
 * Why a source is not usable right now.
 *
 * `not_configured` and `unauthenticated` are operator problems: the batch
 * records them, exits clean, and does not burn an attempt. `unavailable` and
 * `schema_drift` are the provider's: worth a retry and worth an alert if they
 * persist, which is exactly what the heartbeat threshold does.
 */
export type SourceUnavailableReason =
  | 'not_configured'
  | 'unauthenticated'
  | 'unavailable'
  | 'schema_drift';

export class FinanceSourceError extends Error {
  readonly reason: SourceUnavailableReason;
  /** True when the operator must do something before a retry can help. */
  readonly needsOperator: boolean;

  constructor(
    message: string,
    opts: { reason: SourceUnavailableReason; needsOperator?: boolean; cause?: unknown },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'FinanceSourceError';
    this.reason = opts.reason;
    this.needsOperator =
      opts.needsOperator ??
      (opts.reason === 'not_configured' || opts.reason === 'unauthenticated');
  }
}

export interface PreflightResult {
  ok: boolean;
  /** Which implementation answered. */
  mode: 'api' | 'command';
  /** Present when `ok` is false. */
  reason?: SourceUnavailableReason;
  detail?: string;
}

export interface FinanceSource {
  readonly mode: 'api' | 'command';
  /**
   * Cheap reachability + auth check. The monthly batch calls this FIRST and
   * exits clean on a false, so a missing credential produces one honest
   * "blocked" review rather than a half-populated one.
   */
  preflight(): Promise<PreflightResult>;
  listTransactions(query: TransactionQuery): Promise<SourceTransaction[]>;
  listAccounts(): Promise<SourceAccount[]>;
  listCategories(): Promise<SourceCategory[]>;
  /**
   * The module's ONLY write to the provider. Called from the apply route, on a
   * suggestion a human accepted, and from nowhere else.
   */
  updateTransaction(update: TransactionUpdate): Promise<void>;
}
