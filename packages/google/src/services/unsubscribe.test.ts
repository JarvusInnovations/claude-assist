import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import type postgres from 'postgres';
import type { Ledger, LedgerRecordInput } from '@jarvus/claude-assist-core';
import {
  UnsubscribeService,
  UnsubscribeStore,
  type AttemptOutcome,
  type SenderMessage,
  type UnsubscribeAttemptRow,
  type UnsubscribeStoreLike,
} from './unsubscribe.js';
import type { SenderStanding } from './standing.js';
import type { BrowserDriver, BrowserUnsubscribeResult } from './unsubscribe-browser.js';
import type { UnsubscribeHeaders } from './unsubscribe-detect.js';

function makeLogger(): FastifyBaseLogger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => makeLogger(),
  } as unknown as FastifyBaseLogger;
}

const NOW = new Date('2026-08-08T12:00:00Z');

interface FakeStoreOptions {
  attempt?: Partial<UnsubscribeAttemptRow>;
  standing?: SenderStanding | null;
  message?: SenderMessage | null;
  recent?: Date[];
}

/**
 * A fake over the whole persistence surface. Recording `finish` / `defer` is
 * what lets a test assert on the DECISION rather than on SQL text.
 */
function fakeStore(options: FakeStoreOptions = {}) {
  const finished: Array<{ id: number; outcome: AttemptOutcome }> = [];
  const deferred: Array<{ id: number; until: Date; note: string }> = [];
  const standingLookups: string[] = [];
  const row: UnsubscribeAttemptRow = {
    id: 1,
    sender_email: 'news@bulk.test',
    sender_domain: 'bulk.test',
    account_id: null,
    email_id: null,
    tier: null,
    method: null,
    target_url: null,
    proof_path: null,
    status: 'running',
    detail: {},
    attempts: 1,
    ...options.attempt,
  };
  const store: UnsubscribeStoreLike = {
    enqueueFromQueue: async () => 0,
    loadAttempt: async () => row,
    standingFor: async (email) => {
      standingLookups.push(email);
      return options.standing === undefined ? 'unsubscribe_queue' : options.standing;
    },
    latestSenderMessage: async () =>
      options.message === undefined
        ? { id: 42, account_id: 7, message_id: 'gmsg-1', analysis: null }
        : options.message,
    recentDomainActions: async () => options.recent ?? [],
    finish: async (id, outcome) => {
      finished.push({ id, outcome });
    },
    defer: async (id, until, note) => {
      deferred.push({ id, until, note });
    },
    listByStatus: async () => [],
  };
  return { store, row, finished, deferred, standingLookups };
}

function fakeLedger() {
  const records: LedgerRecordInput[] = [];
  const ledger: Ledger = {
    record: async (input) => {
      records.push(input);
      return { id: records.length };
    },
  };
  return { ledger, records };
}

interface ServiceOptions extends FakeStoreOptions {
  whitelist?: string[];
  derived?: string[];
  headers?: UnsubscribeHeaders;
  browser?: BrowserDriver;
  browserEnabled?: boolean;
  teamDomains?: string[];
  rateMaxPerDomain?: number;
  postResult?: { status: number; ok: boolean };
  postThrows?: string;
}

function makeService(options: ServiceOptions = {}) {
  const fake = fakeStore(options);
  const { ledger, records } = fakeLedger();
  const posted: string[] = [];
  const headerCalls: Array<{ accountId: number; messageId: string }> = [];

  const service = new UnsubscribeService(
    makeLogger(),
    {
      store: fake.store,
      standingStore: {
        whitelistedSenders: async () => new Set(options.whitelist ?? []),
      },
      whitelistService: {
        deriveWhitelist: async () => new Set(options.derived ?? []),
      },
      headerSource: {
        fetchHeaders: async (accountId, messageId) => {
          headerCalls.push({ accountId, messageId });
          return options.headers ?? {};
        },
      },
      ...(options.browser ? { browser: options.browser } : {}),
      post: async (url) => {
        posted.push(url);
        if (options.postThrows) throw new Error(options.postThrows);
        return options.postResult ?? { status: 200, ok: true };
      },
      ledger,
      now: () => NOW,
    },
    {
      enabled: true,
      browserEnabled: options.browserEnabled ?? Boolean(options.browser),
      rateWindowMinutes: 60,
      rateMaxPerDomain: options.rateMaxPerDomain ?? 3,
      proofDir: '/tmp/unsub-proof-test',
      ...(options.teamDomains ? { teamDomains: options.teamDomains } : {}),
    }
  );
  return { service, ...fake, records, posted, headerCalls };
}

