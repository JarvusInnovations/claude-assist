/**
 * Session-spawn contract — the generic "warm an interactive session and hand
 * its takeover link to the notification dispatcher" service
 * (specs/modules/session-spawn.md).
 *
 * These interfaces live in core (like the notify contracts) so any module —
 * kitchen, a future scheduler — can call `fastify.sessionSpawner` with full
 * type-safety without depending on the implementation package. The
 * session-spawn package implements them; core only declares the shape and
 * augments the Fastify instance.
 *
 * The invariant these types encode: a `SpawnRecord` NEVER carries the takeover
 * link. The link travels only in the dispatched push (redacted at rest by the
 * dispatcher). A caller that returns a `SpawnRecord` verbatim therefore cannot
 * leak the session handle.
 */

/** What a caller hands the spawner to request a warm session. */
export interface SpawnRequest {
  /**
   * The warm-start briefing the spawned session opens with. Written to a temp
   * file and passed to the configured command as its final argument — never as
   * a shell-visible argument.
   */
  preloadPrompt: string;
  /** Short human label for the session, used in the push title (e.g. "meal-planning"). */
  title: string;
  /**
   * Optional short caller tag (e.g. "kitchen"), passed to the spawn command as
   * `SESSION_SPAWN_GROUP` so the command can route/organize sessions by caller.
   * Must match `^[a-z0-9-]{1,32}$`; an invalid value is treated as absent (see
   * the session-spawn module spec). What the command does with it is instance
   * configuration, outside this module's concern.
   */
  group?: string;
  /**
   * Optional model override for the spawned session — an alias (`opus`,
   * `sonnet`) or a full model name — passed to the spawn command as
   * `SESSION_SPAWN_MODEL`. Must match `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`; an
   * invalid value falls through to the instance-wide default (see the module
   * spec's § Model selection). Omit to take the instance default.
   *
   * This is the model an interactive HUMAN session runs on under subscription
   * auth — never one of the metered per-module API models.
   */
  model?: string;
}

export type SpawnStatus = 'spawned' | 'failed' | 'not_configured';

/**
 * The outcome of a spawn attempt. Deliberately carries NO takeover link (in any
 * form): the link exists only in the delivered push payload.
 */
export interface SpawnRecord {
  status: SpawnStatus;
  /** Opaque id (ULID) for this spawn attempt; correlates logs ↔ request without exposing the link. */
  spawnId: string;
  /** `notify.notifications` row id of the dispatched push, when one was dispatched. */
  notificationId?: number;
  /** Failure reason, already redacted; present only for `failed`. */
  reason?: string;
}

/** The single entry point callers use to request a warm session. */
export interface SessionSpawner {
  spawn(request: SpawnRequest): Promise<SpawnRecord>;
}
