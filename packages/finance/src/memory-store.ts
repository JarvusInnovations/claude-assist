/**
 * In-memory FinanceStore — the seam that lets the runner, the assist, and the
 * apply path be tested without Postgres (specs/architecture.md § Testing).
 */

import type { SourceAccount, SourceTransaction } from './source/types.js';
import type { FinanceStore, NewSuggestion, ReviewPatch } from './store.js';
import type {
  AccountRecord,
  ReviewRecord,
  ReviewSummary,
  SuggestionRecord,
  TransactionRecord,
} from './types.js';

export class MemoryFinanceStore implements FinanceStore {
  transactions = new Map<string, TransactionRecord>();
  accounts = new Map<string, AccountRecord>();
  reviews: ReviewRecord[] = [];
  suggestions: SuggestionRecord[] = [];
  session: string | null = null;

  private nextReviewId = 1;
  private nextSuggestionId = 1;

  async upsertTransactions(rows: SourceTransaction[]): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      if (this.transactions.has(row.id)) updated += 1;
      else inserted += 1;
      this.transactions.set(row.id, {
        externalId: row.id,
        postedOn: row.date,
        amount: row.amount,
        currency: row.currency ?? null,
        merchant: row.merchant ?? null,
        description: row.description ?? null,
        accountId: row.accountId ?? null,
        categoryId: row.categoryId ?? null,
        categoryName: row.categoryName ?? null,
        notes: row.notes ?? null,
        tags: row.tags ?? [],
        isPending: row.pending ?? false,
        needsReview: row.needsReview ?? false,
      });
    }
    return { inserted, updated };
  }

  async upsertAccounts(rows: SourceAccount[]): Promise<number> {
    for (const row of rows) {
      this.accounts.set(row.id, {
        externalId: row.id,
        name: row.name,
        type: row.type ?? null,
        institution: row.institution ?? null,
        balance: row.balance ?? null,
        isAsset: row.isAsset ?? null,
      });
    }
    return rows.length;
  }

  async listTransactions(startDate: string, endDate: string): Promise<TransactionRecord[]> {
    return [...this.transactions.values()]
      .filter((t) => t.postedOn >= startDate && t.postedOn <= endDate)
      .sort((a, b) => (a.postedOn < b.postedOn ? 1 : a.postedOn > b.postedOn ? -1 : 0));
  }

  async listAccounts(): Promise<AccountRecord[]> {
    return [...this.accounts.values()];
  }

  async ensureReview(period: { key: string; startDate: string; endDate: string }): Promise<ReviewRecord> {
    const existing = this.reviews.find((r) => r.periodKey === period.key);
    if (existing) return existing;
    const record: ReviewRecord = {
      id: this.nextReviewId++,
      periodKey: period.key,
      periodStart: period.startDate,
      periodEnd: period.endDate,
      status: 'pending',
      pageSlug: null,
      pageUrl: null,
      tanaNodeId: null,
      notifiedAt: null,
      summary: {},
      blockedReason: null,
      attempts: 0,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.reviews.push(record);
    return record;
  }

  async getReview(periodKey: string): Promise<ReviewRecord | null> {
    return this.reviews.find((r) => r.periodKey === periodKey) ?? null;
  }

  async getReviewById(id: number): Promise<ReviewRecord | null> {
    return this.reviews.find((r) => r.id === id) ?? null;
  }

  async listReviews(limit: number): Promise<ReviewRecord[]> {
    return [...this.reviews].sort((a, b) => (a.periodKey < b.periodKey ? 1 : -1)).slice(0, limit);
  }

  async updateReview(id: number, patch: ReviewPatch): Promise<ReviewRecord | null> {
    const record = this.reviews.find((r) => r.id === id);
    if (!record) return null;
    if (patch.status !== undefined) record.status = patch.status;
    if (patch.pageSlug !== undefined) record.pageSlug = patch.pageSlug;
    if (patch.pageUrl !== undefined) record.pageUrl = patch.pageUrl;
    if (patch.tanaNodeId !== undefined) record.tanaNodeId = patch.tanaNodeId;
    if (patch.notifiedAt !== undefined) record.notifiedAt = patch.notifiedAt;
    if (patch.blockedReason !== undefined) record.blockedReason = patch.blockedReason;
    if (patch.summary !== undefined) record.summary = patch.summary as ReviewSummary;
    record.updatedAt = new Date();
    return record;
  }

  async replaceSuggestions(reviewId: number, rows: NewSuggestion[]): Promise<number> {
    this.suggestions = this.suggestions.filter(
      (s) => !(s.reviewId === reviewId && s.status === 'proposed'),
    );
    let added = 0;
    for (const row of rows) {
      const clash = this.suggestions.some(
        (s) => s.reviewId === reviewId && s.transactionId === row.transactionId && s.kind === row.kind,
      );
      if (clash) continue;
      this.suggestions.push({
        id: this.nextSuggestionId++,
        reviewId,
        transactionId: row.transactionId,
        kind: row.kind,
        currentValue: row.currentValue,
        suggestedValue: row.suggestedValue,
        rationale: row.rationale,
        confidence: row.confidence,
        status: 'proposed',
        decidedAt: null,
        decidedBy: null,
        appliedAt: null,
        applyError: null,
      });
      added += 1;
    }
    return added;
  }

  async listSuggestions(reviewId: number): Promise<SuggestionRecord[]> {
    return this.suggestions.filter((s) => s.reviewId === reviewId);
  }

  async getSuggestion(id: number): Promise<SuggestionRecord | null> {
    return this.suggestions.find((s) => s.id === id) ?? null;
  }

  async decideSuggestion(
    id: number,
    decision: 'accepted' | 'rejected',
    decidedBy: string,
  ): Promise<SuggestionRecord | null> {
    const record = this.suggestions.find((s) => s.id === id);
    if (!record || record.status === 'applied') return null;
    record.status = decision;
    record.decidedAt = new Date();
    record.decidedBy = decidedBy;
    return record;
  }

  async markSuggestionApplied(id: number, error?: string): Promise<SuggestionRecord | null> {
    const record = this.suggestions.find((s) => s.id === id);
    if (!record) return null;
    record.status = error ? 'failed' : 'applied';
    record.appliedAt = error ? null : new Date();
    record.applyError = error ?? null;
    return record;
  }

  async readSession(): Promise<string | null> {
    return this.session;
  }

  async writeSession(token: string): Promise<void> {
    this.session = token;
  }

  async clearSession(): Promise<void> {
    this.session = null;
  }
}
