import { describe, expect, test } from 'bun:test';
import { parseSuggestions, selectCandidates, toSuggestions, TransactionAssist } from './assist.js';
import { composeReview } from './compose.js';
import { periodFromKey } from '../period.js';
import type { TransactionRecord } from '../types.js';
import { ModelInvocationError, type ModelInvoker } from '@jarvus/claude-assist-core';

import type { FastifyBaseLogger } from 'fastify';

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

function txn(over: Partial<TransactionRecord> & { externalId: string }): TransactionRecord {
  return {
    postedOn: '2026-03-10',
    amount: -25,
    currency: 'USD',
    merchant: 'Coffee Bar',
    description: null,
    accountId: 'acct-1',
    categoryId: null,
    categoryName: null,
    notes: null,
    tags: [],
    isPending: false,
    needsReview: false,
    ...over,
  };
}

describe('parseSuggestions', () => {
  test('accepts a well-formed array', () => {
    const parsed = parseSuggestions('[{"id":"t1","category":"Coffee","confidence":"high"}]');
    expect(parsed).toEqual([{ id: 't1', category: 'Coffee', confidence: 'high' }]);
  });

  test('rejects shapes the invoker should ask the model to correct', () => {
    expect(() => parseSuggestions('{"id":"t1"}')).toThrow(/array/);
    expect(() => parseSuggestions('[{"category":"Coffee"}]')).toThrow(/string id/);
  });
});

describe('toSuggestions', () => {
  const candidates = [
    txn({ externalId: 't1' }),
    txn({ externalId: 't2', categoryName: 'Dining', notes: 'already noted' }),
  ];
  const allowed = ['Coffee', 'Dining', 'Groceries'];

  test('keeps only categories that exist, matched case-insensitively', () => {
    const out = toSuggestions([{ id: 't1', category: 'coffee' }], candidates, allowed);
    expect(out).toHaveLength(1);
    // Stored in the ledger's own casing — the apply path resolves by name.
    expect(out[0]).toMatchObject({ kind: 'category', suggestedValue: 'Coffee' });
  });

  test('drops a category that is not in the allowed list', () => {
    // An unresolvable suggestion is worse than none: the apply path could not
    // honor it, so it would sit on the page as permanent noise.
    expect(toSuggestions([{ id: 't1', category: 'Invented' }], candidates, allowed)).toHaveLength(0);
  });

  test('drops a suggestion that restates the current value', () => {
    expect(toSuggestions([{ id: 't2', category: 'Dining' }], candidates, allowed)).toHaveLength(0);
    expect(toSuggestions([{ id: 't2', note: 'already noted' }], candidates, allowed)).toHaveLength(0);
  });

  test('drops suggestions for transactions that were never sent', () => {
    expect(toSuggestions([{ id: 'ghost', category: 'Coffee' }], candidates, allowed)).toHaveLength(0);
  });

  test('normalizes confidence and passes the rationale through', () => {
    const out = toSuggestions(
      [{ id: 't1', note: 'looks like a subscription', rationale: 'monthly, same amount', confidence: 'HIGH' }],
      candidates,
      allowed,
    );
    expect(out[0]).toMatchObject({
      kind: 'note',
      confidence: 'high',
      rationale: 'monthly, same amount',
    });
  });

  test('discards a confidence value outside the vocabulary', () => {
    const out = toSuggestions([{ id: 't1', category: 'Coffee', confidence: 'pretty sure' }], candidates, allowed);
    expect(out[0]?.confidence).toBeNull();
  });
});

describe('selectCandidates', () => {
  test('puts uncategorized rows first and never repeats a transaction', () => {
    const summary = composeReview({
      period: periodFromKey('2026-03'),
      transactions: [
        txn({ externalId: 'uncat', amount: -900 }), // uncategorized AND large
        txn({ externalId: 'big', amount: -800, categoryName: 'Rent' }),
      ],
    });
    const selected = selectCandidates(summary, 10).map((t) => t.externalId);
    expect(selected).toEqual(['uncat', 'big']);
  });

  test('honors the cap', () => {
    const summary = composeReview({
      period: periodFromKey('2026-03'),
      transactions: Array.from({ length: 30 }, (_, i) => txn({ externalId: `t${i}` })),
    });
    expect(selectCandidates(summary, 5)).toHaveLength(5);
  });
});

describe('TransactionAssist', () => {
  const summary = composeReview({
    period: periodFromKey('2026-03'),
    transactions: [txn({ externalId: 't1' })],
  });

  function invoker(over: Partial<ModelInvoker>): ModelInvoker {
    return {
      enabled: true,
      invoke: async () => {
        throw new Error('not used');
      },
      invokeTagged: async () => {
        throw new Error('not used');
      },
      modelFor: () => 'stub-model',
      spend: async () => {
        throw new Error('not used');
      },
      ...over,
    } as ModelInvoker;
  }

  test('turns model output into proposals', async () => {
    const assist = new TransactionAssist(
      invoker({ invokeTagged: async () => [{ id: 't1', category: 'Coffee' }] as never }),
      log,
    );
    const out = await assist.propose(summary, [{ id: 'c1', name: 'Coffee' }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ transactionId: 't1', kind: 'category', suggestedValue: 'Coffee' });
  });

  /**
   * A review without an assist is still a review. Failing the whole monthly
   * batch because a spend ceiling was hit would be the tail wagging the dog.
   */
  test('returns nothing rather than throwing when the model is unavailable', async () => {
    const assist = new TransactionAssist(
      invoker({
        invokeTagged: async () => {
          throw new ModelInvocationError('budget', {
            reason: 'budget_exceeded',
            task: 'finance.assist',
            transient: true,
          });
        },
      }),
      log,
    );
    expect(await assist.propose(summary, [{ id: 'c1', name: 'Coffee' }])).toEqual([]);
  });

  test('does not call the model at all when nothing was flagged', async () => {
    let called = false;
    const clean = composeReview({
      period: periodFromKey('2026-03'),
      transactions: [txn({ externalId: 'ok', amount: -5, categoryName: 'Dining' })],
    });
    const assist = new TransactionAssist(
      invoker({
        invokeTagged: async () => {
          called = true;
          return [] as never;
        },
      }),
      log,
    );
    expect(await assist.propose(clean, [])).toEqual([]);
    expect(called).toBe(false);
  });
});
