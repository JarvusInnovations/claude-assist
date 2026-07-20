/**
 * Session-spawn module — the "spawn a warm interactive session and ping the
 * phone with its takeover link" service (specs/modules/session-spawn.md).
 *
 * Registers as a Fastify plugin that decorates `fastify.sessionSpawner`. The
 * implementation is a stateless command-runner + dispatcher — no schema, no
 * migrations. It requires the notify module (the takeover link travels only in
 * a delivered push); without `fastify.notify` the feature is disabled and the
 * decorator is left absent so callers 503.
 */

import type { FastifyPluginAsync, FastifyBaseLogger } from 'fastify';
import fp from 'fastify-plugin';
import { createSessionSpawner } from './spawner.js';

export interface SessionSpawnPluginOptions {
  /**
   * The configured spawn command as an argv array (parsed from
   * `SESSION_SPAWN_CMD`). Unset/empty ⇒ the spawner is disabled (`spawn()`
   * returns `not_configured`), but the decorator is still installed so callers
   * need not guard on its existence.
   */
  command?: string[];
  /** Wall-clock bound per spawn in ms (default 120000). */
  timeoutMs?: number;
}

const sessionSpawnPlugin: FastifyPluginAsync<SessionSpawnPluginOptions> = async (fastify, opts) => {
  if (!fastify.notify) {
    fastify.log.warn(
      'Session-spawn: notify dispatcher not available — session spawning disabled (takeover links have nowhere safe to go)',
    );
    return;
  }

  const spawner = createSessionSpawner({
    command: opts.command,
    notify: fastify.notify,
    log: fastify.log,
    timeoutMs: opts.timeoutMs,
  });
  fastify.decorate('sessionSpawner', spawner);

  if (opts.command && opts.command.length > 0) {
    fastify.log.info('Session-spawn module loaded (spawn command configured)');
  } else {
    fastify.log.info('Session-spawn module loaded (SESSION_SPAWN_CMD unset — spawning disabled, returns 503)');
  }
};

/**
 * Parse `SESSION_SPAWN_CMD` — a JSON array of non-empty strings (the spawn
 * command's argv). Malformed input is logged and treated as unset (disabled)
 * rather than failing boot, matching `CHAT_CONTEXT_COMMANDS`'s fail-soft parse.
 */
export function parseSpawnCommand(
  raw: string | undefined,
  log: FastifyBaseLogger,
): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((item) => typeof item === 'string' && item.length > 0)
    ) {
      throw new Error('expected a non-empty JSON array of non-empty strings');
    }
    return parsed as string[];
  } catch (err) {
    log.warn({ err }, 'SESSION_SPAWN_CMD is malformed — session spawning disabled');
    return undefined;
  }
}

export default fp(sessionSpawnPlugin, { name: 'session-spawn', fastify: '5.x' });

export {
  createSessionSpawner,
  DEFAULT_SPAWN_TIMEOUT_MS,
  type SessionSpawnerConfig,
} from './spawner.js';
export { generateSpawnId } from './ulid.js';
