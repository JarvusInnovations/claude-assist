import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import { MemoryCaptureStore } from '../../memory-store.js';
import { CaptureRouter } from '../router.js';
import { CapturePipeline } from '../pipeline.js';
import { generateUlid } from '../../ulid.js';
import { MemoryAttachmentStorage } from './storage-memory.js';
import { buildObjectKey } from './storage.js';
import {
  AttachmentKeyMismatchError,
  AttachmentStorageUnconfiguredError,
  AttachmentVerificationError,
} from './errors.js';
import type { CaptureAttachment } from '../../types.js';

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

function makePipeline(storage: MemoryAttachmentStorage | null) {
  const store = new MemoryCaptureStore();
  const router = new CaptureRouter(store, log);
  const pipeline = new CapturePipeline(store, null, router, log, { storage });
  return { store, pipeline };
}

function attachment(ulid: string, index: number, filename: string): CaptureAttachment {
  return {
    object_key: buildObjectKey(ulid, index, filename),
    filename,
    content_type: 'image/jpeg',
    bytes: 42,
  };
}

describe('attachment ingest verification', () => {
  it('ingests a capture whose attachments all exist in the bucket', async () => {
    const storage = new MemoryAttachmentStorage();
    const { store, pipeline } = makePipeline(storage);
    const ulid = generateUlid();
    const att = attachment(ulid, 0, 'photo.jpg');
    storage.put(att.object_key);

    const { record, created } = await pipeline.ingest({
      ulid,
      source: 'app',
      text: 'here is a photo',
      attachments: [att],
    });

    expect(created).toBe(true);
    expect(record.attachments).toEqual([att]);
    const stored = await store.get(ulid);
    expect(stored?.attachments).toEqual([att]);
  });

  it('captures without attachments behave exactly as before (no storage needed)', async () => {
    const { store, pipeline } = makePipeline(null);
    const ulid = generateUlid();
    const { record, created } = await pipeline.ingest({
      ulid,
      source: 'terminal',
      text: 'a plain thought',
    });
    expect(created).toBe(true);
    expect(record.attachments).toEqual([]);
    expect((await store.get(ulid))?.status).toBe('queued');
  });

  it('fails clearly when a referenced object is missing from the bucket', async () => {
    const storage = new MemoryAttachmentStorage();
    const { store, pipeline } = makePipeline(storage);
    const ulid = generateUlid();
    const att = attachment(ulid, 0, 'photo.jpg');
    // NOT uploaded: storage.put omitted

    let error: unknown;
    try {
      await pipeline.ingest({ ulid, source: 'app', text: 'x', attachments: [att] });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AttachmentVerificationError);
    expect((error as AttachmentVerificationError).missingKeys).toEqual([att.object_key]);
    // Nothing persisted on failure
    expect(await store.get(ulid)).toBeNull();
  });

  it('rejects attachments when storage is unconfigured', async () => {
    const { store, pipeline } = makePipeline(null);
    const ulid = generateUlid();
    const att = attachment(ulid, 0, 'photo.jpg');

    let error: unknown;
    try {
      await pipeline.ingest({ ulid, source: 'app', text: 'x', attachments: [att] });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AttachmentStorageUnconfiguredError);
    expect((error as AttachmentStorageUnconfiguredError).statusCode).toBe(503);
    expect(await store.get(ulid)).toBeNull();
  });

  it('rejects object keys that do not belong to the capture ULID', async () => {
    const storage = new MemoryAttachmentStorage();
    const { pipeline } = makePipeline(storage);
    const ulid = generateUlid();
    const otherUlid = generateUlid();
    const att = attachment(otherUlid, 0, 'photo.jpg'); // key for a different ULID
    storage.put(att.object_key);

    let error: unknown;
    try {
      await pipeline.ingest({ ulid, source: 'app', text: 'x', attachments: [att] });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AttachmentKeyMismatchError);
    expect((error as AttachmentKeyMismatchError).statusCode).toBe(400);
  });
});
