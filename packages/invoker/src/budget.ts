/**
 * Rolling-window budget tracking.
 *
 * The window total is held **in memory**, seeded from the spend ledger at
 * startup and re-read periodically, so the common path — the check before
 * every call — costs no query. The ledger stays authoritative; this is a
 * cache with a known refresh interval, not a second source of truth.
 */

import type { SpendStorePort } from './store.js';

export interface BudgetLimits {
  dailyUsd?: number;
  dailyTokens?: number;
  /** Per-task dollar ceilings, for pinning one noisy pipeline. */
  taskUsd?: Record<string, number>;
}

export type BudgetVerdict =
  | { ok: true }
  | { ok: false; scope: 'global' | string; limitUsd?: number; limitTokens?: number };

export interface BudgetTrackerDeps {
  store: SpendStorePort;
  limits: BudgetLimits;
  /** How stale the in-memory total may get before a re-read. Default 60s. */
  refreshMs?: number;
  now?: () => Date;
}

export interface BudgetTracker {
  /** Check before a call. Cheap: no query on the common path. */
  check(task: string): Promise<BudgetVerdict>;
  /** Fold a completed call into the in-memory totals. */
  add(task: string, tokens: number, costMicros: number): void;
  /** Extra dollars a human approved for the remainder of the window. */
  grantOverage(usd: number): void;
  snapshot(): {
    windowStart: Date;
    calls: number;
    tokens: number;
    costUsd: number;
    approvedOverageUsd: number;
  };
  /** Force a ledger re-read (startup, and after a window rollover). */
  refresh(): Promise<void>;
}

/** Start of the current rolling window: midnight UTC of the given instant. */
export function windowStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function createBudgetTracker(deps: BudgetTrackerDeps): BudgetTracker {
  const now = deps.now ?? (() => new Date());
  const refreshMs = deps.refreshMs ?? 60_000;

  let start = windowStart(now());
  let calls = 0;
  let tokens = 0;
  let costMicros = 0;
  let byTaskMicros = new Map<string, number>();
  let overageMicros = 0;
  // Seeded as "just read" so construction doesn't imply a query. The plugin
  // calls refresh() once at boot to load the day's existing spend; after that
  // the periodic re-read keeps this process honest about concurrent writers.
  let lastRead = Date.now();

  async function reload(): Promise<void> {
    const [totals, tasks] = await Promise.all([
      deps.store.totalsSince(start),
      deps.store.taskTotalsSince(start),
    ]);
    calls = totals.calls;
    tokens = totals.tokens;
    costMicros = totals.costMicros;
    byTaskMicros = new Map(tasks.map((t) => [t.task, Math.round(t.costUsd * 1_000_000)]));
    lastRead = Date.now();
  }

  /**
   * Roll the window when the day turns. An approved overage does **not**
   * survive the roll: it was consent to overspend *this* window, and carrying
   * it forward would quietly turn a one-time approval into a raised ceiling.
   */
  function rollIfNeeded(): boolean {
    const current = windowStart(now());
    if (current.getTime() === start.getTime()) return false;
    start = current;
    calls = 0;
    tokens = 0;
    costMicros = 0;
    byTaskMicros = new Map();
    overageMicros = 0;
    lastRead = Date.now();
    return true;
  }

  return {
    async refresh() {
      rollIfNeeded();
      await reload();
    },

    async check(task) {
      if (rollIfNeeded()) {
        // A fresh window starts empty; no query needed to know that.
        return { ok: true };
      }
      if (Date.now() - lastRead > refreshMs) {
        try {
          await reload();
        } catch {
          // A ledger read failure must not block work. The in-memory total is
          // still a lower bound on spend, which is the safe direction: it can
          // under-report a concurrent writer, never over-report this process.
        }
      }

      const { dailyUsd, dailyTokens, taskUsd } = deps.limits;
      if (dailyUsd !== undefined && costMicros >= dailyUsd * 1_000_000 + overageMicros) {
        return { ok: false, scope: 'global', limitUsd: dailyUsd };
      }
      if (dailyTokens !== undefined && tokens >= dailyTokens) {
        return { ok: false, scope: 'global', limitTokens: dailyTokens };
      }
      const taskLimit = taskUsd?.[task];
      if (taskLimit !== undefined && (byTaskMicros.get(task) ?? 0) >= taskLimit * 1_000_000) {
        return { ok: false, scope: task, limitUsd: taskLimit };
      }
      return { ok: true };
    },

    add(task, addedTokens, addedMicros) {
      rollIfNeeded();
      calls += 1;
      tokens += addedTokens;
      costMicros += addedMicros;
      byTaskMicros.set(task, (byTaskMicros.get(task) ?? 0) + addedMicros);
    },

    grantOverage(usd) {
      overageMicros += Math.round(usd * 1_000_000);
    },

    snapshot() {
      return {
        windowStart: start,
        calls,
        tokens,
        costUsd: costMicros / 1_000_000,
        approvedOverageUsd: overageMicros / 1_000_000,
      };
    },
  };
}
