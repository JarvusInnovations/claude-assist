/**
 * Finance persistence.
 *
 * `FinanceStore` is an interface so the runner, routes, and assist are testable
 * without Postgres (see memory-store.ts); `PgFinanceStore` is the production
 * implementation over the `finance` schema.
 */

import type postgres from 'postgres';
import type { SourceAccount, SourceTransaction } from './source/types.js';
import type {
  AccountRecord,
  ReviewRecord,
  ReviewStatus,
  ReviewSummary,
  SuggestionKind,
  SuggestionRecord,
  SuggestionStatus,
  TransactionRecord,
} from './types.js';

export interface NewSuggestion {
  transactionId: string;
  kind: SuggestionKind;
  currentValue: string | null;
  suggestedValue: string;
  rationale: string | null;
  confidence: string | null;
}

export interface ReviewPatch {
  status?: ReviewStatus;
  pageSlug?: string | null;
  pageUrl?: string | null;
  tanaNodeId?: string | null;
  notifiedAt?: Date | null;
  summary?: ReviewSummary;
  blockedReason?: string | null;
}

export interface FinanceStore {
  /** Upsert the pulled ledger slice. Returns how many rows were new. */
  upsertTransactions(rows: SourceTransaction[]): Promise<{ inserted: number; updated: number }>;
  upsertAccounts(rows: SourceAccount[]): Promise<number>;
  listTransactions(startDate: string, endDate: string): Promise<TransactionRecord[]>;
  listAccounts(): Promise<AccountRecord[]>;

  /** Get-or-create the review row for a period. */
  ensureReview(period: {
    key: string;
    startDate: string;
    endDate: string;
  }): Promise<ReviewRecord>;
  getReview(periodKey: string): Promise<ReviewRecord | null>;
  getReviewById(id: number): Promise<ReviewRecord | null>;
  listReviews(limit: number): Promise<ReviewRecord[]>;
  updateReview(id: number, patch: ReviewPatch): Promise<ReviewRecord | null>;

  /** Replace a review's proposals wholesale — re-running the assist re-proposes. */
  replaceSuggestions(reviewId: number, rows: NewSuggestion[]): Promise<number>;
  listSuggestions(reviewId: number): Promise<SuggestionRecord[]>;
  getSuggestion(id: number): Promise<SuggestionRecord | null>;
  /** Record a human's decision. Never touches the provider. */
  decideSuggestion(
    id: number,
    decision: 'accepted' | 'rejected',
    decidedBy: string,
  ): Promise<SuggestionRecord | null>;
  /** Record the outcome of an apply that already happened. */
  markSuggestionApplied(id: number, error?: string): Promise<SuggestionRecord | null>;

  readSession(): Promise<string | null>;
  writeSession(token: string): Promise<void>;
  clearSession(): Promise<void>;
}

export class PgFinanceStore implements FinanceStore {
  constructor(private sql: postgres.Sql) {}

  async upsertTransactions(
    rows: SourceTransaction[],
  ): Promise<{ inserted: number; updated: number }> {
    if (rows.length === 0) return { inserted: 0, updated: 0 };
    const results = await this.sql<{ inserted: boolean }[]>`
      INSERT INTO finance.transactions ${this.sql(
        rows.map((row) => ({
          external_id: row.id,
          posted_on: row.date,
          amount: row.amount,
          currency: row.currency ?? null,
          merchant: row.merchant ?? null,
          description: row.description ?? null,
          account_id: row.accountId ?? null,
          category_id: row.categoryId ?? null,
          category_name: row.categoryName ?? null,
          notes: row.notes ?? null,
          tags: row.tags ?? [],
          is_pending: row.pending ?? false,
          needs_review: row.needsReview ?? false,
          raw: this.sql.json((row.raw ?? {}) as never),
        })),
      )}
      ON CONFLICT (external_id) DO UPDATE SET
        posted_on     = EXCLUDED.posted_on,
        amount        = EXCLUDED.amount,
        currency      = EXCLUDED.currency,
        merchant      = EXCLUDED.merchant,
        description   = EXCLUDED.description,
        account_id    = EXCLUDED.account_id,
        category_id   = EXCLUDED.category_id,
        category_name = EXCLUDED.category_name,
        notes         = EXCLUDED.notes,
        tags          = EXCLUDED.tags,
        is_pending    = EXCLUDED.is_pending,
        needs_review  = EXCLUDED.needs_review,
        raw           = EXCLUDED.raw,
        synced_at     = NOW()
      RETURNING (xmax = 0) AS inserted
    `;
    const inserted = results.filter((r) => r.inserted).length;
    return { inserted, updated: results.length - inserted };
  }