const ONE_CLICK: UnsubscribeHeaders = {
  listUnsubscribe: '<https://lists.bulk.test/u/abc>',
  listUnsubscribePost: 'List-Unsubscribe=One-Click',
};
const LINK_ONLY: UnsubscribeHeaders = { listUnsubscribe: '<https://bulk.test/manage>' };
const MAILTO_ONLY: UnsubscribeHeaders = { listUnsubscribe: '<mailto:u@bulk.test>' };

// ── Invariant 1: the whitelist hard-gates every tier ────────────────────────

describe('the whitelist blocks auto-unsubscribe at EVERY tier', () => {
  const tiers: Array<{ name: string; headers: UnsubscribeHeaders; browser?: BrowserDriver }> = [
    { name: 'tier 1 (one-click)', headers: ONE_CLICK },
    {
      name: 'tier 2 (browser form)',
      headers: LINK_ONLY,
      browser: {
        preflight: async () => ({ ok: true, detail: 'ok' }),
        unsubscribe: async (): Promise<BrowserUnsubscribeResult> => {
          throw new Error('the browser must never be reached for a whitelisted sender');
        },
      },
    },
    { name: 'tier 3 (review)', headers: MAILTO_ONLY },
  ];

  for (const tier of tiers) {
    it(`${tier.name}: a whitelisted sender is never auto-unsubscribed`, async () => {
      const ctx = makeService({
        headers: tier.headers,
        ...(tier.browser ? { browser: tier.browser } : {}),
        whitelist: ['news@bulk.test'],
        standing: 'unsubscribe_queue',
      });
      const outcome = await ctx.service.processAttempt(1);

      expect(ctx.posted).toEqual([]);
      expect(ctx.records).toEqual([]);
      expect(outcome).toEqual({ kind: 'terminal', status: 'needs_review' });
      expect(ctx.finished[0]!.outcome.status).toBe('needs_review');
      expect(ctx.finished[0]!.outcome.detail).toMatchObject({
        reason: 'whitelisted-address',
        blocked_by: 'gate',
      });
    });
  }

  it('blocks on the derived reply-history whitelist, not just explicit standings', async () => {
    const ctx = makeService({
      headers: ONE_CLICK,
      derived: ['news@bulk.test'],
      standing: 'unsubscribe_queue',
    });
    await ctx.service.processAttempt(1);
    expect(ctx.posted).toEqual([]);
    expect(ctx.finished[0]!.outcome.status).toBe('needs_review');
  });

  it('blocks on a whitelisted team domain', async () => {
    const ctx = makeService({
      attempt: { sender_email: 'noreply@team.test', sender_domain: 'team.test' },
      headers: ONE_CLICK,
      teamDomains: ['team.test'],
      standing: 'unsubscribe_queue',
    });
    await ctx.service.processAttempt(1);
    expect(ctx.posted).toEqual([]);
    expect(ctx.finished[0]!.outcome.detail).toMatchObject({ reason: 'whitelisted-domain' });
  });

  it('refuses to act at all when the whitelist cannot be computed', async () => {
    const fake = fakeStore({});
    const service = new UnsubscribeService(
      makeLogger(),
      {
        store: fake.store,
        standingStore: {
          whitelistedSenders: async () => {
            throw new Error('database is down');
          },
        },
        whitelistService: { deriveWhitelist: async () => new Set() },
        headerSource: { fetchHeaders: async () => ONE_CLICK },
        post: async () => {
          throw new Error('must not POST without a whitelist');
        },
        now: () => NOW,
      },
      { enabled: true }
    );
    const outcome = await service.processAttempt(1);
    expect(outcome).toEqual({ kind: 'terminal', status: 'needs_review' });
    expect(fake.finished[0]!.outcome.detail).toMatchObject({ reason: 'whitelist-unavailable' });
  });
});

