import { describe, expect, it } from 'bun:test';
import { ModelInvocationError, isTransientModelError } from '@jarvus/claude-assist-core';
import { createInvoker, extractTag } from './invoker.js';
import { createBudgetTracker } from './budget.js';
import { DEFAULT_PRICES, DEFAULT_TIER_MODELS, estimateCostMicros } from './models.js';
import type { InvocationRow, SpendStorePort } from './store.js';
import type { MessagesClient, ProviderRequest, ProviderResponse } from './provider.js';

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

class MemoryStore implements SpendStorePort {
  readonly rows: InvocationRow[] = [];
  async record(row: InvocationRow) {
    this.rows.push(row);
  }
  async totalsSince() {
    const rows = this.rows;
    return {
      calls: rows.length,
      tokens: rows.reduce(
        (n, r) => n + r.inputTokens + r.outputTokens + r.cacheWriteTokens + r.cacheReadTokens,
        0,
      ),
      costMicros: rows.reduce((n, r) => n + r.costMicros, 0),
    };
  }
  async taskTotalsSince() {
    const byTask = new Map<string, { calls: number; tokens: number; micros: number }>();
    for (const r of this.rows) {
      const entry = byTask.get(r.task) ?? { calls: 0, tokens: 0, micros: 0 };
      entry.calls += 1;
      entry.tokens += r.inputTokens + r.outputTokens;
      entry.micros += r.costMicros;
      byTask.set(r.task, entry);
    }
    return [...byTask].map(([task, v]) => ({
      task,
      calls: v.calls,
      tokens: v.tokens,
      costUsd: v.micros / 1_000_000,
    }));
  }
}

function reply(text: string, usage?: Partial<ProviderResponse['usage']>): ProviderResponse {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50, ...usage },
  };
}

/** Scripted provider: each entry is a response to return or an error to throw. */
function scriptedClient(script: Array<ProviderResponse | Error>) {
  const seen: ProviderRequest[] = [];
  let i = 0;
  const client: MessagesClient = {
    async create(request) {
      seen.push(request);
      const next = script[Math.min(i, script.length - 1)];
      i++;
      if (next instanceof Error) throw next;
      return next!;
    },
  };
  return { client, seen, get calls() { return i; } };
}

function setup(script: Array<ProviderResponse | Error>, overrides: Record<string, unknown> = {}) {
  const store = new MemoryStore();
  const limits = (overrides['limits'] as Record<string, unknown>) ?? {};
  const budget = createBudgetTracker({ store, limits });
  const scripted = scriptedClient(script);
  const invoker = createInvoker({
    log: silentLog,
    store,
    budget,
    limits,
    tierModels: DEFAULT_TIER_MODELS,
    prices: DEFAULT_PRICES,
    client: scripted.client,
    retryBaseMs: 0,
    sleep: async () => {},
    ...overrides,
  } as never);
  return { store, budget, invoker, scripted };
}

const base = { task: 'test.classify', tier: 'classify' as const, maxTokens: 256 };

describe('extractTag', () => {
  it('pulls a tagged block out of surrounding prose', () => {
    expect(extractTag('sure thing\n<verdict>{"a":1}</verdict>\nhope that helps', 'verdict')).toBe(
      '{"a":1}',
    );
  });

  it('returns null when the tag is absent', () => {
    expect(extractTag('no tags here', 'verdict')).toBeNull();
  });
});

