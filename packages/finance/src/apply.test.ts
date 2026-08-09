import { describe, expect, test } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import { SuggestionApplier } from './apply.js';
import { MemoryFinanceStore } from './memory-store.js';
import type { FinanceSource, TransactionUpdate } from './source/types.js';

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

class StubSource implements FinanceSource {
  readonly mode = 'api' as const;
  updates: TransactionUpdate[] = [];
  failIds = new Set<string>();

  async preflight() {
    return { ok: true, mode: this.mode } as const;
  }
  async listTransactions() {
    return [];
  }
  async listAccounts() {
    return [];
  }
  async listCategories() {
    return [
      { id: 'c-dining', name: 'Dining' },
      { id: 'c-coffee', name: 'Coffee' },
    ];
  }
  async updateTransaction(update: TransactionUpdate) {
    if (this.failIds.has(update.id)) throw new Error('provider said no');
    this.updates.push(update);
  }
}

async function seed(kinds: Array<{ kind: 'category' | 'note'; value: string; txn: string }>) {
  const store = new MemoryFinanceStore();
  const review = await store.ensureReview({ key: '2026-03', startDate: '2026-03-01', endDate: '2026-03-31' });
  await store.replaceSuggestions(
    review.id,
    kinds.map((k) => ({
      transactionId: k.txn,
      kind: k.kind,
      currentValue: null,
      suggestedValue: k.value,
      rationale: null,
      confidence: null,
    })),
  );
  return { store, reviewId: review.id };
}

describe('SuggestionApplier', () => {
  /**
   * The invariant the whole module is built around: a proposal nobody accepted
   * never reaches the ledger, no matter how confident it was.
   */
  test('skips proposals that were never accepted', async () => {
    const { store, reviewId } = await seed([{ kind: 'category', value: 'Dining', txn: 't1' }]);
    const source = new StubSource();

    const result = await new SuggestionApplier(store, source, log).applyReview(reviewId);

    expect(source.updates).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(result.applied).toBe(0);
    expect(result.outcomes[0]?.detail).toContain('not accepted');
  });

  test('applies an accepted category by resolving its id', async () => {
    const { store, reviewId } = await seed([{ kind: 'category', value: 'Coffee', txn: 't1' }]);
    const source = new StubSource();
    const suggestion = (await store.listSuggestions(reviewId))[0]!;
    await store.decideSuggestion(suggestion.id, 'accepted', 'owner');

    const result = await new SuggestionApplier(store, source, log).applyReview(reviewId);

    expect(source.updates).toEqual([{ id: 't1', categoryId: 'c-coffee' }]);
    expect(result.applied).toBe(1);
    expect((await store.getSuggestion(suggestion.id))?.status).toBe('applied');
  });

  test('applies an accepted note as notes', async () => {
    const { store, reviewId } = await seed([{ kind: 'note', value: 'annual renewal', txn: 't2' }]);
    const source = new StubSource();
    const suggestion = (await store.listSuggestions(reviewId))[0]!;
    await store.decideSuggestion(suggestion.id, 'accepted', 'owner');

    await new SuggestionApplier(store, source, log).applyReview(reviewId);

    expect(source.updates).toEqual([{ id: 't2', notes: 'annual renewal' }]);
  });

  test('fails a category whose name no longer exists rather than guessing', async () => {
    const { store, reviewId } = await seed([{ kind: 'category', value: 'Retired Category', txn: 't1' }]);
    const source = new StubSource();
    const suggestion = (await store.listSuggestions(reviewId))[0]!;
    await store.decideSuggestion(suggestion.id, 'accepted', 'owner');

    const result = await new SuggestionApplier(store, source, log).applyReview(reviewId);

    expect(source.updates).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect((await store.getSuggestion(suggestion.id))?.applyError).toContain('Retired Category');
  });

  test('a failure on one row does not stop or roll back the others', async () => {
    const { store, reviewId } = await seed([
      { kind: 'note', value: 'first', txn: 'good' },
      { kind: 'note', value: 'second', txn: 'bad' },
      { kind: 'note', value: 'third', txn: 'alsogood' },
    ]);
    const source = new StubSource();
    source.failIds.add('bad');
    for (const s of await store.listSuggestions(reviewId)) {
      await store.decideSuggestion(s.id, 'accepted', 'owner');
    }

    const result = await new SuggestionApplier(store, source, log).applyReview(reviewId);

    expect(result.applied).toBe(2);
    expect(result.failed).toBe(1);
    expect(source.updates.map((u) => u.id)).toEqual(['good', 'alsogood']);
  });

  test('narrows to the ids the caller named', async () => {
    const { store, reviewId } = await seed([
      { kind: 'note', value: 'first', txn: 't1' },
      { kind: 'note', value: 'second', txn: 't2' },
    ]);
    const source = new StubSource();
    const suggestions = await store.listSuggestions(reviewId);
    for (const s of suggestions) await store.decideSuggestion(s.id, 'accepted', 'owner');

    const result = await new SuggestionApplier(store, source, log).applyReview(reviewId, [
      suggestions[1]!.id,
    ]);

    expect(source.updates.map((u) => u.id)).toEqual(['t2']);
    expect(result.applied).toBe(1);
  });

  test('re-running an apply does not re-write an already-applied row', async () => {
    const { store, reviewId } = await seed([{ kind: 'note', value: 'first', txn: 't1' }]);
    const source = new StubSource();
    const suggestion = (await store.listSuggestions(reviewId))[0]!;
    await store.decideSuggestion(suggestion.id, 'accepted', 'owner');

    const applier = new SuggestionApplier(store, source, log);
    await applier.applyReview(reviewId);
    const second = await applier.applyReview(reviewId);

    expect(source.updates).toHaveLength(1);
    expect(second.skipped).toBe(1);
  });
});

describe('MemoryFinanceStore decisions', () => {
  test('a re-run of the assist does not discard a decision a human already made', async () => {
    const { store, reviewId } = await seed([{ kind: 'note', value: 'first', txn: 't1' }]);
    const suggestion = (await store.listSuggestions(reviewId))[0]!;
    await store.decideSuggestion(suggestion.id, 'accepted', 'owner');

    await store.replaceSuggestions(reviewId, [
      { transactionId: 't9', kind: 'note', currentValue: null, suggestedValue: 'new', rationale: null, confidence: null },
    ]);

    const after = await store.listSuggestions(reviewId);
    expect(after.map((s) => s.transactionId).sort()).toEqual(['t1', 't9']);
    expect(after.find((s) => s.transactionId === 't1')?.status).toBe('accepted');
  });
});
