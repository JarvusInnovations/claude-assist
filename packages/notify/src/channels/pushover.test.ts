import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createPushoverChannel } from './pushover.js';

function mockFetchOk() {
  const calls: { url: string; body: string }[] = [];
  const fetchMock = mock(async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    return new Response('', { status: 200 });
  });
  // @ts-expect-error — test double for global fetch
  globalThis.fetch = fetchMock;
  return calls;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createPushoverChannel', () => {
  const config = { token: 'tok', user: 'usr' };

  it('omits url and url_title when no url is given', async () => {
    const calls = mockFetchOk();
    const channel = createPushoverChannel(config);
    await channel.send({ title: 't', message: 'm', priority: 0 });

    const params = new URLSearchParams(calls[0]!.body);
    expect(params.has('url')).toBe(false);
    expect(params.has('url_title')).toBe(false);
  });

  it('defaults url_title to "Open" when a url is given without urlTitle', async () => {
    const calls = mockFetchOk();
    const channel = createPushoverChannel(config);
    await channel.send({ title: 't', message: 'm', priority: 1, url: 'https://example.com/x' });

    const params = new URLSearchParams(calls[0]!.body);
    expect(params.get('url')).toBe('https://example.com/x');
    expect(params.get('url_title')).toBe('Open');
  });

  it('maps a supplied urlTitle through to url_title', async () => {
    const calls = mockFetchOk();
    const channel = createPushoverChannel(config);
    await channel.send({
      title: 'Project sync in 3 min',
      message: 'Starts 15:00. https://meet.google.com/abc',
      priority: 1,
      url: 'https://meet.google.com/abc',
      urlTitle: 'Join',
    });

    const params = new URLSearchParams(calls[0]!.body);
    expect(params.get('url')).toBe('https://meet.google.com/abc');
    expect(params.get('url_title')).toBe('Join');
  });

  it('still includes token/user/title/message/priority alongside url params', async () => {
    const calls = mockFetchOk();
    const channel = createPushoverChannel(config);
    await channel.send({
      title: 'Team standup in 15 min',
      message: 'Starts 09:00. 1234 Market St',
      priority: 1,
      url: 'https://maps.google.com/?q=1234%20Market%20St',
      urlTitle: 'Map',
    });

    const params = new URLSearchParams(calls[0]!.body);
    expect(params.get('token')).toBe('tok');
    expect(params.get('user')).toBe('usr');
    expect(params.get('title')).toBe('Team standup in 15 min');
    expect(params.get('priority')).toBe('1');
    expect(params.get('url_title')).toBe('Map');
  });

  it('throws with response detail on a non-ok response', async () => {
    const fetchMock = mock(async () => new Response('bad token', { status: 401 }));
    // @ts-expect-error — test double for global fetch
    globalThis.fetch = fetchMock;
    const channel = createPushoverChannel(config);
    await expect(channel.send({ title: 't', message: 'm', priority: 0 })).rejects.toThrow(
      /Pushover 401/
    );
  });
});
