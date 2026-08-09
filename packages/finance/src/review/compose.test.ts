import { describe, expect, test } from 'bun:test';
import { composeReview, flagTransactions, headline } from './compose.js';
import { periodFromKey } from '../period.js';
import type { TransactionRecord } from '../types.js';

function txn(over: Partial<TransactionRecord> & { externalId: string; amount: number }): TransactionRecord {
  return {
    postedOn: '2026-03-10',
    currency: 'USD',
    merchant: 'Some Shop',
    description: null,
    accountId: 'acct-1',
    categoryId: 'cat-1',
    categoryName: 'Groceries',
    notes: null,
    tags: [],
    isPending: false,
    needsReview: false,
    ...over,
  };
}

const period = periodFromKey('2026-03');

describe('composeReview', () => {
  test('separates outflow from inflow and nets them', () => {
    const summary = composeReview({
      period,
      transactions: [
        txn({ externalId: 'a', amount: -40 }),
        txn({ externalId: 'b', amount: -60 }),
        txn({ externalId: 'c', amount: 500, categoryName: 'Income' }),
      ],
    });
    expect(summary.totalOutflow).toBe(100);
    expect(summary.totalInflow).toBe(500);
    expect(summary.net).toBe(400);
    expect(summary.transactionCount).toBe(3);
  });

  test('ranks categories by outflow and carries the prior month for comparison', () => {
    const summary = composeReview({
      period,
      transactions: [
        txn({ externalId: 'a', amount: -30, categoryName: 'Groceries' }),
        txn({ externalId: 'b', amount: -90, categoryName: 'Rent' }),
      ],
      priorTransactions: [txn({ externalId: 'p', amount: -60, categoryName: 'Groceries' })],
      priorPeriodKey: '2026-02',
    });
    expect(summary.categories.map((c) => c.category)).toEqual(['Rent', 'Groceries']);
    expect(summary.categories.find((c) => c.category === 'Groceries')?.priorOutflow).toBe(60);
    // Rent had no prior-month counterpart: null, not zero. Zero would render as
    // a "+∞%" delta for something that simply wasn't there to compare against.
    expect(summary.categories.find((c) => c.category === 'Rent')?.priorOutflow).toBeNull();
  });

  test('collects uncategorized transactions as their own section', () => {
    const summary = composeReview({
      period,
      transactions: [
        txn({ externalId: 'a', amount: -20, categoryName: null }),
        txn({ externalId: 'b', amount: -20, categoryName: '  ' }),
        txn({ externalId: 'c', amount: -20 }),
      ],
    });
    expect(summary.uncategorized.map((u) => u.transaction.externalId)).toEqual(['a', 'b']);
    expect(summary.categories.find((c) => c.category === 'Uncategorized')?.count).toBe(2);
  });
});

describe('flagTransactions', () => {
  test('flags large outflows, source-flagged rows, and lingering pendings', () => {
    const flagged = flagTransactions(
      [
        txn({ externalId: 'big', amount: -900 }),
        txn({ externalId: 'small', amount: -5 }),
        txn({ externalId: 'srcflag', amount: -5, needsReview: true }),
        txn({ externalId: 'pending', amount: -5, isPending: true }),
      ],
      { threshold: 250, priorMerchants: new Set() },
    );
    const ids = flagged.map((f) => f.transaction.externalId);
    expect(ids).toContain('big');
    expect(ids).toContain('srcflag');
    expect(ids).toContain('pending');
    expect(ids).not.toContain('small');
  });

  test('flags a first-time merchant only when there is history to compare against', () => {
    const rows = [txn({ externalId: 'new', amount: -20, merchant: 'Brand New Co' })];

    // No prior month: claiming "first charge" would be an artifact of having no
    // data, not an observation.
    expect(flagTransactions(rows, { threshold: 250, priorMerchants: new Set() })).toHaveLength(0);

    const withHistory = flagTransactions(rows, {
      threshold: 250,
      priorMerchants: new Set(['some shop']),
    });
    expect(withHistory[0]?.reasons).toContain('first charge from this merchant');
  });

  test('sorts the biggest outflow first', () => {
    const flagged = flagTransactions(
      [
        txn({ externalId: 'mid', amount: -400 }),
        txn({ externalId: 'huge', amount: -4000 }),
        txn({ externalId: 'edge', amount: -250 }),
      ],
      { threshold: 250, priorMerchants: new Set() },
    );
    expect(flagged.map((f) => f.transaction.externalId)).toEqual(['huge', 'mid', 'edge']);
  });
});

describe('headline', () => {
  test('states the month-over-month direction', () => {
    const summary = composeReview({
      period,
      transactions: [txn({ externalId: 'a', amount: -150 })],
      priorTransactions: [txn({ externalId: 'p', amount: -100 })],
      priorPeriodKey: '2026-02',
    });
    expect(headline(summary)).toContain('up 50%');
    expect(headline(summary)).toContain('vs 2026-02');
  });

  test('omits the comparison when there is no prior month', () => {
    const summary = composeReview({ period, transactions: [txn({ externalId: 'a', amount: -150 })] });
    expect(headline(summary)).not.toContain('vs');
    expect(headline(summary)).toContain('1 transactions');
  });
});
