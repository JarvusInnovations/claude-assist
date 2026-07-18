import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { MemoryCaptureStore, MemoryReferenceStore } from '../memory-store.js';
import { CaptureRouter } from '../services/router.js';
import { CapturePipeline } from '../services/pipeline.js';
import { registerCaptureRoutes } from './capture.js';
import { generateUlid } from '../ulid.js';
import { MemoryAttachmentStorage } from '../services/attachments/storage-memory.js';
import { buildObjectKey } from '../services/attachments/storage.js';

function buildServer(storage: MemoryAttachmentStorage | null) {
  const fastify = Fastify({ logger: false });
  const store = new MemoryCaptureStore();
  const router = new CaptureRouter(store, fastify.log);
  const pipeline = new CapturePipeline(store, null, router, fastify.log, { storage });
  const referenceStore = new MemoryReferenceStore();
  return { fastify, store, pipeline, referenceStore };
}

describe('POST /capture/attachments/sign', () => {
  let fastify: FastifyInstance;
  let storage: MemoryAttachmentStorage;

  beforeEach(async () => {
    storage = new MemoryAttachmentStorage();
    const parts = buildServer(storage);
    fastify = parts.fastify;
    await fastify.register(registerCaptureRoutes, {
      pipeline: parts.pipeline,
      referenceStore: parts.referenceStore,
      storage,
    });
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('issues a signed upload url and a ULID-keyed object key', async () => {
    const ulid = generateUlid();
    const res = await fastify.inject({
      method: 'POST',
      url: '/capture/attachments/sign',
      payload: { ulid, filename: 'photo.jpg', content_type: 'image/jpeg', bytes: 100, index: 1 },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.object_key).toBe(`captures/${ulid}/1-photo.jpg`);
    expect(json.url).toContain(json.object_key);
    // The signature was constrained to content-type + length.
    const params = storage.signedUploads.get(json.object_key);
    expect(params).toMatchObject({ content_type: 'image/jpeg', bytes: 100 });
  });

  it('sanitizes the filename in the object key', async () => {
    const ulid = generateUlid();
    const res = await fastify.inject({
      method: 'POST',
      url: '/capture/attachments/sign',
      payload: { ulid, filename: '../../evil name.png', content_type: 'image/png', bytes: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().object_key).toBe(`captures/${ulid}/0-evil_name.png`);
  });

  it('rejects a malformed ulid via schema (400)', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/capture/attachments/sign',
      payload: { ulid: 'nope', filename: 'a.png', content_type: 'image/png', bytes: 1 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('sign endpoint when storage is unconfigured', () => {
  let fastify: FastifyInstance;

  beforeEach(async () => {
    const parts = buildServer(null);
    fastify = parts.fastify;
    await fastify.register(registerCaptureRoutes, {
      pipeline: parts.pipeline,
      referenceStore: parts.referenceStore,
      storage: null,
    });
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('responds 503 with a clear message', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/capture/attachments/sign',
      payload: { ulid: generateUlid(), filename: 'a.png', content_type: 'image/png', bytes: 1 },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain('not configured');
  });
});

describe('POST /capture with attachments (HTTP error mapping)', () => {
  let fastify: FastifyInstance;
  let storage: MemoryAttachmentStorage;

  beforeEach(async () => {
    storage = new MemoryAttachmentStorage();
    const parts = buildServer(storage);
    fastify = parts.fastify;
    await fastify.register(registerCaptureRoutes, {
      pipeline: parts.pipeline,
      referenceStore: parts.referenceStore,
      storage,
    });
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('202/201s when the referenced object exists', async () => {
    const ulid = generateUlid();
    const key = buildObjectKey(ulid, 0, 'photo.jpg');
    storage.put(key);
    const res = await fastify.inject({
      method: 'POST',
      url: '/capture',
      payload: {
        ulid,
        source: 'app',
        text: 'a photo',
        attachments: [{ object_key: key, filename: 'photo.jpg', content_type: 'image/jpeg', bytes: 1 }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('queued');
  });

  it('422s when the referenced object is missing', async () => {
    const ulid = generateUlid();
    const key = buildObjectKey(ulid, 0, 'photo.jpg'); // not uploaded
    const res = await fastify.inject({
      method: 'POST',
      url: '/capture',
      payload: {
        ulid,
        source: 'app',
        text: 'a photo',
        attachments: [{ object_key: key, filename: 'photo.jpg', content_type: 'image/jpeg', bytes: 1 }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('not found');
  });
});

describe('GET /capture/:ulid/attachments (signed read exposure)', () => {
  let fastify: FastifyInstance;
  let storage: MemoryAttachmentStorage;
  let pipeline: CapturePipeline;

  beforeEach(async () => {
    storage = new MemoryAttachmentStorage();
    const parts = buildServer(storage);
    fastify = parts.fastify;
    pipeline = parts.pipeline;
    await fastify.register(registerCaptureRoutes, {
      pipeline: parts.pipeline,
      referenceStore: parts.referenceStore,
      storage,
    });
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('returns metadata plus a signed read url per attachment', async () => {
    const ulid = generateUlid();
    const key = buildObjectKey(ulid, 0, 'photo.jpg');
    storage.put(key);
    await pipeline.ingest({
      ulid,
      source: 'app',
      text: 'a photo',
      attachments: [{ object_key: key, filename: 'photo.jpg', content_type: 'image/jpeg', bytes: 1 }],
    });

    const res = await fastify.inject({ method: 'GET', url: `/capture/${ulid}/attachments` });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.count).toBe(1);
    expect(json.attachments[0]).toMatchObject({ object_key: key, filename: 'photo.jpg' });
    expect(json.attachments[0].url).toBe(`memory://read/${key}`);
  });

  it('returns an empty list for a capture with no attachments', async () => {
    const ulid = generateUlid();
    await pipeline.ingest({ ulid, source: 'terminal', text: 'plain' });
    const res = await fastify.inject({ method: 'GET', url: `/capture/${ulid}/attachments` });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { attachments: unknown[]; count: number };
    expect(json.attachments).toEqual([]);
    expect(json.count).toBe(0);
  });

  it('404s for an unknown capture', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: `/capture/${generateUlid()}/attachments`,
    });
    expect(res.statusCode).toBe(404);
  });
});
