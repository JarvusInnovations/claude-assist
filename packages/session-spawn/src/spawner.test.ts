import { describe, it, expect } from 'bun:test';
import type {
  FastifyBaseLogger,
} from 'fastify';
import type {
  NotifyDispatcher,
  NotifyInput,
  NotifyResult,
} from '@jarvus/claude-assist-core';
import { createSessionSpawner, STRIPPED_AUTH_ENV_VARS } from './spawner.js';

const SUCCESS = new URL('./__fixtures__/spawn-success.sh', import.meta.url).pathname;
const FAIL = new URL('./__fixtures__/spawn-fail.sh', import.meta.url).pathname;
const NOURL = new URL('./__fixtures__/spawn-nourl.sh', import.meta.url).pathname;

const FAKE_LINK = 'https://example.test/rc/session_FAKE';

/** Records every dispatch; returns an incrementing notification id. */
class FakeDispatcher implements NotifyDispatcher {
  calls: NotifyInput[] = [];
  async notify(input: NotifyInput): Promise<NotifyResult> {
    this.calls.push(input);
    return {
      id: this.calls.length,
      priority: input.priority,
      deliveredVia: ['pushover'],
      status: 'sent',
    };
  }
}

/** A logger that captures every logged argument as a flat string for scanning. */
function captureLogger(): FastifyBaseLogger & { lines: string[] } {
  const lines: string[] = [];
  const rec = (...args: unknown[]) => {
    lines.push(
      args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
    );
  };
  const logger = { lines } as unknown as FastifyBaseLogger & { lines: string[] };
  for (const m of ['info', 'warn', 'error', 'debug', 'trace', 'fatal'] as const) {
    (logger as unknown as Record<string, unknown>)[m] = rec;
  }
  (logger as unknown as Record<string, unknown>).child = () => logger;
  (logger as unknown as Record<string, unknown>).level = 'silent';
  return logger;
}