// ── Invariant 2: execution draws only from the owner-flagged queue ──────────

describe('execution draws ONLY from the owner-flagged unsubscribe queue', () => {
  it('re-checks the standing at execution time and skips an un-flagged sender', async () => {
    const ctx = makeService({ headers: ONE_CLICK, standing: null });
    const outcome = await ctx.service.processAttempt(1);

    // The row was enqueued at some point, but the flag is gone now.
    expect(ctx.standingLookups).toEqual(['news@bulk.test']);
    expect(ctx.posted).toEqual([]);
    expect(ctx.records).toEqual([]);
    expect(outcome).toEqual({ kind: 'terminal', status: 'skipped' });
    expect(ctx.finished[0]!.outcome.detail).toMatchObject({ reason: 'not-queued' });
  });

  it('skips a sender whose standing flipped to whitelist after enqueue', async () => {
    const ctx = makeService({ headers: ONE_CLICK, standing: 'whitelist' });
    await ctx.service.processAttempt(1);
    expect(ctx.posted).toEqual([]);
    expect(ctx.finished[0]!.outcome.status).not.toBe('succeeded');
  });

  it('acts only once the flag IS present', async () => {
    const ctx = makeService({ headers: ONE_CLICK, standing: 'unsubscribe_queue' });
    const outcome = await ctx.service.processAttempt(1);
    expect(outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect(ctx.posted).toEqual(['https://lists.bulk.test/u/abc']);
  });

  it('the enqueue statement reads sender_standing and nothing else', async () => {
    const queries: { text: string; params: unknown[] }[] = [];
    const sql = ((strings: TemplateStringsArray, ...params: unknown[]) => {
      queries.push({ text: strings.join('?'), params });
      return Promise.resolve([{ id: 1 }]);
    }) as unknown as postgres.Sql;

    const inserted = await new UnsubscribeStore(sql).enqueueFromQueue(50);
    expect(inserted).toBe(1);

    const text = queries[0]!.text;
    expect(text).toContain('FROM google.sender_standing s');
    expect(text).toContain("s.standing = 'unsubscribe_queue'");
    // No classifier / triage surface is a source: the only tables named are the
    // standing store and the attempts table it materializes into.
    for (const forbidden of [
      'google.emails',
      'google.triage_rules',
      'google.classification_refinements',
      'analysis',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

// ── Tier 1 ─────────────────────────────────────────────────────────────────

describe('tier 1 — RFC 8058 one-click', () => {
  it('fires the POST, succeeds, and writes an audit-ledger row', async () => {
    const ctx = makeService({ headers: ONE_CLICK });
    const outcome = await ctx.service.processAttempt(1);

    expect(outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect(ctx.posted).toEqual(['https://lists.bulk.test/u/abc']);
    expect(ctx.headerCalls).toEqual([{ accountId: 7, messageId: 'gmsg-1' }]);

    expect(ctx.records).toHaveLength(1);
    const record = ctx.records[0]!;
    expect(record.actor).toEqual({ kind: 'service', service: 'unsubscribe-automation' });
    expect(record.actionType).toBe('unsubscribe');
    expect(record.targetSystem).toBe('email');
    expect(record.targetId).toBe('news@bulk.test');
    expect(record.context).toMatchObject({
      attempt_id: 1,
      tier: 1,
      method: 'one_click',
      sender_domain: 'bulk.test',
      target_url: 'https://lists.bulk.test/u/abc',
      http_status: 200,
      ok: true,
      email_id: 42,
    });

    // `dispatched` is what makes this action count against the rate limit.
    expect(ctx.finished[0]!.outcome.detail).toMatchObject({ dispatched: true });
  });

  it('ledgers a failed POST too, and asks the lease for a retry', async () => {
    const ctx = makeService({ headers: ONE_CLICK, postResult: { status: 503, ok: false } });
    const outcome = await ctx.service.processAttempt(1);

    expect(outcome.kind).toBe('retry');
    expect(ctx.records).toHaveLength(1);
    expect(ctx.records[0]!.context).toMatchObject({ http_status: 503, ok: false });
    // Nothing terminal was written: the lease owns the retry/backoff.
    expect(ctx.finished).toEqual([]);
  });

  it('ledgers a transport error with the reason attached', async () => {
    const ctx = makeService({ headers: ONE_CLICK, postThrows: 'ETIMEDOUT' });
    const outcome = await ctx.service.processAttempt(1);
    expect(outcome).toMatchObject({ kind: 'retry', error: 'ETIMEDOUT' });
    expect(ctx.records[0]!.context).toMatchObject({ error: 'ETIMEDOUT' });
  });

  it('a ledger failure never breaks the unsubscribe it is recording', async () => {
    const fake = fakeStore({});
    const service = new UnsubscribeService(
      makeLogger(),
      {
        store: fake.store,
        standingStore: { whitelistedSenders: async () => new Set() },
        whitelistService: { deriveWhitelist: async () => new Set() },
        headerSource: { fetchHeaders: async () => ONE_CLICK },
        post: async () => ({ status: 200, ok: true }),
        ledger: {
          record: async () => {
            throw new Error('ledger is down');
          },
        },
        now: () => NOW,
      },
      { enabled: true }
    );
    const outcome = await service.processAttempt(1);
    expect(outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
  });
});

// ── Tier 2 ─────────────────────────────────────────────────────────────────

describe('tier 2 — browser-driven form', () => {
  const submitting: BrowserDriver = {
    preflight: async () => ({ ok: true, detail: 'ok' }),
    unsubscribe: async (_url, opts) => ({
      outcome: 'submitted',
      screenshotPath: opts.screenshotPath,
      confirmed: true,
      reason: 'clicked the unsubscribe control; page confirmed',
      steps: ['preflight ok', 'open', 'probe', 'click'],
    }),
  };

  it('submits the form and puts the screenshot POINTER in the ledger', async () => {
    const ctx = makeService({ headers: LINK_ONLY, browser: submitting });
    const outcome = await ctx.service.processAttempt(1);

    expect(outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect(ctx.records).toHaveLength(1);
    const context = ctx.records[0]!.context as Record<string, unknown>;
    expect(context.tier).toBe(2);
    expect(context.method).toBe('browser_form');
    expect(context.confirmed).toBe(true);
    expect(String(context.proof_path)).toBe('/tmp/unsub-proof-test/1-news_bulk.test.png');
    // The ledger carries the path, never the image bytes.
    expect(JSON.stringify(context)).not.toContain('base64');

    expect(ctx.finished[0]!.outcome.proofPath).toBe('/tmp/unsub-proof-test/1-news_bulk.test.png');
    expect(ctx.finished[0]!.outcome.detail).toMatchObject({ dispatched: true, confirmed: true });
  });

  it('records the submission even when the page showed no confirmation text', async () => {
    const unconfirmed: BrowserDriver = {
      preflight: async () => ({ ok: true, detail: 'ok' }),
      unsubscribe: async (_url, opts) => ({
        outcome: 'submitted',
        screenshotPath: opts.screenshotPath,
        confirmed: false,
        reason: 'no confirmation text — verify the screenshot',
        steps: [],
      }),
    };
    const ctx = makeService({ headers: LINK_ONLY, browser: unconfirmed });
    await ctx.service.processAttempt(1);
    expect(ctx.records[0]!.context).toMatchObject({ confirmed: false });
  });

  it('downgrades to tier 3 review — with proof — when the bridge is unreachable', async () => {
    const unavailable: BrowserDriver = {
      preflight: async () => ({ ok: false, detail: 'connect ECONNREFUSED' }),
      unsubscribe: async () => ({
        outcome: 'unavailable',
        reason: 'browser bridge unreachable: connect ECONNREFUSED',
        steps: ['preflight failed'],
      }),
    };
    const ctx = makeService({ headers: LINK_ONLY, browser: unavailable });
    const outcome = await ctx.service.processAttempt(1);

    expect(outcome).toEqual({ kind: 'terminal', status: 'needs_review' });
    expect(ctx.finished[0]!.outcome.tier).toBe(3);
    expect(ctx.finished[0]!.outcome.detail).toMatchObject({ reason: 'browser-unavailable' });
    // Nothing left this host, so nothing is ledgered.
    expect(ctx.records).toEqual([]);
  });

  it('downgrades to tier 3 when the page needs judgment (login wall)', async () => {
    const login: BrowserDriver = {
      preflight: async () => ({ ok: true, detail: 'ok' }),
      unsubscribe: async (_url, opts) => ({
        outcome: 'needs_review',
        screenshotPath: opts.screenshotPath,
        reason: 'login wall detected',
        steps: [],
      }),
    };
    const ctx = makeService({ headers: LINK_ONLY, browser: login });
    await ctx.service.processAttempt(1);
    expect(ctx.finished[0]!.outcome.status).toBe('needs_review');
    expect(ctx.finished[0]!.outcome.proofPath).toBe('/tmp/unsub-proof-test/1-news_bulk.test.png');
    expect(ctx.records).toEqual([]);
  });

  it('routes to review when the browser tier is not configured at all', async () => {
    const ctx = makeService({ headers: LINK_ONLY, browserEnabled: false });
    const outcome = await ctx.service.processAttempt(1);
    expect(outcome).toEqual({ kind: 'terminal', status: 'needs_review' });
    expect(ctx.finished[0]!.outcome.detail).toMatchObject({ reason: 'browser-tier-disabled' });
  });
});

// ── Tier 3 ─────────────────────────────────────────────────────────────────

describe('tier 3 — login/judgment cases go to the review queue, never auto-executed', () => {
  it('routes a mailto-only sender to review without acting', async () => {
    const ctx = makeService({ headers: MAILTO_ONLY });
    const outcome = await ctx.service.processAttempt(1);

    expect(outcome).toEqual({ kind: 'terminal', status: 'needs_review' });
    expect(ctx.posted).toEqual([]);
    expect(ctx.records).toEqual([]);
    expect(ctx.finished[0]!.outcome).toMatchObject({ tier: 3, method: 'review' });
    expect(ctx.finished[0]!.outcome.detail).toMatchObject({ mailto: 'mailto:u@bulk.test' });
  });

  it('routes a sender with no usable method to review', async () => {
    const ctx = makeService({ headers: {} });
    const outcome = await ctx.service.processAttempt(1);
    expect(outcome).toEqual({ kind: 'terminal', status: 'needs_review' });
    expect(ctx.finished[0]!.outcome.detail).toMatchObject({
      reason: 'no unsubscribe method found',
    });
  });

  it('routes to review when no synced message exists to read a method off', async () => {
    const ctx = makeService({ message: null });
    const outcome = await ctx.service.processAttempt(1);
    expect(outcome).toEqual({ kind: 'terminal', status: 'needs_review' });
    expect(ctx.finished[0]!.outcome.detail).toMatchObject({ reason: 'no-message' });
  });

  it('falls back to the triage-extracted body link when header fetch fails', async () => {
    const fake = fakeStore({
      message: {
        id: 42,
        account_id: 7,
        message_id: 'gmsg-1',
        analysis: JSON.stringify({ unsubscribe_link: 'https://bulk.test/opt-out' }),
      },
    });
    const service = new UnsubscribeService(
      makeLogger(),
      {
        store: fake.store,
        standingStore: { whitelistedSenders: async () => new Set() },
        whitelistService: { deriveWhitelist: async () => new Set() },
        headerSource: {
          fetchHeaders: async () => {
            throw new Error('gmail 404');
          },
        },
        now: () => NOW,
      },
      { enabled: true, browserEnabled: false }
    );
    await service.processAttempt(1);
    // Tier 2 was detected from the body link, then downgraded (no browser).
    expect(fake.finished[0]!.outcome.detail).toMatchObject({ reason: 'browser-tier-disabled' });
    expect(fake.finished[0]!.outcome.targetUrl).toBe('https://bulk.test/opt-out');
  });
});

// ── Rate limits ────────────────────────────────────────────────────────────

describe('per-sender-domain rate limits', () => {
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

  it('defers rather than acting once the domain hits the cap in the window', async () => {
    const ctx = makeService({
      headers: ONE_CLICK,
      rateMaxPerDomain: 2,
      recent: [minutesAgo(30), minutesAgo(10)],
    });
    const outcome = await ctx.service.processAttempt(1);

    expect(outcome.kind).toBe('deferred');
    expect(ctx.posted).toEqual([]);
    expect(ctx.records).toEqual([]);
    expect(ctx.finished).toEqual([]);
    expect(ctx.deferred).toHaveLength(1);
    // A slot frees when the oldest in-window action ages out: 30m from now.
    expect(ctx.deferred[0]!.until.toISOString()).toBe('2026-08-08T12:30:00.000Z');
    expect(ctx.deferred[0]!.note).toContain('bulk.test');
  });

  it('acts while the domain is under the cap', async () => {
    const ctx = makeService({
      headers: ONE_CLICK,
      rateMaxPerDomain: 3,
      recent: [minutesAgo(30), minutesAgo(10)],
    });
    const outcome = await ctx.service.processAttempt(1);
    expect(outcome).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect(ctx.deferred).toEqual([]);
  });

  it('checks the rate limit AFTER the gate, so a blocked sender is not deferred', async () => {
    const ctx = makeService({
      headers: ONE_CLICK,
      whitelist: ['news@bulk.test'],
      rateMaxPerDomain: 1,
      recent: [minutesAgo(5)],
    });
    await ctx.service.processAttempt(1);
    expect(ctx.deferred).toEqual([]);
    expect(ctx.finished[0]!.outcome.detail).toMatchObject({ reason: 'whitelisted-address' });
  });

  it('the store only counts DISPATCHED actions toward the window', async () => {
    const queries: { text: string; params: unknown[] }[] = [];
    const sql = ((strings: TemplateStringsArray, ...params: unknown[]) => {
      queries.push({ text: strings.join('?'), params });
      return Promise.resolve([]);
    }) as unknown as postgres.Sql;

    await new UnsubscribeStore(sql).recentDomainActions('bulk.test', minutesAgo(60));
    const text = queries[0]!.text;
    expect(text).toContain('sender_domain');
    expect(text).toContain("(detail ->> 'dispatched') = 'true'");
    expect(queries[0]!.params).toContain('bulk.test');
  });
});

// ── The disabled path ──────────────────────────────────────────────────────

describe('the automation is off unless explicitly enabled', () => {
  it('runCycle does nothing when disabled', async () => {
    const fake = fakeStore({});
    const service = new UnsubscribeService(
      makeLogger(),
      {
        store: fake.store,
        standingStore: { whitelistedSenders: async () => new Set() },
        whitelistService: { deriveWhitelist: async () => new Set() },
        headerSource: { fetchHeaders: async () => ONE_CLICK },
      },
      {}
    );
    const result = await service.runCycle();
    expect(result).toMatchObject({ enqueued: 0, claimed: 0 });
  });
});
