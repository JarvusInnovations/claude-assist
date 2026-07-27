/**
 * The generic session spawner (specs/modules/session-spawn.md).
 *
 * Runs a CONFIGURED command that, given a preload prompt, warms an interactive
 * Remote-Control session and prints a takeover URL to stdout. On success the
 * takeover link is dispatched to the phone through the existing notification
 * dispatcher (redacted at rest by the dispatcher); on failure a "couldn't
 * start" push (no link) is dispatched. Either way the returned record carries
 * status + a spawn id and NEVER the link.
 *
 * SECURITY: the raw takeover link exists in exactly one place — the payload
 * handed to `notify()`. It is never put in the returned record and never
 * logged (stdout, which holds it, is never logged). See the module spec's
 * "no-link-in-response invariant".
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type {
  NotifyDispatcher,
  SessionSpawner,
  SpawnRecord,
  SpawnRequest,
} from '@jarvus/claude-assist-core';
import { redactText } from '@jarvus/claude-assist-notify';
import { generateSpawnId } from './ulid.js';

const execFileAsync = promisify(execFile);

/**
 * Injectable exec seam. Defaults to the promisified `execFile`; tests inject a
 * fake to capture the argv + options (notably the sanitized `env`) without
 * running a real command.
 */
export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Claude programmatic-auth environment variables that MUST be stripped from the
 * spawn command's environment.
 *
 * WHY: the spawn command warms an INTERACTIVE Remote-Control session that has to
 * authenticate as the human's claude.ai *subscription* login (the ambient auth
 * in the user's `~/.claude`). The server process, by contrast, carries metered
 * programmatic API credentials in its own env. If those leak into the child,
 * two things break: (1) RC rejects the spawn outright ("Remote Control requires
 * a claude.ai subscription login, not oauth_token"), and (2) it would violate
 * the single-invoker / honest-billing boundary — a human-driven interactive
 * session must never run on the service's metered API credentials. So a spawned
 * session inherits everything else (PATH, HOME, …) but NONE of these.
 */
export const STRIPPED_AUTH_ENV_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

/**
 * Validation rule for a caller-supplied `group` tag: lowercase alphanumerics
 * and hyphens, 1-32 chars. Anything else is rejected (treated as absent)
 * rather than passed unsanitized into a child process environment.
 */
const GROUP_SLUG_RE = /^[a-z0-9-]{1,32}$/;

/** True iff `group` is a safe slug per `GROUP_SLUG_RE`. */
export function isValidSpawnGroup(group: string): boolean {
  return GROUP_SLUG_RE.test(group);
}

/**
 * Validation rule for a model identifier — an alias (`opus`, `sonnet`) or a full
 * model name: alphanumerics plus `. _ : / -`, 1-128 chars, no whitespace and no
 * shell metacharacters. Same defensive posture as `GROUP_SLUG_RE`: neither a
 * caller- nor a config-supplied string reaches a child environment unchecked.
 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** True iff `model` is a safe model identifier per `MODEL_ID_RE`. */
export function isValidSpawnModel(model: string): boolean {
  return MODEL_ID_RE.test(model);
}

/**
 * A shallow copy of `process.env` with the Claude programmatic-auth variables
 * removed, so the spawned interactive session falls back to ambient/subscription
 * auth. Everything else the child needs (PATH, HOME, …) is preserved.
 *
 * When `group` is given, sets `SESSION_SPAWN_GROUP` on the child env so the
 * configured spawn command can route/organize sessions by caller — a short
 * caller tag, e.g. "kitchen". Caller-supplied and MUST already be validated
 * (see `isValidSpawnGroup`) before it reaches here.
 *
 * When `model` is given, sets `SESSION_SPAWN_MODEL` so the command launches the
 * session on an EXPLICIT model rather than whatever the owner last selected
 * interactively (see the module spec's § Model selection). Already validated
 * (see `isValidSpawnModel`) before it reaches here.
 */
function sanitizedSpawnEnv(group?: string, model?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STRIPPED_AUTH_ENV_VARS) {
    delete env[key];
  }
  if (group) {
    env.SESSION_SPAWN_GROUP = group;
  }
  if (model) {
    env.SESSION_SPAWN_MODEL = model;
  } else {
    // Never let the SERVICE's own SESSION_SPAWN_MODEL leak through unvalidated
    // when resolution produced nothing — the wrapper's fallback owns that case.
    delete env.SESSION_SPAWN_MODEL;
  }
  return env;
}

/** Default wall-clock bound for a spawn command. Overridable via config. */
export const DEFAULT_SPAWN_TIMEOUT_MS = 120_000;

/** Cap captured stdout/stderr so a runaway command can't flood memory. */
const MAX_BUFFER_BYTES = 1024 * 1024;

/** The first http(s) URL in a blob of stdout, or null. */
function firstUrl(stdout: string): string | null {
  const match = stdout.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : null;
}

/** Collapse an error/stderr to one short line for a failure reason. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export interface SessionSpawnerConfig {
  /**
   * The configured spawn command as an argv array. The preload-prompt temp
   * file path is appended as the final element at spawn time. Unset/empty ⇒
   * the spawner is disabled (every spawn returns `not_configured`).
   */
  command?: string[];
  /** The dispatch spine. Required — the link travels only via a push. */
  notify: NotifyDispatcher;
  log: FastifyBaseLogger;
  /** Wall-clock bound per spawn (default 120s). */
  timeoutMs?: number;
  /**
   * Instance-wide default model for spawned sessions (from
   * `SESSION_SPAWN_MODEL`). A caller's `SpawnRequest.model` overrides it.
   * Unset/invalid ⇒ no `SESSION_SPAWN_MODEL` in the child env and the wrapper's
   * own fallback applies.
   */
  model?: string;
  /** Exec seam (default: promisified `execFile`). Tests inject a fake. */
  execFile?: ExecFileFn;
}

