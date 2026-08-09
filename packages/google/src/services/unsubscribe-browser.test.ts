import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChromeDevtoolsBrowserDriver,
  parseEvalJson,
  type CommandRunner,
} from './unsubscribe-browser.js';

/** A scripted CLI: matches on the first arg (+ a substring of the second). */
function scriptedRunner(
  script: Array<{ verb: string; contains?: string; stdout?: string; throws?: string }>
) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const runner: CommandRunner = async (bin, args) => {
    calls.push({ bin, args });
    for (const step of script) {
      if (step.verb !== args[0]) continue;
      if (step.contains && !(args[1] ?? '').includes(step.contains)) continue;
      if (step.throws) throw new Error(step.throws);
      return { stdout: step.stdout ?? '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  return { runner, calls };
}

async function proofPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'unsub-proof-'));
  return join(dir, 'shot.png');
}

describe('parseEvalJson', () => {
  it('pulls JSON out of stdout that carries banner noise', () => {
    expect(parseEvalJson('connected to bridge\n{"login":false,"candidates":1}\n')).toEqual({
      login: false,
      candidates: 1,
    });
  });

  it('unwraps a JSON string result (the CLI double-encodes our return value)', () => {
    expect(parseEvalJson('"{\\"candidates\\":2}"')).toEqual({ candidates: 2 });
  });

  it('returns null when there is nothing parseable', () => {
    expect(parseEvalJson('command not found')).toBeNull();
  });

  // Captured verbatim from a real bridge: `result:` line, doubly string-encoded
  // payload, trailing help block. This shape is why the parser exists.
  it('handles the real observed CLI output shape', () => {
    const stdout =
      'result: "\\"{\\\\\\"login\\\\\\":false,\\\\\\"candidates\\\\\\":1,\\\\\\"texts\\\\\\":[\\\\\\"Unsubscribe\\\\\\"]}\\""\n' +
      'help[1]:\n  Run `browser-cli snapshot` to see current page state';
    expect(parseEvalJson(stdout)).toEqual({
      login: false,
      candidates: 1,
      texts: ['Unsubscribe'],
    });
  });
});

describe('preflight rejects a bridge that answers with an error', () => {
  it('treats an `Error:` payload as not ready even on a zero exit code', async () => {
    const { runner } = scriptedRunner([
      {
        verb: 'eval',
        stdout: 'result: "Error: The selected page has been closed."\nhelp[1]:\n  Run snapshot',
      },
    ]);
    const driver = new ChromeDevtoolsBrowserDriver({ bin: 'browser-cli', runner });
    expect(await driver.preflight()).toMatchObject({ ok: false });
  });
});

