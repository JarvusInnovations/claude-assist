import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import { MemoryCaptureStore } from '../memory-store.js';
import { normalizeInput } from '../store.js';
import { destinationFor, transition } from '../state.js';
import { CaptureRouter, type RoutingExecutor } from './router.js';
import { CapturePipeline } from './pipeline.js';
import { HoldExecutor } from './executors/hold.js';
import { generateUlid } from '../ulid.js';
import type { CaptureRecord, CaptureType } from '../types.js';

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => log,
  level: 'silent',
} as unknown as FastifyBaseLogger;

class FakeWriteExecutor implements RoutingExecutor {
  readonly kind = 'write' as const;
  calls: CaptureRecord[] = [];
  failuresRemaining: number;

  constructor(
    readonly destination: string,
    { failures = 0 }: { failures?: number } = {}
  ) {
    this.failuresRemaining = failures;
  }

  async execute(capture: CaptureRecord): Promise<Record<string, unknown>> {
    this.calls.push(capture);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new Error('synthetic executor failure');
    }
    return { ok: true, ulid: capture.ulid };
  }
}

async function seedClassified(
  store: MemoryCaptureStore,
  type: CaptureType,
  text = 'seed'
): Promise<CaptureRecord> {
  const { record } = await store.insertIfAbsent(
    normalizeInput({ ulid: generateUlid(), text, source: 'terminal' })
  );
  const destination = destinationFor(type);
  await store.applyClassification(
    record.ulid,
    { type, confidence: 0.9, title: null, rationale: 'test', classifier: 'model' },
    destination,
    transition(record.status, { kind: 'classified', destination })
  );
  return (await store.get(record.ulid))!;
}

describe('CaptureRouter', () => {
  it('routes a write destination to routed only after the write succeeds', async () => {
    const store = new MemoryCaptureStore();
    const router = new CaptureRouter(store, log);
    const executor = new FakeWriteExecutor('tana-inbox');
    router.register(executor);

    const capture = await seedClassified(store, 'stray_thought');
    const status = await router.route(capture);

    expect(status).toBe('routed');
    expect(executor.calls).toHaveLength(1);
    const stored = (await store.get(capture.ulid))!;
    expect(stored.status).toBe('routed');
    expect(stored.routed_at).not.toBeNull();
    expect(stored.route_result).toEqual({ ok: true, ulid: capture.ulid });
  });

  it('keeps a failing capture in classified and retries until success', async () => {
    const store = new MemoryCaptureStore();
    const router = new CaptureRouter(store, log);
    const executor = new FakeWriteExecutor('tana-inbox', { failures: 2 });
    router.register(executor);

    const capture = await seedClassified(store, 'stray_thought');

    // Two failing sweeps: status unchanged, attempts accumulate
    for (const expectedAttempts of [1, 2]) {
      const [selected] = await store.selectForRouting(10, CapturePipeline.MAX_ATTEMPTS);
      expect(selected!.ulid).toBe(capture.ulid);
      const status = await router.route(selected!);
      expect(status).toBe('classified');
      const stored = (await store.get(capture.ulid))!;
      expect(stored.status).toBe('classified');
      expect(stored.route_attempts).toBe(expectedAttempts);
      expect(stored.last_error).toBe('synthetic executor failure');
    }

    // Third sweep succeeds and clears the error
    const [selected] = await store.selectForRouting(10, CapturePipeline.MAX_ATTEMPTS);
    expect(await router.route(selected!)).toBe('routed');
    const stored = (await store.get(capture.ulid))!;
    expect(stored.status).toBe('routed');
    expect(stored.last_error).toBeNull();
  });

  it('stops selecting a capture once route attempts hit the cap', async () => {
    const store = new MemoryCaptureStore();
    const router = new CaptureRouter(store, log);
    router.register(new FakeWriteExecutor('tana-inbox', { failures: 99 }));

    const capture = await seedClassified(store, 'stray_thought');
    for (let i = 0; i < CapturePipeline.MAX_ATTEMPTS; i++) {
      const [selected] = await store.selectForRouting(10, CapturePipeline.MAX_ATTEMPTS);
      await router.route(selected!);
    }

    expect(await store.selectForRouting(10, CapturePipeline.MAX_ATTEMPTS)).toHaveLength(0);
    expect(((await store.get(capture.ulid))!).status).toBe('classified'); // state preserved
  });

  it('parks captures in awaiting_executor when the destination has no executor, without burning attempts', async () => {
    const store = new MemoryCaptureStore();
    const router = new CaptureRouter(store, log); // nothing registered

    const capture = await seedClassified(store, 'stray_thought');
    expect(await router.route(capture)).toBe('awaiting_executor');

    const stored = (await store.get(capture.ulid))!;
    expect(stored.status).toBe('awaiting_executor');
    expect(stored.route_attempts).toBe(0);

    // Still selectable; routes as soon as the executor appears
    const executor = new FakeWriteExecutor('tana-inbox');
    router.register(executor);
    const [selected] = await store.selectForRouting(10, CapturePipeline.MAX_ATTEMPTS);
    expect(await router.route(selected!)).toBe('routed');
  });

  it('holds actionable and team_relevant in awaiting_review and never invokes a write (firewall)', async () => {
    const store = new MemoryCaptureStore();
    const router = new CaptureRouter(store, log);
    const hold = new HoldExecutor();
    router.register(hold);
    const tana = new FakeWriteExecutor('tana-inbox');
    const references = new FakeWriteExecutor('references');
    router.register(tana);
    router.register(references);

    for (const type of ['actionable', 'team_relevant'] as CaptureType[]) {
      const capture = await seedClassified(store, type, `${type} capture`);
      expect(await router.route(capture)).toBe('awaiting_review');
      const stored = (await store.get(capture.ulid))!;
      expect(stored.status).toBe('awaiting_review');
      expect(stored.route_result).toMatchObject({ held_by: 'review' });
    }

    // The hold path never touched a write executor
    expect(tana.calls).toHaveLength(0);
    expect(references.calls).toHaveLength(0);

    // Held rows are terminal for the sweep: not selectable for routing
    expect(await store.selectForRouting(10, CapturePipeline.MAX_ATTEMPTS)).toHaveLength(0);
  });

  it('HoldExecutor.execute throws if ever invoked directly', async () => {
    await expect(new HoldExecutor().execute()).rejects.toThrow(
      'HoldExecutor.execute must never be invoked'
    );
  });
});

