import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

const execFileAsync = promisify(execFile);

/** Per-command wall-clock budget — a slow CLI must not stall the whole turn. */
const COMMAND_TIMEOUT_MS = 15_000;

/** Cap per-command stdout so a runaway CLI can't flood the prompt. */
const MAX_BUFFER_BYTES = 1024 * 1024;

/** Render one argv array as a human-readable heading label. */
function commandLabel(argv: string[]): string {
  return argv.join(' ');
}

/** Collapse an error to a single line so a failure stays a one-line section. */
function oneLineMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Run a single context command and render it as a markdown section.
 * Fail-soft: any error (missing binary, non-zero exit, timeout) becomes an
 * "(unavailable this turn)" note rather than a thrown error — a broken CLI
 * must never block a chat turn.
 */
async function runCommandSection(
  argv: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<string> {
  const label = commandLabel(argv);
  try {
    const [command, ...args] = argv;
    if (!command) throw new Error('empty command');
    const { stdout } = await execFileAsync(command, args, {
      env,
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    return `## ${label} (live)\n\n${stdout.trim()}`;
  } catch (err) {
    return `## ${label} (unavailable this turn: ${oneLineMessage(err)})`;
  }
}

/**
 * Build a UserPromptSubmit hook matcher that injects live context into every
 * turn by running the configured commands and attaching their stdout as
 * additionalContext.
 *
 * Why UserPromptSubmit rather than SessionStart: SDK sessions feed the agent
 * through streaming input, and SessionStart hooks do not fire in that mode —
 * so orientation views that interactive sessions get at startup never reach
 * the agent. UserPromptSubmit fires for each submitted message, which has two
 * upsides: the views are re-run every turn so they never go stale across a
 * long-lived conversation, and the injected output rides in per-turn context
 * instead of the prompt prefix, keeping the cacheable prefix stable.
 *
 * Commands run in parallel with a per-command timeout and are individually
 * fail-soft; cwd should be the agent's working repo so version-manager shims
 * resolve tool versions correctly.
 */
export function buildContextHook(
  commands: string[][],
  env: Record<string, string>,
  cwd: string,
): HookCallbackMatcher {
  return {
    hooks: [
      async () => {
        if (commands.length === 0) return {};
        const sections = await Promise.all(
          commands.map((argv) => runCommandSection(argv, env, cwd)),
        );
        return {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit' as const,
            additionalContext: sections.join('\n\n'),
          },
        };
      },
    ],
  };
}

/**
 * Parse the CHAT_CONTEXT_COMMANDS env var — a JSON array whose elements are
 * each either a command string (single-element argv) or an argv array of
 * strings. Malformed input is logged and treated as empty rather than
 * failing boot.
 */
export function parseContextCommands(
  raw: string | undefined,
  log: FastifyBaseLogger,
): string[][] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    return parsed.map((entry) => {
      if (typeof entry === 'string' && entry.length > 0) return [entry];
      if (
        Array.isArray(entry) &&
        entry.length > 0 &&
        entry.every((item) => typeof item === 'string' && item.length > 0)
      ) {
        return entry as string[];
      }
      throw new Error(
        'each command must be a non-empty string or a non-empty array of strings',
      );
    });
  } catch (err) {
    log.warn({ err }, 'CHAT_CONTEXT_COMMANDS is malformed — no context commands registered');
    return [];
  }
}
