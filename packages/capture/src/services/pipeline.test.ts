import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import { MemoryCaptureStore, MemoryReferenceStore } from '../memory-store.js';
import { CaptureRouter } from './router.js';
import { CapturePipeline } from './pipeline.js';
import { ReferencesExecutor, extractNotes } from './executors/references.js';
import { HoldExecutor } from './executors/hold.js';
import { generateUlid } from '../ulid.js';

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

describe('sweep: URL-only capture end-to-end (deterministic, no model)', () => {
  it('classifies a link drop and files it into the references store', async () => {
    const store = new MemoryCaptureStore();
    const references = new MemoryReferenceStore();
    const router = new CaptureRouter(store, log);
    router.register(new HoldExecutor());
    router.register(new ReferencesExecutor(references));

    const pipeline = new CapturePipeline(store, null, router, log, {
      fetchLinks: async (urls) => [
        {
          url: urls[0]!,
          title: 'Fetched Title',
          description: 'Fetched description',
          site_name: 'Example',
        },
      ],
    });

    const ulid = generateUlid();
    await pipeline.ingest({
      ulid,
      text: 'https://example.com/article',
      source: 'app',
      tags: ['reading'],
    });

    const result = await pipeline.sweep();
    expect(result.classified).toBe(1);
    expect(result.routed).toBe(1);

    const capture = (await store.get(ulid))!;
    expect(capture.status).toBe('routed');
    expect(capture.classification!.type).toBe('link_reference');
    expect(capture.classification!.classifier).toBe('deterministic');
    expect(capture.route_destination).toBe('references');

    const reference = references.records.get(ulid)!;
    expect(reference).toMatchObject({
      url: 'https://example.com/article',
      title: 'Fetched Title',
      description: 'Fetched description',
      site_name: 'Example',
      notes: '',
      tags: ['reading'],
      source: 'app',
    });
  });

  it('leaves non-link captures queued when no classifier is configured, without burning attempts', async () => {
    const store = new MemoryCaptureStore();
    const router = new CaptureRouter(store, log);
    const pipeline = new CapturePipeline(store, null, router, log, {
      fetchLinks: async () => [],
    });

    const ulid = generateUlid();
    await pipeline.ingest({ ulid, text: 'just a thought', source: 'terminal' });

    await pipeline.sweep();
    const capture = (await store.get(ulid))!;
    expect(capture.status).toBe('queued');
    expect(capture.classify_attempts).toBe(0);
  });
});

describe('extractNotes', () => {
  it('strips URLs, keeping the human note', () => {
    expect(extractNotes('great capture UI writeup https://a.com/x', ['https://a.com/x'])).toBe(
      'great capture UI writeup'
    );
  });

  it('returns empty for URL-only text', () => {
    expect(extractNotes('https://a.com/x', ['https://a.com/x'])).toBe('');
  });
});
