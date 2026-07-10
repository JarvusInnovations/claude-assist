import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { MemoryCaptureStore, MemoryReferenceStore } from '../memory-store.js';
import { CaptureRouter } from '../services/router.js';
import { CapturePipeline } from '../services/pipeline.js';
import { HoldExecutor } from '../services/executors/hold.js';
import { registerCaptureRoutes } from './capture.js';
import { generateUlid } from '../ulid.js';
import { destinationFor, transition } from '../state.js';
import type { CaptureType } from '../types.js';

describe('capture routes', () => {
  let fastify: FastifyInstance;
  let store: MemoryCaptureStore;
  let router: CaptureRouter;

  beforeEach(async () => {
    fastify = Fastify({ logger: false });
    store = new MemoryCaptureStore();
    router = new CaptureRouter(store, fastify.log);
    router.register(new HoldExecutor());
    const pipeline = new CapturePipeline(store, null, router, fastify.log);
    const referenceStore = new MemoryReferenceStore();
    await fastify.register(registerCaptureRoutes, { pipeline, referenceStore });
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      ulid: generateUlid(),
      text: 'a stray thought',
      source: 'terminal',
      captured_at: new Date().toISOString(),
      ...overrides,
    };
  }

  describe('POST /capture', () => {
    it('stores a capture as queued and acks with 201', async () => {
      const body = validBody();
      const response = await fastify.inject({ method: 'POST', url: '/capture', payload: body });

      expect(response.statusCode).toBe(201);
      const json = response.json();
      expect(json).toMatchObject({ ulid: body.ulid, status: 'queued', created: true });
      expect(json.received_at).toBeTruthy();
    });

    it('is idempotent on ulid: a replay acks 200 and never clobbers state', async () => {
      const body = validBody({ text: 'original text' });
      await fastify.inject({ method: 'POST', url: '/capture', payload: body });

      // Server-side state advances (simulates classification between retries)
      const destination = destinationFor('stray_thought');
      await store.applyClassification(
        body.ulid as string,
        { type: 'stray_thought', confidence: 1, title: null, rationale: 't', classifier: 'model' },
        destination,
        transition('queued', { kind: 'classified', destination })
      );

      // Offline-queue replay of the same capture (even with drifted fields)
      const replay = await fastify.inject({
        method: 'POST',
        url: '/capture',
        payload: { ...body, text: 'retry text drift' },
      });

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({
        ulid: body.ulid,
        status: 'classified',
        created: false,
      });

      const stored = (await store.get(body.ulid as string))!;
      expect(stored.text).toBe('original text'); // first write wins
      expect(stored.status).toBe('classified');
    });

    it('requires only ulid, text, and source', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/capture',
        payload: { ulid: generateUlid(), text: 'bare minimum', source: 'app' },
      });
      expect(response.statusCode).toBe(201);
      const stored = (await store.get(response.json().ulid))!;
      expect(stored.captured_at).toBeInstanceOf(Date); // defaulted server-side
      expect(stored.urls).toEqual([]);
      expect(stored.tags).toEqual([]);
    });

    it('accepts the full optional payload', async () => {
      const body = validBody({
        type: 'maybe a link',
        urls: ['https://example.com/a'],
        tags: ['reading'],
        payload: { share_sheet: true },
      });
      const response = await fastify.inject({ method: 'POST', url: '/capture', payload: body });
      expect(response.statusCode).toBe(201);
      const stored = (await store.get(body.ulid as string))!;
      expect(stored.type_hint).toBe('maybe a link');
      expect(stored.urls).toEqual(['https://example.com/a']);
      expect(stored.payload).toEqual({ share_sheet: true });
    });

    it.each([
      ['missing ulid', { ulid: undefined }],
      ['malformed ulid', { ulid: 'not-a-ulid' }],
      ['missing text', { text: undefined }],
      ['empty text', { text: '' }],
      ['bad source', { source: 'carrier-pigeon' }],
      ['non-http url', { urls: ['ftp://example.com'] }],
      ['bad captured_at', { captured_at: 'yesterday-ish' }],
    ])('rejects %s with 400', async (_label, overrides) => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/capture',
        payload: validBody(overrides),
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /capture', () => {
    it('lists captures filtered by status', async () => {
      const held = validBody({ text: 'held one' });
      await fastify.inject({ method: 'POST', url: '/capture', payload: held });
      await fastify.inject({ method: 'POST', url: '/capture', payload: validBody() });

      const destination = destinationFor('team_relevant');
      await store.applyClassification(
        held.ulid as string,
        { type: 'team_relevant', confidence: 1, title: null, rationale: 't', classifier: 'model' },
        destination,
        transition('queued', { kind: 'classified', destination })
      );
      await router.route((await store.get(held.ulid as string))!);

      const response = await fastify.inject({ method: 'GET', url: '/capture?status=awaiting_review' });
      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.count).toBe(1);
      expect(json.captures[0].ulid).toBe(held.ulid);
    });
  });

  describe('GET /capture/:ulid', () => {
    it('returns a capture or 404', async () => {
      const body = validBody();
      await fastify.inject({ method: 'POST', url: '/capture', payload: body });

      const found = await fastify.inject({ method: 'GET', url: `/capture/${body.ulid}` });
      expect(found.statusCode).toBe(200);
      expect(found.json().ulid).toBe(body.ulid);

      const missing = await fastify.inject({ method: 'GET', url: `/capture/${generateUlid()}` });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe('POST /capture/:ulid/correct', () => {
    it('rejects corrections on unclassified captures with 409', async () => {
      const body = validBody();
      await fastify.inject({ method: 'POST', url: '/capture', payload: body });
      const response = await fastify.inject({
        method: 'POST',
        url: `/capture/${body.ulid}/correct`,
        payload: { type: 'stray_thought' },
      });
      expect(response.statusCode).toBe(409);
    });

    it('applies a correction and re-routes', async () => {
      const body = validBody();
      await fastify.inject({ method: 'POST', url: '/capture', payload: body });
      const destination = destinationFor('stray_thought');
      await store.applyClassification(
        body.ulid as string,
        { type: 'stray_thought', confidence: 0.6, title: null, rationale: 't', classifier: 'model' },
        destination,
        transition('queued', { kind: 'classified', destination })
      );

      const response = await fastify.inject({
        method: 'POST',
        url: `/capture/${body.ulid}/correct`,
        payload: { type: 'actionable' satisfies CaptureType },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'awaiting_review',
        route_destination: 'review',
      });
    });

    it('rejects unknown types with 400', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: `/capture/${generateUlid()}/correct`,
        payload: { type: 'diet' }, // future type: not accepted until built
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
