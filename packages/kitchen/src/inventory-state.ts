/**
 * Inventory item state machine (mirrors src/state.ts for entries).
 *
 *   stocked ──opened──> open
 *      │                 │
 *      ├──finished──────>├──finished──> finished (terminal)
 *      └──tossed────────>└──tossed────> tossed  (terminal)
 *
 * Opening stamps opened_at and re-derives eat_by; finishing/tossing stamps
 * closed_at and zeroes on_hand_fraction. This module encodes only which
 * *state* moves are legal — the pipeline applies the side effects.
 */

import type { InventoryEventType, InventoryState } from './inventory-types.js';

export class InvalidTransitionError extends Error {
  constructor(state: InventoryState, event: InventoryEventType) {
    super(`Invalid inventory transition: ${state} + ${event}`);
    this.name = 'InvalidInventoryTransitionError';
  }
}

/** Compute the next state for an item + event, or throw InvalidTransitionError. */
export function transitionInventory(state: InventoryState, event: InventoryEventType): InventoryState {
  switch (event) {
    case 'opened':
      if (state === 'stocked') return 'open';
      // Re-opening an already-open item is a harmless no-op (idempotent), but a
      // terminal item can't be re-opened.
      if (state === 'open') return 'open';
      throw new InvalidTransitionError(state, event);

    case 'finished':
      if (state === 'stocked' || state === 'open') return 'finished';
      throw new InvalidTransitionError(state, event);

    case 'tossed':
      if (state === 'stocked' || state === 'open') return 'tossed';
      throw new InvalidTransitionError(state, event);
  }
}

/** A terminal item is finished or tossed — no further events apply. */
export function isTerminal(state: InventoryState): boolean {
  return state === 'finished' || state === 'tossed';
}
