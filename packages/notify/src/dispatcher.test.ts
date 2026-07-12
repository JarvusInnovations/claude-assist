import { describe, expect, it, mock } from 'bun:test';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import { createDispatcher } from './dispatcher.js';
import type { PushoverMessage, PushoverChannel } from './channels/pushover.js';

const log = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  fatal: mock(() => {}),
  trace: mock(() => {}),
} as unknown as FastifyBaseLogger;

function mockPushover(): { channel: PushoverChannel; sends: PushoverMessage[] } {
  const sends: PushoverMessage[] = [];
  return {
    sends,
    channel: {
      send: async (msg: PushoverMessage) => {
        sends.push(msg);
      },
    },
  };
}

/** sql stub dispatching on query text; captures UPDATE calls for assertions. */
function mockSql(opts: { pending?: unknown[] }): {
  sql: postgres.Sql;
  updates: string[];
} {
  const updates: string[] = [];
  const sql = ((strings: TemplateStringsArray) => {
    const text = strings.join(' ');
    if (text.includes('INSERT INTO notify.notifications')) {
      return Promise.resolve([{ id: 1 }]);
    }
    if (text.includes('SELECT id, title, body, url_redacted')) {
      return Promise.resolve(opts.pending ?? []);
    }
    if (text.includes('UPDATE notify.notifications')) {
      updates.push(text);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;
  return { sql, updates };
}

describe('createDispatcher — Pushover-only', () => {
  it('delivers notice/interrupt tiers immediately through Pushover', async () => {
    const { sql } = mockSql({});
    const { channel, sends } = mockPushover();
    const d = createDispatcher({ sql, log, pushover: channel });

    const res = await d.notify({ priority: 'notice', title: 'Digest · 2 to confirm', body: 'body', url: 'https://x/digest' });

    expect(sends.length).toBe(1);
    expect(sends[0]!.priority).toBe(0);
    expect(sends[0]!.url).toBe('https://x/digest');
    expect(res.deliveredVia).toEqual(['pushover']);
    expect(res.status).toBe('sent');
  });

  it('maps the interrupt tier to Pushover high priority', async () => {
    const { sql } = mockSql({});
    const { channel, sends } = mockPushover();
    const d = createDispatcher({ sql, log, pushover: channel });
    await d.notify({ priority: 'interrupt', title: 't', body: 'b' });
    expect(sends[0]!.priority).toBe(1);
  });

  it('batches the digest tier (pending, not delivered) until flush', async () => {
    const { sql } = mockSql({});
    const { channel, sends } = mockPushover();
    const d = createDispatcher({ sql, log, pushover: channel });

    const res = await d.notify({ priority: 'digest', title: 'batched', body: 'b' });

    expect(sends.length).toBe(0);
    expect(res.status).toBe('pending');
    expect(res.deliveredVia).toEqual([]);
  });

  it('flushDigest sends ONE summarizing Pushover notice and marks the batch sent', async () => {
    const { sql, updates } = mockSql({
      pending: [
        { id: 1, title: 'Session A quiet', body: 'b1', url_redacted: 'https://x/sessions/a' },
        { id: 2, title: 'Session B quiet', body: 'b2', url_redacted: null },
      ],
    });
    const { channel, sends } = mockPushover();
    const d = createDispatcher({ sql, log, pushover: channel });

    const count = await d.flushDigest();

    expect(count).toBe(2);
    expect(sends.length).toBe(1);
    // Single notice summarizing the batch, linking the first item that has a url.
    expect(sends[0]!.title).toBe('Digest · 2 updates');
    expect(sends[0]!.message).toContain('Session A quiet');
    expect(sends[0]!.message).toContain('Session B quiet');
    expect(sends[0]!.url).toBe('https://x/sessions/a');
    expect(sends[0]!.priority).toBe(0);
    // Batch marked sent via Pushover (not Slack).
    expect(updates.length).toBe(1);
  });

  it('flushDigest is a no-op when nothing is pending', async () => {
    const { sql } = mockSql({ pending: [] });
    const { channel, sends } = mockPushover();
    const d = createDispatcher({ sql, log, pushover: channel });
    expect(await d.flushDigest()).toBe(0);
    expect(sends.length).toBe(0);
  });
});