  async upsertAccounts(rows: SourceAccount[]): Promise<number> {
    if (rows.length === 0) return 0;
    await this.sql`
      INSERT INTO finance.accounts ${this.sql(
        rows.map((row) => ({
          external_id: row.id,
          name: row.name,
          type: row.type ?? null,
          subtype: row.subtype ?? null,
          institution: row.institution ?? null,
          currency: row.currency ?? null,
          balance: row.balance ?? null,
          is_asset: row.isAsset ?? null,
          raw: this.sql.json((row.raw ?? {}) as never),
        })),
      )}
      ON CONFLICT (external_id) DO UPDATE SET
        name        = EXCLUDED.name,
        type        = EXCLUDED.type,
        subtype     = EXCLUDED.subtype,
        institution = EXCLUDED.institution,
        currency    = EXCLUDED.currency,
        balance     = EXCLUDED.balance,
        is_asset    = EXCLUDED.is_asset,
        raw         = EXCLUDED.raw,
        synced_at   = NOW()
    `;
    return rows.length;
  }

  async listTransactions(startDate: string, endDate: string): Promise<TransactionRecord[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM finance.transactions
      WHERE posted_on >= ${startDate}::date AND posted_on <= ${endDate}::date
      ORDER BY posted_on DESC, external_id
    `;
    return rows.map(mapTransactionRow);
  }

  async listAccounts(): Promise<AccountRecord[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM finance.accounts ORDER BY name
    `;
    return rows.map((row) => ({
      externalId: String(row.external_id),
      name: String(row.name),
      type: (row.type as string | null) ?? null,
      institution: (row.institution as string | null) ?? null,
      balance: row.balance === null ? null : Number(row.balance),
      isAsset: (row.is_asset as boolean | null) ?? null,
    }));
  }

  async ensureReview(period: {
    key: string;
    startDate: string;
    endDate: string;
  }): Promise<ReviewRecord> {
    const rows = await this.sql<Record<string, unknown>[]>`
      INSERT INTO finance.reviews (period_key, period_start, period_end)
      VALUES (${period.key}, ${period.startDate}::date, ${period.endDate}::date)
      ON CONFLICT (period_key) DO UPDATE SET updated_at = NOW()
      RETURNING *
    `;
    return mapReviewRow(rows[0]!);
  }

