/**
 * Route-level coverage for the worksheet response pattern + cook mode
 * (specs/modules/pages.md § The worksheet response pattern, § Cook mode).
 *
 * The cook sink is a recording fake here: the pages module knows the seam only
 * through the core-owned request/outcome types, so a fake exercises exactly the
 * contract the kitchen module implements. Kitchen's own half is covered in
 * packages/kitchen/src/services/cook-mode.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type {
  NotifyDispatcher,
  NotifyInput,
  NotifyResult,
  WorksheetCookOutcome,
  WorksheetCookRequest,
  WorksheetCookSink,
} from '@jarvus/claude-assist-core';
import { MemoryPagesStore } from '../memory-store.js';
import { registerPagesApiRoutes } from './api.js';

function fakeNotify(): { dispatcher: NotifyDispatcher; sent: NotifyInput[] } {
  const sent: NotifyInput[] = [];
  let id = 0;
  return {
    sent,
    dispatcher: {
      async notify(input: NotifyInput): Promise<NotifyResult> {
        sent.push(input);
        return { id: ++id, priority: input.priority, deliveredVia: ['pushover'], status: 'sent' };
      },
    },
  };
}

/**
 * A sink that behaves like the real one: keyed on the request's ULID, so a
 * replay reports `created: false` and writes nothing a second time.
 */
function fakeSink(options: { fail?: Error } = {}): {
  sink: WorksheetCookSink;
  calls: WorksheetCookRequest[];
  written: Map<string, WorksheetCookOutcome>;
} {
  const calls: WorksheetCookRequest[] = [];
  const written = new Map<string, WorksheetCookOutcome>();
  const sink: WorksheetCookSink = {
    async cook(request) {
      calls.push(request);
      if (options.fail) throw options.fail;
      const existing = written.get(request.ulid);
      if (existing) return { ...existing, created: false };
      const outcome: WorksheetCookOutcome = {
        kind: request.disposition === 'eaten' ? 'entry' : 'item',
        ulid: request.ulid,
        created: true,
      };
      written.set(request.ulid, outcome);
      return outcome;
    },
  };
  return { sink, calls, written };
}

const KEY = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_KEY = '01JZZZZZZZZZZZZZZZZZZZZZZZ';

function worksheet(cookMode?: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'worksheet',
    version: 1,
    heading: 'Prep — grain bowl',
    fields: [
      { key: 'calories', label: 'Calories', precision: 0 },
      { key: 'protein_g', label: 'Protein', unit: 'g', precision: 1 },
    ],
    components: [
      { label: 'cooked grain', quantity: 200, per_basis: { calories: 130, protein_g: 4.5 } },
      { label: 'dressing', quantity: 30, per_basis: { calories: 400, protein_g: 0 } },
    ],
    steps: ['Roast at 425 °F.'],
    ...(cookMode ? { cook_mode: cookMode } : {}),
  };
}

function submission(key = KEY, quantities: { label: string; quantity: number }[] = []) {
  return { payload: { kind: 'worksheet', version: 1, submission_key: key, quantities } };
}

