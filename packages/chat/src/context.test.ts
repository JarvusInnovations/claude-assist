import { describe, expect, it } from 'bun:test';
import { buildContextHook, parseContextCommands } from './context.js';
import type { FastifyBaseLogger } from 'fastify';
import type {
  HookInput,
  SyncHookJSONOutput,
  UserPromptSubmitHookSpecificOutput,
} from '@anthropic-ai/claude-agent-sdk';

const PROMPT_INPUT = {
  hook_event_name: 'UserPromptSubmit',
  prompt: 'hello',
  session_id: 'test',
  transcript_path: '/dev/null',
  cwd: '/',
} as unknown as HookInput;

async function runHook(commands: string[][], env: Record<string, string> = {}) {
  const matcher = buildContextHook(commands, { PATH: process.env.PATH ?? '', ...env }, '/tmp');
  const hook = matcher.hooks[0]!;
  const output = (await hook(PROMPT_INPUT, undefined, {
    signal: new AbortController().signal,
  })) as SyncHookJSONOutput;
  return {
    output,
    hookSpecificOutput: output.hookSpecificOutput as
      | UserPromptSubmitHookSpecificOutput
      | undefined,
  };
}

describe('buildContextHook', () => {
  it('combines stdout of multiple commands into labeled live sections', async () => {
    const { hookSpecificOutput } = await runHook([
      ['/bin/echo', 'alpha output'],
      ['/bin/echo', '-n', 'beta output'],
    ]);
    const context = hookSpecificOutput?.additionalContext ?? '';
    expect(hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    expect(context).toContain('## /bin/echo alpha output (live)');
    expect(context).toContain('alpha output');
    expect(context).toContain('## /bin/echo -n beta output (live)');
    expect(context).toContain('beta output');
    // Sections are ordered as configured
    expect(context.indexOf('alpha output')).toBeLessThan(context.indexOf('beta output'));
  });

  it('trims command stdout', async () => {
    const { hookSpecificOutput } = await runHook([['/bin/echo', 'padded']]);
    expect(hookSpecificOutput?.additionalContext).toBe('## /bin/echo padded (live)\n\npadded');
  });

  it('fails soft when a command does not exist', async () => {
    const { hookSpecificOutput } = await runHook([
      ['/nonexistent/definitely-not-a-real-cli'],
      ['/bin/echo', 'still works'],
    ]);
    const context = hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain(
      '## /nonexistent/definitely-not-a-real-cli (unavailable this turn:',
    );
    expect(context).toContain('still works');
  });

  it('fails soft when a command exits non-zero', async () => {
    const { hookSpecificOutput } = await runHook([['/bin/sh', '-c', 'exit 3']]);
    const context = hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('(unavailable this turn:');
    expect(context).not.toContain('(live)');
  });

  it('returns an empty result when no commands are configured', async () => {
    const { output } = await runHook([]);
    expect(output).toEqual({});
  });
});

function stubLogger(): { log: FastifyBaseLogger; warnings: unknown[] } {
  const warnings: unknown[] = [];
  const log = {
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
  } as unknown as FastifyBaseLogger;
  return { log, warnings };
}

describe('parseContextCommands', () => {
  it('returns [] when unset', () => {
    const { log, warnings } = stubLogger();
    expect(parseContextCommands(undefined, log)).toEqual([]);
    expect(parseContextCommands('', log)).toEqual([]);
    expect(warnings).toHaveLength(0);
  });

  it('treats string elements as single-element argvs', () => {
    const { log } = stubLogger();
    expect(parseContextCommands('["status-cli", "other-cli"]', log)).toEqual([
      ['status-cli'],
      ['other-cli'],
    ]);
  });

  it('accepts argv arrays and mixed shapes', () => {
    const { log } = stubLogger();
    expect(
      parseContextCommands('["status-cli", ["node", "/path/script.mjs", "--flag"]]', log),
    ).toEqual([['status-cli'], ['node', '/path/script.mjs', '--flag']]);
  });

  it('returns [] and warns on malformed JSON', () => {
    const { log, warnings } = stubLogger();
    expect(parseContextCommands('not json', log)).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('returns [] and warns on wrong shapes', () => {
    const { log, warnings } = stubLogger();
    expect(parseContextCommands('{"cmd": "x"}', log)).toEqual([]);
    expect(parseContextCommands('[42]', log)).toEqual([]);
    expect(parseContextCommands('[[]]', log)).toEqual([]);
    expect(parseContextCommands('[["ok", 5]]', log)).toEqual([]);
    expect(parseContextCommands('[""]', log)).toEqual([]);
    expect(warnings).toHaveLength(5);
  });
});