  async getReview(periodKey: string): Promise<ReviewRecord | null> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM finance.reviews WHERE period_key = ${periodKey}
    `;
    return rows[0] ? mapReviewRow(rows[0]) : null;
  }

  async getReviewById(id: number): Promise<ReviewRecord | null> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM finance.reviews WHERE id = ${id}
    `;
    return rows[0] ? mapReviewRow(rows[0]) : null;
  }

  async listReviews(limit: number): Promise<ReviewRecord[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM finance.reviews ORDER BY period_key DESC LIMIT ${limit}
    `;
    return rows.map(mapReviewRow);
  }

  async updateReview(id: number, patch: ReviewPatch): Promise<ReviewRecord | null> {
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.pageSlug !== undefined) set.page_slug = patch.pageSlug;
    if (patch.pageUrl !== undefined) set.page_url = patch.pageUrl;
    if (patch.tanaNodeId !== undefined) set.tana_node_id = patch.tanaNodeId;
    if (patch.notifiedAt !== undefined) set.notified_at = patch.notifiedAt;
    if (patch.blockedReason !== undefined) set.blocked_reason = patch.blockedReason;
    if (patch.summary !== undefined) set.summary = this.sql.json(patch.summary as never);

    const rows = await this.sql<Record<string, unknown>[]>`
      UPDATE finance.reviews SET ${this.sql(set)} WHERE id = ${id} RETURNING *
    `;
    return rows[0] ? mapReviewRow(rows[0]) : null;
  }

  async replaceSuggestions(reviewId: number, rows: NewSuggestion[]): Promise<number> {
    return this.sql.begin(async (rawTx) => {
      // postgres.js's TransactionSql type drops the tagged-template call
      // signature (a TS/Omit limitation) even though it's present at runtime —
      // the same cast kitchen's and pages' stores use for their transactions.
      const tx = rawTx as unknown as postgres.Sql;
      // Only undecided proposals are cleared: a decision a human already made
      // is not the assist's to discard on a re-run.
      await tx`
        DELETE FROM finance.suggestions
        WHERE review_id = ${reviewId} AND status = 'proposed'
      `;
      if (rows.length === 0) return 0;
      const inserted = await tx<{ id: number }[]>`
        INSERT INTO finance.suggestions ${tx(
          rows.map((row) => ({
            review_id: reviewId,
            transaction_id: row.transactionId,
            kind: row.kind,
            current_value: row.currentValue,
            suggested_value: row.suggestedValue,
            rationale: row.rationale,
            confidence: row.confidence,
          })),
        )}
        ON CONFLICT (review_id, transaction_id, kind) DO NOTHING
        RETURNING id
      `;
      return inserted.length;
    });
  }

  async listSuggestions(reviewId: number): Promise<SuggestionRecord[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM finance.suggestions WHERE review_id = ${reviewId} ORDER BY id
    `;
    return rows.map(mapSuggestionRow);
  }

  async getSuggestion(id: number): Promise<SuggestionRecord | null> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM finance.suggestions WHERE id = ${id}
    `;
    return rows[0] ? mapSuggestionRow(rows[0]) : null;
  }

  async decideSuggestion(
    id: number,
    decision: 'accepted' | 'rejected',
    decidedBy: string,
  ): Promise<SuggestionRecord | null> {
    const rows = await this.sql<Record<string, unknown>[]>`
      UPDATE finance.suggestions
      SET status = ${decision}, decided_at = NOW(), decided_by = ${decidedBy}
      WHERE id = ${id} AND status IN ('proposed', 'accepted', 'rejected')
      RETURNING *
    `;
    return rows[0] ? mapSuggestionRow(rows[0]) : null;
  }

  async markSuggestionApplied(id: number, error?: string): Promise<SuggestionRecord | null> {
    const rows = await this.sql<Record<string, unknown>[]>`
      UPDATE finance.suggestions
      SET status = ${error ? 'failed' : 'applied'},
          applied_at = ${error ? null : new Date()},
          apply_error = ${error ?? null}
      WHERE id = ${id}
      RETURNING *
    `;
    return rows[0] ? mapSuggestionRow(rows[0]) : null;
  }

  async readSession(): Promise<string | null> {
    const rows = await this.sql<{ token: string }[]>`
      UPDATE finance.provider_session SET last_used_at = NOW() WHERE id = 1 RETURNING token
    `;
    return rows[0]?.token ?? null;
  }

  async writeSession(token: string): Promise<void> {
    await this.sql`
      INSERT INTO finance.provider_session (id, token, obtained_at)
      VALUES (1, ${token}, NOW())
      ON CONFLICT (id) DO UPDATE SET token = EXCLUDED.token, obtained_at = NOW()
    `;
  }

  async clearSession(): Promise<void> {
    await this.sql`DELETE FROM finance.provider_session WHERE id = 1`;
  }
}

function mapTransactionRow(row: Record<string, unknown>): TransactionRecord {
  return {
    externalId: String(row.external_id),
    postedOn: isoDate(row.posted_on),
    amount: Number(row.amount),
    currency: (row.currency as string | null) ?? null,
    merchant: (row.merchant as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    accountId: (row.account_id as string | null) ?? null,
    categoryId: (row.category_id as string | null) ?? null,
    categoryName: (row.category_name as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    isPending: Boolean(row.is_pending),
    needsReview: Boolean(row.needs_review),
  };
}

function mapReviewRow(row: Record<string, unknown>): ReviewRecord {
  return {
    id: Number(row.id),
    periodKey: String(row.period_key),
    periodStart: isoDate(row.period_start),
    periodEnd: isoDate(row.period_end),
    status: row.status as ReviewStatus,
    pageSlug: (row.page_slug as string | null) ?? null,
    pageUrl: (row.page_url as string | null) ?? null,
    tanaNodeId: (row.tana_node_id as string | null) ?? null,
    notifiedAt: (row.notified_at as Date | null) ?? null,
    summary: (row.summary as ReviewSummary) ?? {},
    blockedReason: (row.blocked_reason as string | null) ?? null,
    attempts: Number(row.attempts ?? 0),
    lastError: (row.last_error as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function mapSuggestionRow(row: Record<string, unknown>): SuggestionRecord {
  return {
    id: Number(row.id),
    reviewId: Number(row.review_id),
    transactionId: String(row.transaction_id),
    kind: row.kind as SuggestionKind,
    currentValue: (row.current_value as string | null) ?? null,
    suggestedValue: String(row.suggested_value),
    rationale: (row.rationale as string | null) ?? null,
    confidence: (row.confidence as string | null) ?? null,
    status: row.status as SuggestionStatus,
    decidedAt: (row.decided_at as Date | null) ?? null,
    decidedBy: (row.decided_by as string | null) ?? null,
    appliedAt: (row.applied_at as Date | null) ?? null,
    applyError: (row.apply_error as string | null) ?? null,
  };
}

function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
