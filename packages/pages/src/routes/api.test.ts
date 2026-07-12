import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { NotifyDispatcher, NotifyInput, NotifyResult } from '@jarvus/claude-assist-core';
import { MemoryPagesStore } from '../memory-store.js';
import { registerPagesApiRoutes, formatResponseNotifyBody } from './api.js';

/** Recording fake dispatcher, mirroring the briefing module's test pattern. */
function fakeNotify(): { dispatcher: NotifyDispatcher; sent: NotifyInput[] } {
  const sent: NotifyInput[] = [];
  let id = 0;
  const dispatcher: NotifyDispatcher = {
    async notify(input: NotifyInput): Promise<NotifyResult> {
      sent.push(input);
      return { id: ++id, priority: input.priority, deliveredVia: ['pushover'], status: 'sent' };
    },
  };
  return { dispatcher, sent };
}

describe('pages API routes', () => {
  let fastify: FastifyInstance;
  let store: MemoryPagesStore;
  let notify: ReturnType<typeof fakeNotify>;

  beforeEach(async () => {
    fastify = Fastify({ logger: false });
    store = new MemoryPagesStore();
    notify = fakeNotify();
    fastify.decorate('notify', notify.dispatcher);
    await fastify.register(registerPagesApiRoutes, { store });
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  describe('POST /pages (publish)', () => {
    it('publishes a new slug and returns a stable URL', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'my-page', title: 'My Page', html: '<html>hi</html>' },
      });

      expect(response.statusCode).toBe(201);
      const json = response.json();
      expect(json).toMatchObject({ slug: 'my-page', title: 'My Page', created: true });
      expect(json.url).toContain('/pages/my-page');
    });

    it('republishing the same slug creates a new version, not a new page', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'my-page', title: 'My Page', html: '<html>v1</html>' },
      });
      const republish = await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'my-page', title: 'My Page v2', html: '<html>v2</html>' },
      });

      expect(republish.statusCode).toBe(200); // not 201 - not newly created
      expect(republish.json()).toMatchObject({ slug: 'my-page', created: false });

      const current = await store.getCurrent('my-page');
      expect(current?.html).toBe('<html>v2</html>');
    });

    it.each([
      ['missing slug', { title: 't', html: '<h/>' }],
      ['invalid slug', { slug: 'Not Valid!', title: 't', html: '<h/>' }],
      ['missing title', { slug: 'x', html: '<h/>' }],
      ['missing html', { slug: 'x', title: 't' }],
      ['empty html', { slug: 'x', title: 't', html: '' }],
    ])('rejects %s with 400', async (_label, payload) => {
      const response = await fastify.inject({ method: 'POST', url: '/pages', payload });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /pages (JSON index)', () => {
    it('lists active pages with urls and excludes archived ones', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'active-page', title: 'Active', html: '<html/>' },
      });
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'gone-page', title: 'Gone', html: '<html/>' },
      });
      await fastify.inject({ method: 'POST', url: '/pages/gone-page/archive' });

      const response = await fastify.inject({ method: 'GET', url: '/pages' });
      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.count).toBe(1);
      expect(json.pages[0]).toMatchObject({ slug: 'active-page', title: 'Active' });
      expect(json.pages[0].url).toContain('/pages/active-page');
    });
  });

  describe('POST /pages/:slug/responses', () => {
    it('appends a response and dispatches a notice-priority notify', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'p', title: 'A decision page', html: '<html/>' },
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/pages/p/responses',
        payload: { payload: { choice: 'approve' }, anchor: '#row-3', note: 'looks good' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ payload: { choice: 'approve' }, anchor: '#row-3' });

      expect(notify.sent).toHaveLength(1);
      expect(notify.sent[0]).toMatchObject({
        priority: 'notice',
        title: 'A decision page',
        body: 'looks good',
      });
      expect(notify.sent[0]!.url).toContain('/pages/p');
    });

    it('dispatches at digest priority when the page opted in', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'p', title: 'P', html: '<html/>', digest_optin: true },
      });
      await fastify.inject({
        method: 'POST',
        url: '/pages/p/responses',
        payload: { payload: {} },
      });

      expect(notify.sent[0]!.priority).toBe('digest');
    });

    it('404s for an unpublished slug', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/pages/missing/responses',
        payload: { payload: {} },
      });
      expect(response.statusCode).toBe(404);
      expect(notify.sent).toHaveLength(0);
    });

    it('rejects a body without payload', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'p', title: 'P', html: '<html/>' },
      });
      const response = await fastify.inject({
        method: 'POST',
        url: '/pages/p/responses',
        payload: { anchor: '#x' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /pages/:slug/responses', () => {
    beforeEach(async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'p', title: 'P', html: '<html/>' },
      });
    });

    it('lists responses oldest-first', async () => {
      await fastify.inject({ method: 'POST', url: '/pages/p/responses', payload: { payload: { n: 1 } } });
      await fastify.inject({ method: 'POST', url: '/pages/p/responses', payload: { payload: { n: 2 } } });

      const response = await fastify.inject({ method: 'GET', url: '/pages/p/responses' });
      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.count).toBe(2);
      expect(json.responses.map((r: { payload: { n: number } }) => r.payload.n)).toEqual([1, 2]);
    });

    it('filters by unprocessed=true after marking one processed', async () => {
      const first = await fastify.inject({
        method: 'POST',
        url: '/pages/p/responses',
        payload: { payload: { n: 1 } },
      });
      await fastify.inject({ method: 'POST', url: '/pages/p/responses', payload: { payload: { n: 2 } } });

      const firstId = first.json().id;
      await fastify.inject({
        method: 'POST',
        url: `/pages/p/responses/${firstId}/processed`,
        payload: { processed_by: 'session-xyz' },
      });

      const response = await fastify.inject({ method: 'GET', url: '/pages/p/responses?unprocessed=true' });
      const json = response.json();
      expect(json.count).toBe(1);
      expect(json.responses[0].payload).toEqual({ n: 2 });
    });

    it('404s for an unknown slug', async () => {
      const response = await fastify.inject({ method: 'GET', url: '/pages/missing/responses' });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /pages/:slug/responses/:id/processed', () => {
    it('marks a response processed exactly once, idempotently', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'p', title: 'P', html: '<html/>' },
      });
      const created = await fastify.inject({
        method: 'POST',
        url: '/pages/p/responses',
        payload: { payload: {} },
      });
      const id = created.json().id;

      const response = await fastify.inject({
        method: 'POST',
        url: `/pages/p/responses/${id}/processed`,
        payload: { processed_by: 'agent-1' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id, processed_by: 'agent-1' });

      // Re-marking is a no-op success (append-only semantics preserved).
      const again = await fastify.inject({
        method: 'POST',
        url: `/pages/p/responses/${id}/processed`,
        payload: { processed_by: 'agent-2' },
      });
      expect(again.statusCode).toBe(200);
      expect(again.json().processed_by).toBe('agent-2');
    });

    it('404s for an unknown response id', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'p', title: 'P', html: '<html/>' },
      });
      const response = await fastify.inject({
        method: 'POST',
        url: '/pages/p/responses/99999/processed',
        payload: { processed_by: 'agent-1' },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /pages/:slug/archive', () => {
    it('archives a page and 404s on an unknown slug', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/pages',
        payload: { slug: 'p', title: 'P', html: '<html/>' },
      });

      const response = await fastify.inject({ method: 'POST', url: '/pages/p/archive' });
      expect(response.statusCode).toBe(200);
      expect(response.json().archived_at).toBeTruthy();

      const missing = await fastify.inject({ method: 'POST', url: '/pages/missing/archive' });
      expect(missing.statusCode).toBe(404);
    });
  });
});

describe('formatResponseNotifyBody', () => {
  it('prefers the note when present', () => {
    expect(formatResponseNotifyBody('my note', '#anchor')).toBe('my note');
  });
  it('falls back to the anchor when no note', () => {
    expect(formatResponseNotifyBody(null, '#row-3')).toBe('New response anchored to "#row-3".');
  });
  it('falls back to a generic line when neither is present', () => {
    expect(formatResponseNotifyBody(null, null)).toBe('New response received.');
  });
});