describe('invoke', () => {
  it('resolves the model from the tier, never from the call site', async () => {
    const { invoker, scripted } = setup([reply('ok')]);
    const result = await invoker.invoke({ ...base, messages: [{ role: 'user', content: 'hi' }] });

    expect(result.model).toBe(DEFAULT_TIER_MODELS.classify);
    expect(scripted.seen[0]!.model).toBe(DEFAULT_TIER_MODELS.classify);
    expect(invoker.modelFor('synthesize')).toBe(DEFAULT_TIER_MODELS.synthesize);
  });

  it('records tokens and an estimated cost for every call', async () => {
    const { invoker, store } = setup([
      reply('ok', { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 400 }),
    ]);
    const result = await invoker.invoke({ ...base, messages: [{ role: 'user', content: 'hi' }] });

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.outcome).toBe('succeeded');
    expect(store.rows[0]!.cacheReadTokens).toBe(400);
    expect(result.usage.costUsd).toBeGreaterThan(0);
    expect(result.usage.costUsd).toBeCloseTo(
      estimateCostMicros(
        DEFAULT_TIER_MODELS.classify,
        { inputTokens: 1000, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 400 },
        DEFAULT_PRICES,
      ) / 1_000_000,
      9,
    );
  });

  it('retries a 529 with backoff and records every attempt', async () => {
    const overloaded = Object.assign(new Error('overloaded'), { status: 529 });
    const { invoker, store, scripted } = setup([overloaded, reply('recovered')]);

    const result = await invoker.invoke({ ...base, messages: [{ role: 'user', content: 'hi' }] });

    expect(result.text).toBe('recovered');
    expect(result.attempts).toBe(2);
    expect(scripted.calls).toBe(2);
    expect(store.rows.map((r) => r.outcome)).toEqual(['failed', 'succeeded']);
  });

  it('never burns a second attempt on a terminal error', async () => {
    const badRequest = Object.assign(new Error('bad request'), { status: 400 });
    const { invoker, scripted } = setup([badRequest]);

    await expect(
      invoker.invoke({ ...base, messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ reason: 'invalid_request', retryable: false });
    expect(scripted.calls).toBe(1);
  });

  it('treats a refusal as terminal rather than retrying an identical request', async () => {
    const refused: ProviderResponse = {
      content: [],
      stop_reason: 'refusal',
      usage: { input_tokens: 10, output_tokens: 0 },
    };
    const { invoker, scripted } = setup([refused, reply('never reached')]);

    await expect(
      invoker.invoke({ ...base, messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ reason: 'refusal' });
    expect(scripted.calls).toBe(1);
  });

  it('places a cache breakpoint only on a system prompt long enough to earn one', async () => {
    const { invoker, scripted } = setup([reply('a'), reply('b')]);
    await invoker.invoke({
      ...base,
      system: 'short',
      cacheSystem: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    await invoker.invoke({
      ...base,
      system: 'x'.repeat(20_000),
      cacheSystem: true,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(typeof scripted.seen[0]!.system).toBe('string');
    expect(scripted.seen[1]!.system).toEqual([
      { type: 'text', text: 'x'.repeat(20_000), cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('normalizes image blocks for the vision tier', async () => {
    const { invoker, scripted } = setup([reply('ok')]);
    await invoker.invoke({
      task: 'test.vision',
      tier: 'vision',
      maxTokens: 512,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', data: 'BASE64', mediaType: 'image/jpg' },
            { type: 'text', text: 'what is this' },
          ],
        },
      ],
    });

    expect(scripted.seen[0]!.messages[0]!.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BASE64' } },
      { type: 'text', text: 'what is this' },
    ]);
  });
});

describe('invokeTagged', () => {
  it('parses a tagged answer', async () => {
    const { invoker } = setup([reply('<verdict>{"urgent":true}</verdict>')]);
    const parsed = await invoker.invokeTagged<{ urgent: boolean }>({
      ...base,
      tag: 'verdict',
      parse: (raw) => JSON.parse(raw) as { urgent: boolean },
      messages: [{ role: 'user', content: 'is this urgent' }],
    });
    expect(parsed).toEqual({ urgent: true });
  });

  it('appends one correction turn and succeeds on the retry', async () => {
    const { invoker, scripted } = setup([reply('sorry, no tags'), reply('<verdict>{"ok":1}</verdict>')]);
    const parsed = await invoker.invokeTagged<{ ok: number }>({
      ...base,
      tag: 'verdict',
      parse: (raw) => JSON.parse(raw) as { ok: number },
      messages: [{ role: 'user', content: 'go' }],
    });

    expect(parsed).toEqual({ ok: 1 });
    expect(scripted.calls).toBe(2);
    const second = scripted.seen[1]!.messages;
    expect(second).toHaveLength(3);
    expect(second[1]!.role).toBe('assistant');
    expect(String(second[2]!.content)).toContain('<error>Parse failed');
  });

  it('gives up after the correction turn rather than looping', async () => {
    const { invoker, scripted } = setup([reply('still no tags')]);
    await expect(
      invoker.invokeTagged({
        ...base,
        tag: 'verdict',
        parse: (raw) => JSON.parse(raw) as unknown,
        messages: [{ role: 'user', content: 'go' }],
      }),
    ).rejects.toMatchObject({ reason: 'parse_failed' });
    expect(scripted.calls).toBe(2);
  });
});

describe('budgets, kill switch, and degradation', () => {
  it('is disabled with no credential and fails transiently', async () => {
    const store = new MemoryStore();
    const invoker = createInvoker({
      log: silentLog,
      store,
      budget: createBudgetTracker({ store, limits: {} }),
      limits: {},
      tierModels: DEFAULT_TIER_MODELS,
      prices: DEFAULT_PRICES,
    });

    expect(invoker.enabled).toBe(false);
    const err = await invoker
      .invoke({ ...base, messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelInvocationError);
    expect(isTransientModelError(err)).toBe(true);
  });

  it('stops all invocation under the kill switch, transiently', async () => {
    const { invoker, scripted } = setup([reply('never')], { killSwitch: true });
    expect(invoker.enabled).toBe(false);
    const err = await invoker
      .invoke({ ...base, messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e);
    expect(isTransientModelError(err)).toBe(true);
    expect(scripted.calls).toBe(0);
  });

  it('fails transiently once the dollar ceiling is reached', async () => {
    const { invoker, budget } = setup([reply('ok')], { limits: { dailyUsd: 0.000001 } });
    budget.add('test.classify', 1_000_000, 5_000_000); // $5 already spent

    const err = await invoker
      .invoke({ ...base, messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'budget_exceeded' });
    expect(isTransientModelError(err)).toBe(true);
  });

  it('raises exactly one approval per window and resumes once it is granted', async () => {
    const requests: Array<Record<string, unknown>> = [];
    let resolved: { status: string; resolution: { params: { overageUsd: number } } } | null = null;
    const approvals = {
      request: async (input: Record<string, unknown>) => {
        requests.push(input);
        return { id: 'a1', status: 'pending' } as never;
      },
      findResolved: async () => resolved as never,
      get: async () => null,
      list: async () => [],
      resolve: async () => ({}) as never,
    };

    const { invoker, budget } = setup([reply('ok')], {
      limits: { dailyUsd: 1 },
      approvals,
    });
    budget.add('test.classify', 100, 2_000_000); // $2 spent against a $1 ceiling

    await expect(
      invoker.invoke({ ...base, messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ reason: 'budget_exceeded' });
    await expect(
      invoker.invoke({ ...base, messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ reason: 'budget_exceeded' });

    // Two breaches, one request — the dedupe key is doing its job.
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((r) => r['dedupeKey'])).size).toBe(1);
    expect(requests[0]!['kind']).toBe('model_budget_overage');

    resolved = { status: 'approved', resolution: { params: { overageUsd: 10 } } };
    const result = await invoker.invoke({ ...base, messages: [{ role: 'user', content: 'hi' }] });
    expect(result.text).toBe('ok');
  });

  it('reports window totals and a per-task breakdown', async () => {
    const { invoker } = setup([reply('ok'), reply('ok')]);
    await invoker.invoke({ ...base, messages: [{ role: 'user', content: 'a' }] });
    await invoker.invoke({
      task: 'other.task',
      tier: 'extract',
      maxTokens: 128,
      messages: [{ role: 'user', content: 'b' }],
    });

    const snapshot = await invoker.spend();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.calls).toBe(2);
    expect(snapshot.byTask.map((t) => t.task).sort()).toEqual(['other.task', 'test.classify']);
    expect(snapshot.models.classify).toBe(DEFAULT_TIER_MODELS.classify);
  });
});