describe('SessionSpawner', () => {
  it('happy path: runs the command, dispatches the takeover link, returns a link-free record', async () => {
    const notify = new FakeDispatcher();
    const log = captureLogger();
    const spawner = createSessionSpawner({ command: ['bash', SUCCESS], notify, log });

    const record = await spawner.spawn({ preloadPrompt: 'today: 1200 kcal', title: 'meal-planning' });

    expect(record.status).toBe('spawned');
    expect(record.spawnId).toBeTruthy();
    expect(record.notificationId).toBe(1);
    expect(record.reason).toBeUndefined();

    // The link was delivered — and only to the dispatcher.
    expect(notify.calls).toHaveLength(1);
    const push = notify.calls[0]!;
    expect(push.url).toBe(FAKE_LINK);
    expect(push.priority).toBe('notice');
    expect(push.title).toContain('meal-planning');
  });

  it('SECURITY: the raw link never appears in the record or the logs — only in the push', async () => {
    const notify = new FakeDispatcher();
    const log = captureLogger();
    const spawner = createSessionSpawner({ command: ['bash', SUCCESS], notify, log });

    const record = await spawner.spawn({ preloadPrompt: 'brief', title: 'meal-planning' });

    // Present in the delivered payload...
    expect(notify.calls[0]!.url).toContain('session_FAKE');
    // ...absent from the returned record (serialized)...
    expect(JSON.stringify(record)).not.toContain('session_FAKE');
    expect(JSON.stringify(record)).not.toContain('example.test');
    // ...and absent from every captured log line.
    const logs = log.lines.join('\n');
    expect(logs).not.toContain('session_FAKE');
    expect(logs).not.toContain('example.test');
  });

  it('appends the preload temp-file path as the final arg, carrying the prompt', async () => {
    const notify = new FakeDispatcher();
    const log = captureLogger();
    // bash -c script; $0 is the placeholder, $1 is the appended temp-file path.
    // Emits a URL only when the file contains the sentinel — proving the prompt
    // reached the command through the appended file.
    const spawner = createSessionSpawner({
      command: ['bash', '-c', 'grep -q MAGIC "$1" && echo https://example.test/rc/session_OK', 'spawn'],
      notify,
      log,
    });

    const record = await spawner.spawn({ preloadPrompt: 'line one\nMAGIC token\nline three', title: 't' });

    expect(record.status).toBe('spawned');
    expect(notify.calls[0]!.url).toBe('https://example.test/rc/session_OK');
  });

  it('non-zero exit: returns failed, dispatches a linkless failure push with a redacted reason', async () => {
    const notify = new FakeDispatcher();
    const log = captureLogger();
    const spawner = createSessionSpawner({ command: ['bash', FAIL], notify, log });

    const record = await spawner.spawn({ preloadPrompt: 'brief', title: 'meal-planning' });

    expect(record.status).toBe('failed');
    expect(record.notificationId).toBe(1);
    expect(record.reason).toContain('spawn backend unavailable');

    const push = notify.calls[0]!;
    expect(push.url).toBeUndefined();
    expect(push.priority).toBe('notice');
    expect(push.title).toContain("Couldn't start");
  });

  it('exit 0 but no URL: still a failure with a failure push', async () => {
    const notify = new FakeDispatcher();
    const log = captureLogger();
    const spawner = createSessionSpawner({ command: ['bash', NOURL], notify, log });

    const record = await spawner.spawn({ preloadPrompt: 'brief', title: 'meal-planning' });

    expect(record.status).toBe('failed');
    expect(record.reason).toContain('no takeover link');
    expect(notify.calls[0]!.url).toBeUndefined();
  });

  it('respects the timeout bound: a hung command fails, never hangs', async () => {
    const notify = new FakeDispatcher();
    const log = captureLogger();
    const spawner = createSessionSpawner({
      command: ['bash', '-c', 'sleep 5', 'spawn'],
      notify,
      log,
      timeoutMs: 200,
    });

    const record = await spawner.spawn({ preloadPrompt: 'brief', title: 'meal-planning' });

    expect(record.status).toBe('failed');
    expect(record.reason).toContain('timed out');
    expect(notify.calls[0]!.url).toBeUndefined();
  });

  it('BILLING BOUNDARY: strips Claude programmatic-auth vars from the child env, keeps the rest', async () => {
    const notify = new FakeDispatcher();
    const log = captureLogger();

    // Seed the parent env with the metered-auth vars (as the server would carry
    // from its .env) plus an unrelated var that MUST survive.
    const priorEnv = { ...process.env };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-secret';
    process.env.ANTHROPIC_API_KEY = 'api-secret';
    process.env.ANTHROPIC_AUTH_TOKEN = 'auth-secret';
    process.env.SPAWN_TEST_SENTINEL = 'keep-me';

    try {
      // Injected exec captures the options.env the spawner passes and returns a
      // synthetic success without running anything.
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const spawner = createSessionSpawner({
        command: ['some-rc-tool', 'spawn'],
        notify,
        log,
        execFile: async (_file, _args, options) => {
          capturedEnv = options.env;
          return { stdout: 'https://example.test/rc/session_ENV', stderr: '' };
        },
      });

      const record = await spawner.spawn({ preloadPrompt: 'brief', title: 'meal-planning' });
      expect(record.status).toBe('spawned');

      expect(capturedEnv).toBeDefined();
      // Every stripped key is absent from the child env...
      for (const key of STRIPPED_AUTH_ENV_VARS) {
        expect(capturedEnv![key]).toBeUndefined();
        expect(key in capturedEnv!).toBe(false);
      }
      // ...while unrelated vars (PATH, our sentinel) are preserved intact.
      expect(capturedEnv!.SPAWN_TEST_SENTINEL).toBe('keep-me');
      expect(capturedEnv!.PATH).toBe(process.env.PATH);
      // The parent process env is untouched (we copied, not mutated).
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-secret');
    } finally {
      // Restore the parent env exactly.
      for (const key of Object.keys(process.env)) {
        if (!(key in priorEnv)) delete process.env[key];
      }
      Object.assign(process.env, priorEnv);
    }
  });

  it('CALLER GROUP: a valid group is added to the child env as SESSION_SPAWN_GROUP', async () => {
    const notify = new FakeDispatcher();
    const log = captureLogger();

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawner = createSessionSpawner({
      command: ['some-rc-tool', 'spawn'],
      notify,
      log,
      execFile: async (_file, _args, options) => {
        capturedEnv = options.env;
        return { stdout: 'https://example.test/rc/session_GRP', stderr: '' };
      },
    });

    const record = await spawner.spawn({ preloadPrompt: 'brief', title: 'meal-planning', group: 'kitchen' });

    expect(record.status).toBe('spawned');
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.SESSION_SPAWN_GROUP).toBe('kitchen');
  });

  it('CALLER GROUP: an absent group means SESSION_SPAWN_GROUP is not set', async () => {
    const notify = new FakeDispatcher();
    const log = captureLogger();

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawner = createSessionSpawner({
      command: ['some-rc-tool', 'spawn'],
      notify,
      log,
      execFile: async (_file, _args, options) => {
        capturedEnv = options.env;
        return { stdout: 'https://example.test/rc/session_NOGRP', stderr: '' };
      },
    });

    const record = await spawner.spawn({ preloadPrompt: 'brief', title: 'meal-planning' });

    expect(record.status).toBe('spawned');
    expect(capturedEnv).toBeDefined();
    expect('SESSION_SPAWN_GROUP' in capturedEnv!).toBe(false);
  });

  it('CALLER GROUP: an invalid group is dropped (not passed to the child env) and does not error the spawn', async () => {
    const notify = new FakeDispatcher();
    const log = captureLogger();

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawner = createSessionSpawner({
      command: ['some-rc-tool', 'spawn'],
      notify,
      log,
      execFile: async (_file, _args, options) => {
        capturedEnv = options.env;
        return { stdout: 'https://example.test/rc/session_BADGRP', stderr: '' };
      },
    });

    // Uppercase, spaces, and shell-metacharacters must all be rejected.
    for (const badGroup of ['Kitchen', 'kitchen tag', 'kitchen;rm -rf', 'a'.repeat(33)]) {
      capturedEnv = undefined;
      const record = await spawner.spawn({ preloadPrompt: 'brief', title: 'meal-planning', group: badGroup });

      expect(record.status).toBe('spawned');
      expect(capturedEnv).toBeDefined();
      expect('SESSION_SPAWN_GROUP' in capturedEnv!).toBe(false);
    }

    const logs = log.lines.join('\n');
    expect(logs).toContain('invalid group');
  });

  it('unconfigured (no command): returns not_configured and dispatches nothing', async () => {
    const notify = new FakeDispatcher();
    const log = captureLogger();
    const spawner = createSessionSpawner({ command: undefined, notify, log });

    const record = await spawner.spawn({ preloadPrompt: 'brief', title: 'meal-planning' });

    expect(record.status).toBe('not_configured');
    expect(record.spawnId).toBeTruthy();
    expect(record.notificationId).toBeUndefined();
    expect(notify.calls).toHaveLength(0);
  });
});
