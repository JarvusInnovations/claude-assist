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
}

export function createSessionSpawner(config: SessionSpawnerConfig): SessionSpawner {
  const { notify, log } = config;
  const command = config.command && config.command.length > 0 ? config.command : undefined;
  const timeoutMs = config.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;

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
        const result = await execFileAsync(bin!, argv, {
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER_BYTES,
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

      log.info({ spawnId, notificationId }, 'Session spawned; takeover link dispatched');
      return { status: 'spawned', spawnId, notificationId };
    } finally {
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  return { spawn };
}
