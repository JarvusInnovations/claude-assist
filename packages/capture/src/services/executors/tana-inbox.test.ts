import { describe, expect, it } from 'bun:test';
import { formatTanaPaste, TanaInboxExecutor } from './tana-inbox.js';
import type { CaptureRecord } from '../../types.js';
import { MemoryAttachmentStorage } from '../attachments/storage-memory.js';
import { buildObjectKey } from '../attachments/storage.js';
import type { TanaMcpClient } from '../tana-mcp.js';

function makeCapture(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    source: 'terminal',
    text: 'a stray thought',
    type_hint: null,
    urls: [],
    tags: [],
    payload: {},
    attachments: [],
    captured_at: new Date('2026-07-10T12:00:00Z'),
    received_at: new Date('2026-07-10T12:00:01Z'),
    status: 'classified',
    classification: null,
    classified_at: null,
    classify_attempts: 0,
    route_destination: 'tana-inbox',
    route_attempts: 0,
    routed_at: null,
    route_result: null,
    last_error: null,
    last_error_at: null,
  resolution: null,
  resolved_at: null,
    ...overrides,
  };
}

describe('formatTanaPaste', () => {
  it('renders a single-line thought with provenance child', () => {
    const paste = formatTanaPaste(makeCapture());
    const lines = paste.split('\n');
    expect(lines[0]).toBe('- a stray thought');
    expect(lines[1]).toBe(
      '  - captured:: 2026-07-10T12:00:00.000Z via terminal (01ARZ3NDEKTSV4RRFFQ69G5FAV)'
    );
  });

  it('turns extra text lines into children', () => {
    const paste = formatTanaPaste(makeCapture({ text: 'first line\nsecond line\n\nthird' }));
    expect(paste).toContain('- first line\n  - second line\n  - third');
  });

  it('appends URLs not already present in the text', () => {
    const paste = formatTanaPaste(
      makeCapture({ text: 'thought with https://inline.example', urls: ['https://inline.example', 'https://extra.example'] })
    );
    expect(paste).toContain('  - https://extra.example');
    expect(paste).not.toContain('  - https://inline.example');
  });

  it('includes tags as a field child when present', () => {
    const paste = formatTanaPaste(makeCapture({ tags: ['reading', 'ai'] }));
    expect(paste).toContain('  - tags:: reading, ai');
  });

  it('appends attachment links as markdown-link children when provided', () => {
    const paste = formatTanaPaste(makeCapture(), [
      { filename: 'photo.jpg', url: 'https://signed.example/read/photo' },
    ]);
    expect(paste).toContain('  - attachment:: [photo.jpg](https://signed.example/read/photo)');
  });
});

describe('TanaInboxExecutor attachment links', () => {
  function fakeClient(captured: { content?: string }): TanaMcpClient {
    return {
      callTool: async (_tool: string, args: { content: string }) => {
        captured.content = args.content;
        return 'ok';
      },
    } as unknown as TanaMcpClient;
  }

  it('signs read urls for attachments and appends them to the node', async () => {
    const ulid = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const key = buildObjectKey(ulid, 0, 'photo.jpg');
    const storage = new MemoryAttachmentStorage();
    storage.put(key);
    const captured: { content?: string } = {};

    const executor = new TanaInboxExecutor(fakeClient(captured), 'WS', storage);
    const result = await executor.execute(
      makeCapture({
        ulid,
        attachments: [
          { object_key: key, filename: 'photo.jpg', content_type: 'image/jpeg', bytes: 1 },
        ],
      })
    );

    expect(result.attachment_count).toBe(1);
    expect(captured.content).toContain(`  - attachment:: [photo.jpg](memory://read/${key})`);
  });

  it('files a capture normally when it has no attachments (storage present)', async () => {
    const storage = new MemoryAttachmentStorage();
    const captured: { content?: string } = {};
    const executor = new TanaInboxExecutor(fakeClient(captured), 'WS', storage);
    const result = await executor.execute(makeCapture());
    expect(result.attachment_count).toBe(0);
    expect(captured.content).not.toContain('attachment::');
  });
});
