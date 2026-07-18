/**
 * Kitchen entry status state machine (mirrors capture/src/state.ts).
 *
 * `estimating` doubles as the work queue: a fresh entry with no
 * deterministic source (no recipe reference) starts here; the sweep
 * (pipeline.ts) or an immediate in-request attempt resolves it to
 * `estimated` or, once attempts are exhausted, `failed`.
 *
 * `manual` is the one source that is never re-opened by a model pass: the
 * PATCH route (routes/kitchen.ts) enforces that guard by source (not
 * status) before calling `transition` — this module only encodes which
 * *status* moves are legal, not the source-based immutability rule.
 */

import type { EntryStatus } from './types.js';

export type EntryEvent =
  /** An estimation attempt (model call, in-request or swept) succeeded. */
  | { kind: 'estimated' }
  /** Attempts exhausted; the row stops being selected but stays inspectable. */
  | { kind: 'estimate_capped' }
  /** The owner supplied macros directly. Valid from any status — always terminal. */
  | { kind: 'manual_override' }
  /** A note/label edit re-opens the entry for a fresh model estimate. */
  | { kind: 're_queue' };

export class InvalidTransitionError extends Error {
  constructor(status: EntryStatus, event: EntryEvent) {
    super(`Invalid kitchen entry transition: ${status} + ${event.kind}`);
    this.name = 'InvalidTransitionError';
  }
}

export function transition(status: EntryStatus, event: EntryEvent): EntryStatus {
  switch (event.kind) {
    case 'estimated':
      if (status === 'estimating') return 'estimated';
      throw new InvalidTransitionError(status, event);

    case 'estimate_capped':
      if (status === 'estimating') return 'failed';
      throw new InvalidTransitionError(status, event);

    case 'manual_override':
      // The owner's correction is terminal and always lands — from
      // estimating (interrupts a pending estimate), estimated (revises a
      // model/reselect result), or failed (supplies the label the module
      // never managed to guess).
      return 'estimated';

    case 're_queue':
      if (status === 'estimating' || status === 'estimated' || status === 'failed') {
        return 'estimating';
      }
      throw new InvalidTransitionError(status, event);
  }
}
