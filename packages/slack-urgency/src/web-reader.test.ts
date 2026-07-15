import { describe, expect, it, mock } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import type { WebClient } from '@slack/web-api';
import { WebApiSlackReader } from './web-reader.js';

function makeLogger(): FastifyBaseLogger {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    fatal: mock(() => {}),
    trace: mock(() => {}),
  } as unknown as FastifyBaseLogger;
}

type FakeChannel = { id?: string; is_user_deleted?: boolean };
type FakePage = { channels: FakeChannel[]; next_cursor?: string };
type ListArgs = { types?: string; cursor?: string; exclude_archived?: boolean };

/**
 * WebClient double whose conversations.list serves paged fixtures keyed by
 * `types`. Cursors are page indices rendered as strings ('1', '2', …), the
 * way each fixture page's `next_cursor` points at the next one.
 */
function makeClient(pages: Record<string, FakePage[]>) {
  const calls: ListArgs[] = [];
  const client = {
    conversations: {
      list: mock(async (args: ListArgs) => {
        calls.push(args);
        const set = pages[args.types ?? ''] ?? [];
        const page = set[args.cursor ? Number(args.cursor) : 0] ?? { channels: [] };
        return {
          ok: true,
          channels: page.channels,
          response_metadata: { next_cursor: page.next_cursor ?? '' },
        };
      }),
    },
  } as unknown as WebClient;
  return { client, calls };
}

function makeReader(client: WebClient, maxDms: number): WebApiSlackReader {
  return new WebApiSlackReader(
    { userToken: 'xoxp-test', maxDmConversations: maxDms },
    makeLogger(),
    client
  );
}

describe('WebApiSlackReader.listDmConversations', () => {
  it('keeps every 1:1 im under a small cap, mpims only fill the remainder', async () => {
    const { client } = makeClient({
      im: [{ channels: [{ id: 'D1' }, { id: 'D2' }, { id: 'D3' }] }],
      mpim: [{ channels: [{ id: 'G1' }, { id: 'G2' }, { id: 'G3' }] }],
    });
    const out = await makeReader(client, 4).listDmConversations();
    expect(out).toEqual([
      { id: 'D1', type: 'im' },
      { id: 'D2', type: 'im' },
      { id: 'D3', type: 'im' },
      { id: 'G1', type: 'mpim' },
    ]);
  });

  it('keeps all ims even when they alone exceed the cap, and skips the mpim fetch', async () => {
    const { client, calls } = makeClient({
      im: [{ channels: [{ id: 'D1' }, { id: 'D2' }, { id: 'D3' }, { id: 'D4' }, { id: 'D5' }] }],
      mpim: [{ channels: [{ id: 'G1' }] }],
    });
    const out = await makeReader(client, 3).listDmConversations();
    expect(out.map((c) => c.id)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
    expect(out.every((c) => c.type === 'im')).toBe(true);
    expect(calls.map((c) => c.types)).toEqual(['im']);
  });

  it('excludes ims whose counterpart user is deleted', async () => {
    const { client } = makeClient({
      im: [
        {
          channels: [
            { id: 'D1' },
            { id: 'D_DEAD', is_user_deleted: true },
            { id: 'D2', is_user_deleted: false },
          ],
        },
      ],
      mpim: [{ channels: [] }],
    });
    const out = await makeReader(client, 10).listDmConversations();
    expect(out.map((c) => c.id)).toEqual(['D1', 'D2']);
  });

  it('types conversations by the request that returned them, not by id prefix', async () => {
    const { client } = makeClient({
      im: [{ channels: [{ id: 'D1' }] }],
      // modern mpims can carry C-prefixed ids
      mpim: [{ channels: [{ id: 'C_MODERN' }, { id: 'G_LEGACY' }] }],
    });
    const out = await makeReader(client, 10).listDmConversations();
    expect(out).toEqual([
      { id: 'D1', type: 'im' },
      { id: 'C_MODERN', type: 'mpim' },
      { id: 'G_LEGACY', type: 'mpim' },
    ]);
  });

  it('paginates both types fully across cursors', async () => {
    const { client, calls } = makeClient({
      im: [
        { channels: [{ id: 'D1' }], next_cursor: '1' },
        { channels: [{ id: 'D2' }], next_cursor: '2' },
        { channels: [{ id: 'D3' }] },
      ],
      mpim: [{ channels: [{ id: 'G1' }], next_cursor: '1' }, { channels: [{ id: 'G2' }] }],
    });
    const out = await makeReader(client, 10).listDmConversations();
    expect(out.map((c) => c.id)).toEqual(['D1', 'D2', 'D3', 'G1', 'G2']);
    expect(calls.map((c) => c.types)).toEqual(['im', 'im', 'im', 'mpim', 'mpim']);
    expect(calls.every((c) => c.exclude_archived === true)).toBe(true);
  });

  it('stops mid-page once mpims exhaust the remaining budget', async () => {
    const { client, calls } = makeClient({
      im: [{ channels: [{ id: 'D1' }, { id: 'D2' }] }],
      mpim: [
        { channels: [{ id: 'G1' }, { id: 'G2' }, { id: 'G3' }], next_cursor: '1' },
        { channels: [{ id: 'G4' }] },
      ],
    });
    const out = await makeReader(client, 4).listDmConversations();
    expect(out.map((c) => c.id)).toEqual(['D1', 'D2', 'G1', 'G2']);
    // budget hit on the first mpim page — the second is never requested
    expect(calls.map((c) => c.types)).toEqual(['im', 'mpim']);
  });
});
