/**
 * Audit-ledger contract.
 *
 * Like the notify/heartbeat contracts, this interface lives in core (not in the
 * ledger package) so any module — google's email executor, the notify
 * dispatcher, future automation runtimes — can write a *direct* ledger row via
 * `fastify.ledger.record(...)` with full type-safety and without taking a
 * dependency on the ledger package. The ledger package implements it; core only
 * declares the shape and augments the Fastify instance.
 *
 * The ledger has exactly two sources (see the audit-ledger spec):
 *   - `derived` — a deterministic ruleset classifies external actions out of
 *     already-ingested session tool calls, after the fact. Owned by the ledger
 *     package; not written through this interface.
 *   - `direct`  — transcript-less actors (services) write a row at execution
 *     time through `record()`. THIS interface.
 */

/** Who performed an action. */
export interface LedgerActor {
  /**
   * `session` — a main-chain Claude session; `agent` — a sidechain/subagent;
   * `service` — a transcript-less claude-assist service (direct writes).
   */
  kind: 'session' | 'service' | 'agent';
  /** Session id for `session` / `agent` actors. */
  sessionId?: string;
  /** Whether the action came from a sidechain (subagent) turn. */
  sidechain?: boolean;
  /** Service name for `service` actors (e.g. `email-executor`, `notify`). */
  service?: string;
}

/** A direct action record written by a service at execution time. */
export interface LedgerRecordInput {
  /** Actor — almost always `{ kind: 'service', service: '…' }` for direct rows. */
  actor: LedgerActor;
  /** Broad classification (e.g. `outbound`, `email-action`, `team-record-write`). */
  actionType: string;
  /** The system acted on (e.g. `notification`, `gmail`, `slack`). */
  targetSystem: string;
  /** Stable identifier within the target system, when there is one. */
  targetId?: string | null;
  /** One-line human summary. */
  summary: string;
  /** Pointer to richer context (ids, refs). Stored as jsonb; defaults to `{}`. */
  context?: Record<string, unknown>;
  /** Action time; defaults to now(). */
  ts?: Date | string | null;
}

/**
 * The direct-write entry point. Present only when the ledger module is loaded;
 * callers guard with `fastify.ledger?.record(...)` and never let a ledger
 * failure break the action they are recording.
 */
export interface Ledger {
  record(input: LedgerRecordInput): Promise<{ id: number }>;
}