describe('cold-bridge recovery', () => {
  it('retries through `newpage` when `open` navigated nothing', async () => {
    let probes = 0;
    const runner = async (bin: string, args: string[]) => {
      if (args[0] === 'eval' && args[1] === '1+1') return { stdout: 'result: "2"', stderr: '' };
      if (args[0] === 'eval' && (args[1] ?? '').includes('login')) {
        probes += 1;
        // First probe (after `open`) sees no page; the one after `newpage` does.
        return {
          stdout: probes === 1 ? 'result: "Error: no page"' : '{"login":false,"candidates":1}',
          stderr: '',
        };
      }
      if (args[0] === 'eval' && (args[1] ?? '').includes('clicked')) {
        return { stdout: '{"clicked":true}', stderr: '' };
      }
      if (args[0] === 'eval') return { stdout: '{"confirmed":true}', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const driver = new ChromeDevtoolsBrowserDriver({ bin: 'browser-cli', runner });
    const result = await driver.unsubscribe('https://bulk.test/manage', {
      screenshotPath: await proofPath(),
    });
    expect(result.outcome).toBe('submitted');
    expect(result.steps.some((s) => s.startsWith('newpage + reprobe'))).toBe(true);
  });
});

describe('preflight — the bridge is a live dependency that is often simply absent', () => {
  it('reports ok when the bridge answers', async () => {
    const { runner, calls } = scriptedRunner([{ verb: 'eval', stdout: '2' }]);
    const driver = new ChromeDevtoolsBrowserDriver({ bin: 'browser-cli', runner });
    expect(await driver.preflight()).toMatchObject({ ok: true });
    expect(calls[0]!.args[0]).toBe('eval');
  });

  it('reports not-ok — no throw — when the binary or bridge is missing', async () => {
    const { runner } = scriptedRunner([{ verb: 'eval', throws: 'spawn ENOENT' }]);
    const driver = new ChromeDevtoolsBrowserDriver({ bin: 'browser-cli', runner });
    const result = await driver.preflight();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ENOENT');
  });

  it('unsubscribe exits clean with `unavailable` and never opens a page', async () => {
    const { runner, calls } = scriptedRunner([{ verb: 'eval', throws: 'connect ECONNREFUSED' }]);
    const driver = new ChromeDevtoolsBrowserDriver({ bin: 'browser-cli', runner });
    const result = await driver.unsubscribe('https://bulk.test/manage', {
      screenshotPath: await proofPath(),
    });

    expect(result.outcome).toBe('unavailable');
    expect(result.reason).toContain('unreachable');
    // Preflight failed, so nothing was opened, clicked, or screenshotted.
    expect(calls.map((c) => c.args[0])).toEqual(['eval']);
  });
});

describe('unsubscribe — acts only on an unambiguous page', () => {
  it('clicks the single candidate and reports a confirmed submission', async () => {
    const { runner, calls } = scriptedRunner([
      { verb: 'eval', contains: '1+1', stdout: '2' },
      { verb: 'eval', contains: 'login', stdout: '{"login":false,"candidates":1}' },
      { verb: 'eval', contains: 'clicked', stdout: '{"clicked":true,"label":"Unsubscribe"}' },
      { verb: 'eval', contains: 'confirmed', stdout: '{"confirmed":true}' },
    ]);
    const driver = new ChromeDevtoolsBrowserDriver({ bin: 'browser-cli', runner });
    const path = await proofPath();
    const result = await driver.unsubscribe('https://bulk.test/manage', { screenshotPath: path });

    expect(result.outcome).toBe('submitted');
    expect(result.confirmed).toBe(true);
    expect(result.screenshotPath).toBe(path);
    // A screenshot is taken before the click AND after it: the post-click page
    // is the evidence a human actually wants.
    expect(calls.filter((c) => c.args[0] === 'screenshot')).toHaveLength(2);
    expect(calls.some((c) => c.args[0] === 'open')).toBe(true);
  });

  it('submits but flags an unconfirmed page for human eyes', async () => {
    const { runner } = scriptedRunner([
      { verb: 'eval', contains: '1+1', stdout: '2' },
      { verb: 'eval', contains: 'login', stdout: '{"login":false,"candidates":1}' },
      { verb: 'eval', contains: 'clicked', stdout: '{"clicked":true}' },
      { verb: 'eval', contains: 'confirmed', stdout: '{"confirmed":false}' },
    ]);
    const driver = new ChromeDevtoolsBrowserDriver({ bin: 'browser-cli', runner });
    const result = await driver.unsubscribe('https://bulk.test/manage', {
      screenshotPath: await proofPath(),
    });
    expect(result.outcome).toBe('submitted');
    expect(result.confirmed).toBe(false);
    expect(result.reason).toContain('verify the screenshot');
  });

  it('refuses to click behind a login wall, but keeps the screenshot', async () => {
    const { runner, calls } = scriptedRunner([
      { verb: 'eval', contains: '1+1', stdout: '2' },
      { verb: 'eval', contains: 'login', stdout: '{"login":true,"candidates":1}' },
    ]);
    const driver = new ChromeDevtoolsBrowserDriver({ bin: 'browser-cli', runner });
    const path = await proofPath();
    const result = await driver.unsubscribe('https://bulk.test/manage', { screenshotPath: path });

    expect(result.outcome).toBe('needs_review');
    expect(result.reason).toBe('login wall detected');
    expect(result.screenshotPath).toBe(path);
    expect(calls.some((c) => (c.args[1] ?? '').includes('clicked'))).toBe(false);
  });

  it('refuses to guess when the page offers several candidate controls', async () => {
    const { runner } = scriptedRunner([
      { verb: 'eval', contains: '1+1', stdout: '2' },
      { verb: 'eval', contains: 'login', stdout: '{"login":false,"candidates":3}' },
    ]);
    const driver = new ChromeDevtoolsBrowserDriver({ bin: 'browser-cli', runner });
    const result = await driver.unsubscribe('https://bulk.test/manage', {
      screenshotPath: await proofPath(),
    });
    expect(result.outcome).toBe('needs_review');
    expect(result.reason).toContain('ambiguous');
  });

  it('routes to review when the page has no unsubscribe control at all', async () => {
    const { runner } = scriptedRunner([
      { verb: 'eval', contains: '1+1', stdout: '2' },
      { verb: 'eval', contains: 'login', stdout: '{"login":false,"candidates":0}' },
    ]);
    const driver = new ChromeDevtoolsBrowserDriver({ bin: 'browser-cli', runner });
    const result = await driver.unsubscribe('https://bulk.test/manage', {
      screenshotPath: await proofPath(),
    });
    expect(result.outcome).toBe('needs_review');
    expect(result.reason).toContain('no unsubscribe control');
  });

  it('routes to review when a step fails mid-flight rather than half-acting', async () => {
    const { runner } = scriptedRunner([
      { verb: 'eval', contains: '1+1', stdout: '2' },
      { verb: 'open', throws: 'navigation timeout' },
    ]);
    const driver = new ChromeDevtoolsBrowserDriver({ bin: 'browser-cli', runner });
    const result = await driver.unsubscribe('https://bulk.test/manage', {
      screenshotPath: await proofPath(),
    });
    expect(result.outcome).toBe('needs_review');
    expect(result.reason).toContain('navigation timeout');
  });

  it('routes to review when the control vanishes between probe and click', async () => {
    const { runner } = scriptedRunner([
      { verb: 'eval', contains: '1+1', stdout: '2' },
      { verb: 'eval', contains: 'login', stdout: '{"login":false,"candidates":1}' },
      { verb: 'eval', contains: 'clicked', stdout: '{"clicked":false,"candidates":0}' },
    ]);
    const driver = new ChromeDevtoolsBrowserDriver({ bin: 'browser-cli', runner });
    const result = await driver.unsubscribe('https://bulk.test/manage', {
      screenshotPath: await proofPath(),
    });
    expect(result.outcome).toBe('needs_review');
    expect(result.reason).toContain('vanished');
  });
});
