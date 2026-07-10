/**
 * Notification + heartbeat contracts.
 *
 * These interfaces live in core (not in the notify package) so that any module
 * — google, sessions, future pipelines — can call `fastify.notify` and
 * `fastify.heartbeats` with full type-safety without taking a dependency on the
 * notify package. The notify package implements them; core only declares the
 * shape and augments the Fastify instance.
 *
 * The single dispatcher entry point is `notify()`. Priority tiers map to the
 * "interrupts are earned" principle:
 *   - `interrupt` — Pushover high-priority (reaches phone + watch); only for
 *     things that genuinely can't wait.
 *   - `notice`    — Pushover normal priority.
 *   - `digest`    — Slack DM, batched and flushed on a schedule.
 */

export type NotificationPriority = 'interrupt' | 'notice' | 'digest';

export type NotificationChannel = 'pushover' | 'slack';

export interface NotifyInput {
  /** Priority tier — governs channel + delivery urgency. */
  priority: NotificationPriority;
  /** Short headline. */
  title: string;
  /** Body text. */
  body: string;
  /**
   * Optional link. Session-control (RC takeover) links are delivered but never
   * stored in plaintext — the notifications log keeps only a redacted form.
   */
  url?: string;
  /**
   * Force a specific channel set, overriding the priority default. Lets a
   * caller (or a test) fan a single dispatch out to both channels at once.
   */
  channelHints?: NotificationChannel[];
}

export type NotificationStatus = 'sent' | 'pending' | 'error';

export interface NotifyResult {
  /** notifications table row id. */
  id: number;
  priority: NotificationPriority;
  /** Channels the dispatch actually reached. Empty while a digest is pending. */
  deliveredVia: NotificationChannel[];
  status: NotificationStatus;
  /** Per-channel delivery errors, if any. */
  errors?: string[];
}

/** The single dispatcher entry point every pipeline delivers through. */
export interface NotifyDispatcher {
  notify(input: NotifyInput): Promise<NotifyResult>;
}

export interface HeartbeatOptions {
  /**
   * Postgres interval string (e.g. `'12 hours'`, `'48 hours'`, `'9 days'`).
   * Used when a `beat()` auto-registers a not-yet-known pipeline.
   */
  threshold?: string;
  /**
   * `heartbeat` (default) reads staleness from `last_success_at`; `manual`
   * reads it from an external coverage-ledger file at `ledgerPath`.
   */
  source?: 'heartbeat' | 'manual';
  /** For `manual` source: path to the ledger file, relative to the Hari repo. */
  ledgerPath?: string;
  metadata?: Record<string, unknown>;
}

export interface HeartbeatRegistration extends HeartbeatOptions {
  name: string;
  /** Required for explicit registration. */
  threshold: string;
}

export interface HeartbeatRow {
  name: string;
  last_success_at: Date | null;
  threshold_interval: string;
  source: 'heartbeat' | 'manual';
  ledger_path: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/**
 * The coverage-ledger registry. Pipelines register a ledger + threshold; a
 * successful run calls `beat()`. The daily staleness monitor reads `list()`.
 */
export interface HeartbeatRegistry {
  /** Upsert a pipeline registration (threshold/source/ledger/metadata). */
  register(reg: HeartbeatRegistration): Promise<void>;
  /**
   * Record a successful run. Auto-registers the pipeline (with `opts.threshold`)
   * on first call, so per-account / per-machine names track without pre-listing.
   */
  beat(name: string, opts?: HeartbeatOptions): Promise<void>;
  /** Enumerate every registered pipeline. */
  list(): Promise<HeartbeatRow[]>;
}
