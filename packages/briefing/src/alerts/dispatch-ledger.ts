/**
 * Dedup ledger for meeting alerts — guarantees exactly-one dispatch per
 * qualifying occurrence, even across service restarts and overlapping cycles.
 *
 * `claim()` atomically inserts the instance `event_id` (unique) and returns
 * whether THIS caller won the claim; only the winner dispatches. A restart
 * mid-day re-reads these rows implicitly (the insert conflicts) and never
 * double-fires.
 */

import type postgres from 'postgres';
import type { AlertPlanItem } from '../types.js';

export interface DispatchLedger {
  /** Atomically claim an occurrence. Returns true iff this caller should fire. */
  claim(item: AlertPlanItem): Promise<boolean>;
  /** Attach the notify.notifications row id after a successful dispatch. */
  recordNotify(eventId: string, notifyId: number): Promise<void>;
}

export class PgDispatchLedger implements DispatchLedger {
  constructor(private sql: postgres.Sql) {}

  async claim(item: AlertPlanItem): Promise<boolean> {
    const fireAt = item.fireAtMs != null ? new Date(item.fireAtMs) : new Date();
    const rows = await this.sql<{ event_id: string }[]>`
      INSERT INTO briefing.alert_dispatches (event_id, series_id, summary, fire_at)
      VALUES (${item.event.id}, ${item.event.seriesId}, ${item.event.summary}, ${fireAt})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    `;
    return rows.length > 0;
  }

  async recordNotify(eventId: string, notifyId: number): Promise<void> {
    await this.sql`
      UPDATE briefing.alert_dispatches SET notify_id = ${notifyId}
      WHERE event_id = ${eventId}
    `;
  }
}

/** In-memory ledger for tests: a Set of claimed event ids. */
export class MemoryDispatchLedger implements DispatchLedger {
  readonly claimed = new Set<string>();
  readonly notifyIds = new Map<string, number>();

  constructor(alreadyClaimed: string[] = []) {
    for (const id of alreadyClaimed) this.claimed.add(id);
  }

  async claim(item: AlertPlanItem): Promise<boolean> {
    if (this.claimed.has(item.event.id)) return false;
    this.claimed.add(item.event.id);
    return true;
  }

  async recordNotify(eventId: string, notifyId: number): Promise<void> {
    this.notifyIds.set(eventId, notifyId);
  }
}