describe('CapturePipeline.correct', () => {
  it('re-routes a held capture to the corrected destination', async () => {
    const store = new MemoryCaptureStore();
    const router = new CaptureRouter(store, log);
    router.register(new HoldExecutor());
    const tana = new FakeWriteExecutor('tana-inbox');
    router.register(tana);
    const pipeline = new CapturePipeline(store, null, router, log);

    const capture = await seedClassified(store, 'actionable');
    await router.route(capture); // → awaiting_review

    const corrected = await pipeline.correct(capture.ulid, 'stray_thought');
    expect(corrected!.status).toBe('routed');
    expect(corrected!.route_destination).toBe('tana-inbox');
    expect(corrected!.classification!.classifier).toBe('correction');
    expect(corrected!.classification!.rationale).toContain('was: actionable');
    expect(tana.calls).toHaveLength(1);
  });

  it('corrects a routed capture into a hold (and back out)', async () => {
    const store = new MemoryCaptureStore();
    const router = new CaptureRouter(store, log);
    router.register(new HoldExecutor());
    router.register(new FakeWriteExecutor('tana-inbox'));
    const pipeline = new CapturePipeline(store, null, router, log);

    const capture = await seedClassified(store, 'stray_thought');
    await router.route(capture); // → routed

    const held = await pipeline.correct(capture.ulid, 'team_relevant');
    expect(held!.status).toBe('awaiting_review');
    expect(held!.route_destination).toBe('review');
  });

  it('returns null for an unknown ulid', async () => {
    const store = new MemoryCaptureStore();
    const pipeline = new CapturePipeline(store, null, new CaptureRouter(store, log), log);
    expect(await pipeline.correct(generateUlid(), 'stray_thought')).toBeNull();
  });
});
