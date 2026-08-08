/**
 * Postgres advisory locks — the coordination primitive for scheduled work.
 *
 * Spec: `specs/behaviors/scheduled-work-leases.md`.
 *
 * Why advisory and not a lock table: there is no row to lock (the thing being
 * serialized is an *execution*, not a record), and a session-scoped advisory
 * lock is released automatically when its connection closes. A crashed process
 * therefore leaves nothing stuck, which removes the one operational burden a
 * lock table would add.
 *
 * Why `pg_try_advisory_lock` and not the blocking form: a cron task that waits
 * for its predecessor stacks a queue of pending runs behind a slow one and
 * turns a minute-cadence sweep into an unbounded backlog of held connections.
 * Skipping is correct — the work is still there and the next tick will take it.
 */

import type postgres from 'postgres';

/**
 * Hash a task name to the 64-bit key `pg_advisory_lock` takes.
 *
 * FNV-1a over the UTF-8 bytes, split into two 32-bit halves so the key stays
 * inside the signed-64 range Postgres accepts from a JS number without
 * precision loss. A collision serializes two unrelated tasks against each
 * other — wrong, but safe: the failure direction is extra serialization, never
 * double execution.
 */
export function advisoryLockKey(name: string): { hi: number; lo: number } {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let h2 = 0x811c9dc5 ^ 0x5bf03635;
  for (let i = name.length - 1; i >= 0; i--) {
    h2 ^= name.charCodeAt(i);
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  // Signed 32-bit halves — what the two-argument form of the lock functions takes.
  return { hi: h | 0, lo: h2 | 0 };
}

export interface AdvisoryLockResult<T> {
  /** False when another holder had the lock and the work was skipped. */
  acquired: boolean;
  value?: T;
}

/**
 * Run `fn` while holding the advisory lock for `name`, or skip if another
 * holder has it.
 *
 * The lock is taken on a **reserved connection** so that acquire, work, and
 * release all happen on the same session — taking it from a pool without
 * reserving would let the release land on a different connection and leave the
 * lock held until that session ends.
 */
export async function withAdvisoryLock<T>(
  sql: postgres.Sql,
  name: string,
  fn: () => Promise<T>,
): Promise<AdvisoryLockResult<T>> {
  const { hi, lo } = advisoryLockKey(name);
  const reserved = await sql.reserve();
  let held = false;
  try {
    const rows = await reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${hi}::int, ${lo}::int) AS locked
    `;
    held = rows[0]?.locked === true;
    if (!held) {
      return { acquired: false };
    }
    const value = await fn();
    return { acquired: true, value };
  } finally {
    if (held) {
      try {
        await reserved`SELECT pg_advisory_unlock(${hi}::int, ${lo}::int)`;
      } catch {
        // The session is going away anyway; Postgres drops the lock with it.
      }
    }
    reserved.release();
  }
}
