import { describe, expect, test } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import type {
  HeartbeatOptions,
  HeartbeatRegistry,
  NotifyInput,
  PagePublisher,
  PublishPageInput,
} from '@jarvus/claude-assist-core';
import { FINANCE_PIPELINE, ReviewRunner, buildReviewNotification } from './runner.js';
import { composeReview } from './compose.js';
import { MemoryFinanceStore } from '../memory-store.js';
import { periodFromKey } from '../period.js';
import type {
  FinanceSource,
  PreflightResult,
  SourceTransaction,
  TransactionQuery,
} from '../source/types.js';

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

function sourceTxn(over: Partial<SourceTransaction> & { id: string; date: string }): SourceTransaction {
  return { amount: -25, merchant: 'Coffee Bar', categoryName: 'Dining', ...over };
}

class StubSource implements FinanceSource {
  readonly mode = 'api' as const;
  updates: Array<{ id: string }> = [];
  categoryCalls = 0;

  constructor(
    private preflightResult: PreflightResult,
    private transactions: SourceTransaction[] = [],
    private failPrior = false,
  ) {}

  async preflight() {
    return this.preflightResult;
  }
  async listTransactions(query: TransactionQuery) {
    if (this.failPrior && query.startDate.startsWith('2026-02')) {
      throw new Error('rate limited');
    }
    return this.transactions.filter((t) => t.date >= query.startDate && t.date <= query.endDate);
  }
  async listAccounts() {
    return [];
  }
  async listCategories() {
    this.categoryCalls += 1;
    return [{ id: 'c1', name: 'Dining' }];
  }
  async updateTransaction(update: { id: string }) {
    this.updates.push(update);
  }
}

function harness(source: FinanceSource, over: Partial<ConstructorParameters<typeof ReviewRunner>[0]> = {}) {
  const store = new MemoryFinanceStore();
  const published: PublishPageInput[] = [];
  const notifications: NotifyInput[] = [];
  const beats: Array<{ name: string; opts?: HeartbeatOptions }> = [];

  const pages: PagePublisher = {
    async publish(input) {
      published.push(input);
      return { slug: input.slug, url: `https://example.test/pages/${input.slug}`, created: true, versionId: 1 };
    },
  };
  const heartbeats: HeartbeatRegistry = {
    async register() {},
    async beat(name, opts) {
      beats.push({ name, ...(opts ? { opts } : {}) });
    },
    async list() {
      return [];
    },
  };

  const runner = new ReviewRunner({
    store,
    source,
    assist: null,
    tana: null,
    pages,
    notify: {
      async notify(input) {
        notifications.push(input);
        return { id: notifications.length, priority: input.priority, deliveredVia: ['pushover'], status: 'sent' };
      },
    },
    heartbeats,
    log,
    timeZone: 'America/New_York',
    currency: 'USD',
    coverageThreshold: '40 days',
    ...over,
  });

  return { runner, store, published, notifications, beats };
}

describe('ReviewRunner', () => {
  test('pulls, publishes, links, pings, and beats on a healthy run', async () => {
    const source = new StubSource({ ok: true, mode: 'api' }, [
      sourceTxn({ id: 't1', date: '2026-03-04' }),
      sourceTxn({ id: 't2', date: '2026-03-19', amount: -900 }),
      sourceTxn({ id: 'prior', date: '2026-02-11' }),
    ]);
    const { runner, store, published, notifications, beats } = harness(source);

    const result = await runner.runPeriod('2026-03');

    expect(result.status).toBe('rendered');
    expect(result.transactionsPulled).toBe(2);
    expect(result.pageUrl).toBe('https://example.test/pages/finance-review-2026-03');
    expect(published[0]?.slug).toBe('finance-review-2026-03');
    expect(published[0]?.html).toContain('Finance review');
    expect(notifications[0]?.priority).toBe('notice');
    expect(notifications[0]?.url).toBe('https://example.test/pages/finance-review-2026-03');
    expect(beats).toEqual([
      { name: FINANCE_PIPELINE, opts: { threshold: '40 days', metadata: { period: '2026-03', transactions: 2 } } },
    ]);

    const review = await store.getReview('2026-03');
    expect(review?.status).toBe('rendered');
    expect(review?.notifiedAt).not.toBeNull();
  });

  /**
   * The whole point of the preflight: an unusable source yields one honest
   * blocked review, no ping, and — critically — NO heartbeat, so the coverage
   * monitor pages on the missing month rather than the instance looking healthy.
   */
  test('exits clean and blocked when the source is unavailable', async () => {
    const source = new StubSource({
      ok: false,
      mode: 'api',
      reason: 'not_configured',
      detail: 'FINANCE_API_BASE_URL is not set',
    });
    const { runner, store, published, notifications, beats } = harness(source);

    const result = await runner.runPeriod('2026-03');

    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toContain('not_configured');
    expect(published).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    expect(beats).toHaveLength(0);
    expect((await store.getReview('2026-03'))?.status).toBe('blocked');
  });

  test('renders without a month-over-month comparison when the prior pull fails', async () => {
    const source = new StubSource(
      { ok: true, mode: 'api' },
      [sourceTxn({ id: 't1', date: '2026-03-04' })],
      true,
    );
    const { runner, published } = harness(source);

    const result = await runner.runPeriod('2026-03');

    expect(result.status).toBe('rendered');
    expect(published[0]?.html).toContain('Month-over-month comparison unavailable');
  });

  test('still renders and beats when there is no page surface', async () => {
    const source = new StubSource({ ok: true, mode: 'api' }, [sourceTxn({ id: 't1', date: '2026-03-04' })]);
    const { runner, notifications, beats } = harness(source, { pages: undefined });

    const result = await runner.runPeriod('2026-03');

    expect(result.status).toBe('rendered');
    expect(result.pageUrl).toBeNull();
    expect(notifications[0]?.url).toBeUndefined();
    expect(beats).toHaveLength(1);
  });

  test('re-running a period republishes the same slug rather than creating a second review', async () => {
    const source = new StubSource({ ok: true, mode: 'api' }, [sourceTxn({ id: 't1', date: '2026-03-04' })]);
    const { runner, store, published } = harness(source);

    await runner.runPeriod('2026-03');
    await runner.runPeriod('2026-03');

    expect(published.map((p) => p.slug)).toEqual([
      'finance-review-2026-03',
      'finance-review-2026-03',
    ]);
    expect(await store.listReviews(10)).toHaveLength(1);
  });

  test('the scheduled run targets the most recently closed month', async () => {
    const source = new StubSource({ ok: true, mode: 'api' }, []);
    const { runner } = harness(source);
    const result = await runner.runScheduled(new Date('2026-04-03T13:00:00Z'));
    expect(result.period).toBe('2026-03');
  });
});

describe('buildReviewNotification', () => {
  const summary = composeReview({
    period: periodFromKey('2026-03'),
    transactions: [],
  });

  test('is a notice, never an interrupt — a closed month can always wait', () => {
    expect(buildReviewNotification(summary, 'https://example.test/p', null).priority).toBe('notice');
  });

  test('prefers the page link and falls back to the Tana node', () => {
    expect(buildReviewNotification(summary, 'https://example.test/p', 'node1').url).toBe(
      'https://example.test/p',
    );
    expect(buildReviewNotification(summary, null, 'node1').url).toContain('nodeid=node1');
    expect(buildReviewNotification(summary, null, null).url).toBeUndefined();
  });
});