export function createSessionSpawner(config: SessionSpawnerConfig): SessionSpawner {
  const { notify, log } = config;
  const command = config.command && config.command.length > 0 ? config.command : undefined;
  const timeoutMs = config.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;

  // Instance-wide default model, validated once at construction. A malformed
  // value is a config error the operator should see, but it must not break
  // spawning: warn and treat as unset (the wrapper falls back).
  let defaultModel: string | undefined;
  if (config.model !== undefined && config.model !== '') {
    if (isValidSpawnModel(config.model)) {
      defaultModel = config.model;
    } else {
      log.warn(
        { model: config.model },
        'SESSION_SPAWN_MODEL is malformed — ignored; spawned sessions fall back to the spawn command default',
      );
    }
  }
  const exec: ExecFileFn = config.execFile ?? execFileAsync;

  /** Dispatch a failure push (no link) and return the failed record. */
  async function fail(spawnId: string, title: string, reason: string): Promise<SpawnRecord> {
    // reason is stderr/error text — redact any session-control link before it
    // touches a log or a stored notification.
    const safeReason = redactText(oneLine(reason)) || 'spawn failed';
    log.warn({ spawnId, reason: safeReason }, 'Session spawn failed');
    let notificationId: number | undefined;
    try {
      const res = await notify.notify({
        priority: 'notice',
        title: `Couldn't start your ${title} session`,
        body: 'The session failed to start. Try again in a moment.',
      });
      notificationId = res.id;
    } catch (err) {
      log.error({ err, spawnId }, 'Session-spawn failure push could not be dispatched');
    }
    return { status: 'failed', spawnId, notificationId, reason: safeReason };
  }

  async function spawn(request: SpawnRequest): Promise<SpawnRecord> {
    const spawnId = generateSpawnId();

    if (!command) {
      log.info({ spawnId }, 'Session spawn requested but SESSION_SPAWN_CMD is unset — not configured');
      return { status: 'not_configured', spawnId };
    }

    // Validate the caller-supplied group tag defensively: an invalid value is
    // dropped (treated as absent) with a warning, never passed unsanitized
    // into the child env, and never errors the spawn.
    let group: string | undefined;
    if (request.group !== undefined) {
      if (isValidSpawnGroup(request.group)) {
        group = request.group;
      } else {
        log.warn({ spawnId, group: request.group }, 'Session spawn: invalid group tag ignored');
      }
    }

    // Resolve the model: caller override → instance default → omitted. An
    // invalid caller value degrades to the instance default with a warning,
    // never a broken spawn (same posture as `group`).
    let model = defaultModel;
    if (request.model !== undefined && request.model !== '') {
      if (isValidSpawnModel(request.model)) {
        model = request.model;
      } else {
        log.warn(
          { spawnId, model: request.model },
          'Session spawn: invalid model override ignored — using the instance default',
        );
      }
    }

    // Write the preload prompt to an owner-only temp file; the command receives
    // the PATH as its final argument (never the prompt as a shell-visible arg).
    let dir: string | undefined;
    let promptPath: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'session-spawn-'));
      promptPath = join(dir, 'preload.txt');
      await writeFile(promptPath, request.preloadPrompt, { mode: 0o600 });

      const [bin, ...rest] = command;
      const argv = [...rest, promptPath];

      let stdout: string;
      try {
        // Run with a SANITIZED env: the Claude programmatic-auth vars are
        // stripped so the spawned interactive session authenticates as the
        // human's claude.ai subscription, not the service's metered API creds.
        // See STRIPPED_AUTH_ENV_VARS.
        const result = await exec(bin!, argv, {
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER_BYTES,
          env: sanitizedSpawnEnv(group, model),
        });
        stdout = result.stdout;
      } catch (err) {
        // Non-zero exit or timeout. Prefer the command's stderr as the reason.
        const e = err as { stderr?: string; message?: string; killed?: boolean };
        const reason = e.killed
          ? `spawn command timed out after ${timeoutMs}ms`
          : e.stderr && e.stderr.trim().length > 0
            ? e.stderr
            : e.message ?? 'spawn command failed';
        return await fail(spawnId, request.title, reason);
      }

      const link = firstUrl(stdout);
      if (!link) {
        // Exit 0 but no takeover URL — still a failure.
        return await fail(spawnId, request.title, 'spawn command produced no takeover link');
      }

      // SUCCESS. The raw link goes ONLY to the dispatcher (redacted at rest);
      // it is never logged and never returned.
      let notificationId: number | undefined;
      try {
        const res = await notify.notify({
          priority: 'notice',
          title: `Your ${request.title} session is ready`,
          body: 'Tap to take over.',
          url: link,
          urlTitle: 'Take over',
        });
        notificationId = res.id;
      } catch (err) {
        // The warm session exists but we couldn't hand off the link — that's a
        // failure from the caller's perspective (no way to reach it).
        log.error({ err, spawnId }, 'Session-spawn takeover push could not be dispatched');
        return await fail(spawnId, request.title, 'takeover link could not be delivered');
      }

      // `model` is safe to log (config, not a secret) and is the one detail
      // worth having when a spawned session behaves unexpectedly.
      log.info({ spawnId, notificationId, model }, 'Session spawned; takeover link dispatched');
      return { status: 'spawned', spawnId, notificationId };
    } finally {
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  return { spawn };
}