describe('worksheet publish + collect', () => {
  let fastify: FastifyInstance;
  let store: MemoryPagesStore;
  let notify: ReturnType<typeof fakeNotify>;
  let sink: ReturnType<typeof fakeSink>;

  async function boot(cookSink?: WorksheetCookSink) {
    fastify = Fastify({ logger: false });
    store = new MemoryPagesStore();
    notify = fakeNotify();
    fastify.decorate('notify', notify.dispatcher);
    await fastify.register(registerPagesApiRoutes, { store, worksheetCookSink: cookSink });
    await fastify.ready();
  }

  beforeEach(async () => {
    sink = fakeSink();
    await boot(sink.sink);
  });

  afterEach(async () => {
    await fastify.close();
  });

  describe('POST /pages with a worksheet', () => {
    it('renders the worksheet and retains its definition on the version', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'grain-bowl-prep', title: 'Prep — grain bowl', worksheet: worksheet() },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ worksheet: true, cook_mode: null });

      const current = await store.getCurrent('grain-bowl-prep');
      expect(current?.worksheet?.kind).toBe('worksheet');
      expect(current?.html).toContain('data-pw-label="cooked grain"');
      expect(current?.html).toContain('425 °F');
    });

    it('reports the declared cook mode back to the publisher', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: {
          slug: 'grain-bowl-prep',
          title: 'Prep',
          worksheet: worksheet({ disposition: 'packed', label: 'grain bowl jars', units: 3 }),
        },
      });
      expect(response.json().cook_mode).toBe('packed');
    });

    it('rejects a body carrying both html and a worksheet', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'p', title: 'P', html: '<p/>', worksheet: worksheet() },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/exactly one of html or worksheet/);
    });

    it('rejects a body carrying neither', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'p', title: 'P' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a malformed worksheet definition, naming the path', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: {
          slug: 'p',
          title: 'P',
          worksheet: {
            kind: 'worksheet',
            version: 1,
            fields: [{ key: 'calories', label: 'Calories' }],
            components: [{ label: 'x', quantity: 1, per_basis: { sodium_mg: 4 } }],
          },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/per_basis\.sodium_mg/);
    });

    it('a republish as plain HTML clears the worksheet on the new version', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'p', title: 'P', worksheet: worksheet() },
      });
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'p', title: 'P', html: '<p>static now</p>' },
      });
      expect((await store.getCurrent('p'))?.worksheet).toBeNull();
    });
  });

  describe('POST /pages/:slug/responses — worksheet submission', () => {
    beforeEach(async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'grain-bowl-prep', title: 'Prep', worksheet: worksheet() },
      });
    });

    it('computes the totals server-side and stores the normalized payload', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(KEY, [{ label: 'cooked grain', quantity: 187 }]),
      });

      expect(response.statusCode).toBe(201);
      // 1.87 × 130 = 243.1, + 0.30 × 400 = 120 → 363.1 → 363 cal
      // 1.87 × 4.5 = 8.415, + 0            → 8.4 g protein
      expect(response.json().worksheet.totals).toEqual({ calories: 363, protein_g: 8.4 });

      const stored = store.responses.at(-1)!;
      expect(stored.payload).toMatchObject({
        kind: 'worksheet',
        submission_key: KEY,
        totals: { calories: 363, protein_g: 8.4 },
      });
      // The stored record carries the references it was computed against, so a
      // consumer never has to re-resolve the definition.
      expect((stored.payload as { components: unknown[] }).components).toHaveLength(2);
    });

    it('derives a readable note (and therefore notify body) from the totals', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(),
      });
      expect(store.responses.at(-1)!.note).toBe('Prep — grain bowl: Calories 380, Protein 9 g');
      expect(notify.sent.at(-1)!.body).toBe('Prep — grain bowl: Calories 380, Protein 9 g');
    });

    it('rejects a malformed submission and appends NOTHING', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: { payload: { kind: 'worksheet', version: 1, submission_key: 'nope', quantities: [] } },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/submission_key/);
      expect(store.responses).toHaveLength(0);
    });

    it('rejects a submission naming a component the worksheet never declared', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(KEY, [{ label: 'bacon', quantity: 40 }]),
      });
      expect(response.statusCode).toBe(400);
      expect(store.responses).toHaveLength(0);
    });

    it('leaves a free-form payload on a worksheet page untouched', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: { payload: { kind: 'comment', text: 'looks right' }, note: 'a note' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().worksheet).toBeUndefined();
      expect(store.responses.at(-1)!.payload).toEqual({ kind: 'comment', text: 'looks right' });
    });

    it('leaves a worksheet-shaped payload on a NON-worksheet page untouched', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'plain', title: 'Plain', html: '<p/>' },
      });
      const response = await fastify.inject({
        method: 'POST',
        url: '/pages/plain/responses',
        payload: submission(),
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().worksheet).toBeUndefined();
    });
  });

  describe('cook mode — eaten', () => {
    beforeEach(async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: {
          slug: 'grain-bowl-prep',
          title: 'Prep',
          worksheet: worksheet({ disposition: 'eaten', label: 'grain bowl' }),
        },
      });
    });

    it('logs on submit and reports what was written', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(),
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().worksheet.cook_mode).toEqual({
        disposition: 'eaten',
        status: 'logged',
        kind: 'entry',
        ulid: KEY,
        created: true,
        error: null,
      });
      expect(sink.calls).toHaveLength(1);
      expect(sink.calls[0]).toMatchObject({
        ulid: KEY,
        disposition: 'eaten',
        label: 'grain bowl',
        unit: 'g',
        totals: { calories: 380, protein_g: 9 },
      });
      // An eaten sheet never carries conversion details.
      expect(sink.calls[0]!.packed).toBeUndefined();
    });

    it('marks the response processed — the loop is already closed', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(),
      });
      const stored = store.responses.at(-1)!;
      expect(stored.processedBy).toBe(`cook-mode:entry:${KEY}`);
      expect(stored.processedAt).not.toBeNull();

      // …so it is not in the backlog an agent works through.
      const summary = (await store.listPages())[0]!;
      expect(summary.unprocessedCount).toBe(0);
      expect(summary.responseCount).toBe(1);
    });
  });

  describe('cook mode — packed', () => {
    beforeEach(async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: {
          slug: 'grain-bowl-prep',
          title: 'Prep',
          worksheet: worksheet({
            disposition: 'packed',
            label: 'grain bowl jars',
            units: 3,
            shelf_life_class: 'prepared',
            recipe_ulid: '01JBBBBBBBBBBBBBBBBBBBBBBB',
            sources: [{ item_ulid: '01JCCCCCCCCCCCCCCCCCCCCCCC', amount: 0.5 }],
          }),
        },
      });
    });

    it('records a conversion, not a journal entry', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(),
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().worksheet.cook_mode).toMatchObject({
        disposition: 'packed',
        status: 'logged',
        kind: 'item',
        ulid: KEY,
      });
      expect(sink.calls[0]).toMatchObject({
        disposition: 'packed',
        label: 'grain bowl jars',
        packed: {
          units: 3,
          shelf_life_class: 'prepared',
          recipe_ulid: '01JBBBBBBBBBBBBBBBBBBBBBBB',
          sources: [{ item_ulid: '01JCCCCCCCCCCCCCCCCCCCCCCC', amount: 0.5 }],
        },
      });
      expect(store.responses.at(-1)!.processedBy).toBe(`cook-mode:item:${KEY}`);
    });
  });

  describe('idempotency', () => {
    beforeEach(async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: {
          slug: 'grain-bowl-prep',
          title: 'Prep',
          worksheet: worksheet({ disposition: 'eaten', label: 'grain bowl' }),
        },
      });
    });

    it('a resubmission with the same key neither double-logs nor double-decrements', async () => {
      const first = await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(),
      });
      const second = await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(),
      });

      expect(first.json().worksheet.cook_mode.status).toBe('logged');
      expect(second.statusCode).toBe(201);
      expect(second.json().worksheet.cook_mode).toMatchObject({
        status: 'already-logged',
        created: false,
        ulid: KEY,
      });
      // ONE row written, addressed by the one key.
      expect(sink.written.size).toBe(1);
    });

    it('appends the resubmission to history rather than mutating the first', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(KEY, [{ label: 'cooked grain', quantity: 200 }]),
      });
      await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(KEY, [{ label: 'cooked grain', quantity: 180 }]),
      });

      // Responses are append-only: two rows, the first untouched.
      expect(store.responses).toHaveLength(2);
      expect((store.responses[0]!.payload as { components: { quantity: number }[] }).components[0]!.quantity).toBe(200);
      expect((store.responses[1]!.payload as { components: { quantity: number }[] }).components[0]!.quantity).toBe(180);
      expect(store.responses.every((r) => r.processedAt !== null)).toBe(true);
    });

    it('a deliberate second submission under a NEW key is a second write', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(KEY),
      });
      const second = await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(OTHER_KEY),
      });
      expect(second.json().worksheet.cook_mode.status).toBe('logged');
      expect(sink.written.size).toBe(2);
    });
  });

  describe('failure paths', () => {
    const publishEaten = async () =>
      fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: {
          slug: 'grain-bowl-prep',
          title: 'Prep',
          worksheet: worksheet({ disposition: 'eaten', label: 'grain bowl' }),
        },
      });

    it('a failed cook-mode write keeps the submitted numbers but says 502', async () => {
      await fastify.close();
      const failing = fakeSink({ fail: new Error('journal unreachable') });
      await boot(failing.sink);
      await publishEaten();

      const response = await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(KEY, [{ label: 'cooked grain', quantity: 187 }]),
      });

      // The submitter is told plainly that nothing was logged…
      expect(response.statusCode).toBe(502);
      expect(response.json().worksheet.cook_mode).toMatchObject({
        status: 'failed',
        created: false,
        error: 'journal unreachable',
      });
      expect(response.json().error).toBe('journal unreachable');

      // …while the numbers ARE durable, and the row sits UNPROCESSED — the same
      // backlog signal that existed before cook mode, so an agent can recover it.
      const stored = store.responses.at(-1)!;
      expect((stored.payload as { totals: unknown }).totals).toEqual({ calories: 363, protein_g: 8.4 });
      expect(stored.processedAt).toBeNull();
      expect((await store.listPages())[0]!.unprocessedCount).toBe(1);
    });

    it('notifies at notice priority on failure even for a digest-opted page', async () => {
      await fastify.close();
      const failing = fakeSink({ fail: new Error('journal unreachable') });
      await boot(failing.sink);
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: {
          slug: 'grain-bowl-prep',
          title: 'Prep',
          digest_optin: true,
          worksheet: worksheet({ disposition: 'eaten', label: 'grain bowl' }),
        },
      });

      await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(),
      });

      expect(notify.sent.at(-1)).toMatchObject({ priority: 'notice' });
      expect(notify.sent.at(-1)!.body).toMatch(/NOT recorded/);
    });

    it('a retry after a failure, same key, succeeds exactly once', async () => {
      await fastify.close();
      // A sink that fails the first call and behaves normally afterwards.
      const flaky = fakeSink();
      let firstCall = true;
      const wrapped: WorksheetCookSink = {
        async cook(request) {
          if (firstCall) {
            firstCall = false;
            throw new Error('network dropped');
          }
          return flaky.sink.cook(request);
        },
      };
      await boot(wrapped);
      await publishEaten();

      const failed = await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(KEY),
      });
      const retried = await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(KEY),
      });

      expect(failed.statusCode).toBe(502);
      expect(retried.statusCode).toBe(201);
      expect(retried.json().worksheet.cook_mode).toMatchObject({ status: 'logged', created: true });
      expect(flaky.written.size).toBe(1);
      // Both attempts are in history; only the successful one is processed.
      expect(store.responses.map((r) => r.processedAt === null)).toEqual([true, false]);
    });

    it('503s when no cook sink is wired instead of pretending it logged', async () => {
      await fastify.close();
      await boot(undefined);
      await publishEaten();

      const response = await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(),
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().worksheet.cook_mode).toMatchObject({
        status: 'unavailable',
        kind: null,
        created: false,
      });
      expect(store.responses.at(-1)!.processedAt).toBeNull();
    });

    it('a worksheet with no cook mode still just queues, at 201', async () => {
      await fastify.close();
      await boot(undefined);
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'grain-bowl-prep', title: 'Prep', worksheet: worksheet() },
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/pages/grain-bowl-prep/responses',
        payload: submission(),
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().worksheet.cook_mode).toBeNull();
      expect(store.responses.at(-1)!.processedAt).toBeNull();
    });
  });
});
