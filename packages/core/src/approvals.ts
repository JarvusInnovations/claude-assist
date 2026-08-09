/**
 * Human-approval contract.
 *
 * Lives in core so any module can raise a gate without depending on the
 * approvals package; the approvals package implements it.
 *
 * Spec: `specs/modules/approvals.md`.
 *
 * The rule that shapes this whole interface: **nothing ever blocks waiting for
 * a human.** `request()` writes a row, dispatches a notification, and returns.
 * A requester that needs to know whether its gate opened asks again on a later
 * pass via `findResolved(dedupeKey)` — it does not await, and it does not poll
 * in a loop while holding a lease or a concurrency slot.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export type ApprovalDecision = 'approved' | 'denied';

export interface ApprovalRequestInput {
  /** Caller-defined class, e.g. `model_budget_overage`. */
  kind: string;
  /** The module or task raising the gate. */
  requestedBy: string;
  /** Notification headline. */
  title: string;
  /** Notification body — what is being asked, with the salient numbers. */
  body: string;
  /** Arbitrary JSON the requester needs back at resolve time. */
  payload?: Record<string, unknown>;
  /**
   * Unique among *pending* rows. A sweep that hits the same wall every minute
   * must not notify every minute; the key is what prevents that.
   */
  dedupeKey?: string;
  /** Overrides the configured default expiry. */
  expiresInMs?: number;
  /** Notification priority. Defaults to `notice`; `interrupt` must be earned. */
  priority?: 'interrupt' | 'notice' | 'digest';
  /** Link a human can open to act on the request. */
  url?: string;
}

export interface ApprovalResolution {
  decision: ApprovalDecision;
  note?: string;
  /** Decision parameters, e.g. `{ overageUsd: 5 }`. */
  params?: Record<string, unknown>;
}

export interface ApprovalRecord {
  id: string;
  kind: string;
  requestedBy: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  dedupeKey: string | null;
  resolution: ApprovalResolution | null;
  resolvedBy: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
}

export interface ApprovalListFilter {
  status?: ApprovalStatus;
  kind?: string;
  limit?: number;
}

/** Raised when resolving a request that is no longer pending. */
export class ApprovalConflictError extends Error {
  readonly id: string;
  readonly status: ApprovalStatus;

  constructor(id: string, status: ApprovalStatus) {
    super(`Approval ${id} is already ${status}`);
    this.name = 'ApprovalConflictError';
    this.id = id;
    this.status = status;
  }
}

export interface ApprovalService {
  /**
   * Record a gate and notify. Returns immediately. When `dedupeKey` matches an
   * existing pending row, returns that row instead of raising a second one and
   * sends no additional notification.
   */
  request(input: ApprovalRequestInput): Promise<ApprovalRecord>;
  get(id: string): Promise<ApprovalRecord | null>;
  list(filter?: ApprovalListFilter): Promise<ApprovalRecord[]>;
  /** Throws `ApprovalConflictError` when the request is not pending. */
  resolve(id: string, resolution: ApprovalResolution, resolvedBy?: string): Promise<ApprovalRecord>;
  /**
   * The most recently resolved request for a dedupe key. How a requester
   * learns on a later pass that its gate opened, without ever having waited.
   */
  findResolved(dedupeKey: string): Promise<ApprovalRecord | null>;
}
