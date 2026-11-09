import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_ATTACHMENT_BYTES,
  buildPrompt,
  downloadAttachments,
  isHandledSubtype,
  threadDirName,
  type Attachment,
} from './attachments.js';

describe('isHandledSubtype', () => {
  it('handles plain messages and messages with files', () => {
    expect(isHandledSubtype(undefined)).toBe(true);
    expect(isHandledSubtype('file_share')).toBe(true);
  });

  it('ignores edits, deletions and system events', () => {
    for (const subtype of ['message_changed', 'message_deleted', 'bot_message', 'thread_broadcast', 'channel_join']) {
      expect(isHandledSubtype(subtype)).toBe(false);
    }
  });
});

describe('threadDirName', () => {
  it('is filesystem-safe', () => {
    expect(threadDirName('D0AKKFL8JQJ', '1794239847.916949')).toBe('D0AKKFL8JQJ-1794239847.916949');
    expect(threadDirName('a/b', '../x')).toBe('a_b-.._x');
  });
});

describe('buildPrompt', () => {
  const saved: Attachment = { ok: true, name: 'photo.png', mimetype: 'image/png', size: 2048, path: '/tmp/x/F1-photo.png' };
  const failed: Attachment = { ok: false, name: 'doc.pdf', mimetype: 'application/pdf', reason: 'HTTP 403 from Slack' };

  it('passes text through unchanged when there are no files', () => {
    expect(buildPrompt('hello', [])).toBe('hello');
  });

  it('appends each file with its path, name, type and size', () => {
    const prompt = buildPrompt('what is this?', [saved]);
    expect(prompt.startsWith('what is this?\n\n[Attachments on this Slack message]')).toBe(true);
    expect(prompt).toContain('/tmp/x/F1-photo.png (photo.png, image/png, 2.0 KB) — open it with the Read tool');
  });

  it('is only the attachments section when there is no text', () => {
    expect(buildPrompt('', [saved]).startsWith('[Attachments on this Slack message]')).toBe(true);
  });

  it('lists a file that failed to download with the reason', () => {
    expect(buildPrompt('see attached', [failed])).toContain('doc.pdf (application/pdf) — could not be downloaded: HTTP 403 from Slack');
  });
});

describe('downloadAttachments', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const file = {
    id: 'F1',
    name: 'my photo.png',
    mimetype: 'image/png',
    size: 3,
    url_private_download: 'https://files.slack.com/F1/download',
  };

  it('saves the file with the bot token as a bearer credential', async () => {
    dir = await mkdtemp(join(tmpdir(), 'chat-att-'));
    let auth = null as string | null;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get('authorization');
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;

    const [result] = await downloadAttachments([file], 'xoxb-test', dir, fetchFn);
    expect(auth).toBe('Bearer xoxb-test');
    expect(result).toMatchObject({ ok: true, name: 'my photo.png', size: 3 });
    const path = (result as Extract<Attachment, { ok: true }>).path;
    expect(path).toBe(join(dir, 'F1-my_photo.png'));
    expect([...(await readFile(path))]).toEqual([1, 2, 3]);
  });

  it("reports Slack's HTML login page as a missing files:read scope", async () => {
    dir = await mkdtemp(join(tmpdir(), 'chat-att-'));
    const fetchFn = (async () =>
      new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch;
    const [result] = await downloadAttachments([file], 'xoxb-test', dir, fetchFn);
    expect(result).toMatchObject({ ok: false });
    expect((result as Extract<Attachment, { ok: false }>).reason).toContain('files:read');
  });

  it('reports an HTTP error', async () => {
    dir = await mkdtemp(join(tmpdir(), 'chat-att-'));
    const fetchFn = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    const [result] = await downloadAttachments([file], 'xoxb-test', dir, fetchFn);
    expect(result).toMatchObject({ ok: false, reason: 'HTTP 403 from Slack' });
  });

  it('skips files over the size limit without fetching them', async () => {
    let fetched = false;
    const fetchFn = (async () => {
      fetched = true;
      return new Response('');
    }) as unknown as typeof fetch;
    const [result] = await downloadAttachments([{ ...file, size: MAX_ATTACHMENT_BYTES + 1 }], 'xoxb-test', '/nonexistent', fetchFn);
    expect(fetched).toBe(false);
    expect(result).toMatchObject({ ok: false });
  });
});
