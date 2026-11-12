import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isVerdict, resolveServer, screenCheck } from './screen-check.js';

const REQUEST = JSON.stringify({ draft: 'hello', destination_class: 'team', policy: 'no secrets' });
const ENV = { CLAUDE_ASSIST_SERVER: 'http://screen.test/', CLAUDE_ASSIST_SCREEN_TOKEN: 'tok' };

function respond(status: number, body: string) {
  const seen: { url?: string; init?: RequestInit } = {};
  const fetchImpl = async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, seen };
}

describe('screenCheck', () => {
  it('posts stdin to /api/screen with the bearer token and prints a pass', async () => {
    const { fetchImpl, seen } = respond(200, '{"verdict":"pass"}');
    const result = await screenCheck(REQUEST, ENV, fetchImpl);
    expect(result).toEqual({ stdout: '{"verdict":"pass"}', exitCode: 0 });
    expect(seen.url).toBe('http://screen.test/api/screen');
    expect(seen.init?.method).toBe('POST');
    expect((seen.init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(seen.init?.body as string)).toEqual(JSON.parse(REQUEST));
  });

  it('prints a block and exits 0', async () => {
    const body = '{"verdict":"block","passage":"hello","reason":"r"}';
    const result = await screenCheck(REQUEST, ENV, respond(200, body).fetchImpl);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!)).toEqual(JSON.parse(body));
  });

  it.each([
    ['a 502 envelope', 502, '{"error":{"code":"screen_unparseable","message":"x"}}'],
    ['a 401', 401, '{"error":{"code":"unauthorized","message":"x"}}'],
    ['a 413', 413, '{"error":{"code":"draft_too_large","message":"x"}}'],
    ['a 200 that is not JSON', 200, '<html>'],
    ['a 200 that is not a verdict', 200, '{"ok":true}'],
    ['a 200 pass with extra keys', 200, '{"verdict":"pass","note":"x"}'],
    ['a 201 carrying a verdict', 201, '{"verdict":"pass"}'],
  ])('fails with no stdout on %s', async (_label, status, body) => {
    const result = await screenCheck(REQUEST, ENV, respond(status, body).fetchImpl);
    expect(result.stdout).toBeUndefined();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toStartWith('screen-check:');
  });

  it('fails with no stdout when the token is missing, without calling the server', async () => {
    const { fetchImpl, seen } = respond(200, '{"verdict":"pass"}');
    const result = await screenCheck(REQUEST, { CLAUDE_ASSIST_SERVER: 'http://screen.test' }, fetchImpl);
    expect(result).toMatchObject({ exitCode: 2 });
    expect(result.stdout).toBeUndefined();
    expect(seen.url).toBeUndefined();
  });

  it('fails with no stdout when stdin is not JSON', async () => {
    const result = await screenCheck('not json', ENV, respond(200, '{"verdict":"pass"}').fetchImpl);
    expect(result).toMatchObject({ exitCode: 2 });
    expect(result.stdout).toBeUndefined();
  });

  it('fails with no stdout on a network error', async () => {
    const result = await screenCheck(REQUEST, ENV, async () => {
      throw new TypeError('fetch failed');
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBeUndefined();
  });

  it('fails with no stdout on a timeout', async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const result = await screenCheck(REQUEST, { ...ENV, CLAUDE_ASSIST_SCREEN_TIMEOUT_MS: '20' }, hang);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('timed out');
    expect(result.stdout).toBeUndefined();
  });

  it('defaults the server like the other clients', () => {
    expect(resolveServer({})).toBe('http://localhost:2529');
  });

  it('checks the verdict shape', () => {
    expect(isVerdict({ verdict: 'pass' })).toBe(true);
    expect(isVerdict({ verdict: 'block', passage: 'p', reason: 'r' })).toBe(true);
    expect(isVerdict({ verdict: 'block', passage: '', reason: 'r' })).toBe(false);
    expect(isVerdict({ verdict: 'allow' })).toBe(false);
  });
});

/** The real entry point as a subprocess, against a loopback stub server: exit codes and stdout. */
describe('screen-check process', () => {
  let server: Server;
  let base: string;
  let next: { status: number; body: string } = { status: 200, body: '{"verdict":"pass"}' };

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(next.status, { 'content-type': 'application/json' });
        res.end(next.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  async function run(env: Record<string, string>, input = REQUEST) {
    const child = spawn(process.execPath, [join(import.meta.dir, 'bin.ts')], {
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(input);
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    return { code, stdout, stderr };
  }

  it('exits 0 and prints the verdict for pass', async () => {
    next = { status: 200, body: '{"verdict":"pass"}' };
    const r = await run({ CLAUDE_ASSIST_SERVER: base, CLAUDE_ASSIST_SCREEN_TOKEN: 'tok' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ verdict: 'pass' });
  });

  it('exits 0 and prints the verdict for block', async () => {
    next = { status: 200, body: '{"verdict":"block","passage":"hello","reason":"r"}' };
    const r = await run({ CLAUDE_ASSIST_SERVER: base, CLAUDE_ASSIST_SCREEN_TOKEN: 'tok' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ verdict: 'block', passage: 'hello', reason: 'r' });
  });

  it('exits non-zero with empty stdout on a server error', async () => {
    next = { status: 503, body: '{"error":{"code":"screen_unavailable","message":"x"}}' };
    const r = await run({ CLAUDE_ASSIST_SERVER: base, CLAUDE_ASSIST_SCREEN_TOKEN: 'tok' });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('screen_unavailable');
  });

  it('exits non-zero with empty stdout when the server is unreachable', async () => {
    const r = await run({ CLAUDE_ASSIST_SERVER: 'http://127.0.0.1:1', CLAUDE_ASSIST_SCREEN_TOKEN: 'tok' });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
  });

  it('exits 2 with empty stdout when the token is unset', async () => {
    const r = await run({ CLAUDE_ASSIST_SERVER: base });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
  });
});
