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

/**
 * Transitions accepted by the state machine. `dismissed` is not one of the
 * `/events` surface's {opened,finished,tossed} — it rides its own endpoint (it
 * carries a non-inventory flag + fan-out) — but it moves the state machine, so
 * it belongs here.
 */
export type InventoryTransition = InventoryEventType | 'dismissed';

export class InvalidTransitionError extends Error {
  constructor(state: InventoryState, event: InventoryTransition) {
    super(`Invalid inventory transition: ${state} + ${event}`);
    this.name = 'InvalidInventoryTransitionError';
  }
}

/** Compute the next state for an item + event, or throw InvalidTransitionError. */
export function transitionInventory(state: InventoryState, event: InventoryTransition): InventoryState {
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

    case 'finished-unit':
      // Same legal preconditions as `finished` — a counted item's whole-item
      // terminal close is still reachable from stocked/open. The CONCRETE next
      // state (whether the item goes terminal or reverts to a fresh sealed
      // unit) depends on units_remaining after the decrement, which only the
      // pipeline knows; this call just validates legality (mirrors the
      // `tossed` pattern, where the pipeline may also override this result).
      if (state === 'stocked' || state === 'open') return 'finished';
      throw new InvalidTransitionError(state, event);

    case 'tossed':
      if (state === 'stocked' || state === 'open') return 'tossed';
      throw new InvalidTransitionError(state, event);

    case 'dismissed':
      // A non-grocery line removed from inventory (not food waste). Legal from
      // any live state; terminal items can't be dismissed.
      if (state === 'stocked' || state === 'open') return 'dismissed';
      throw new InvalidTransitionError(state, event);
  }
}

/** A terminal item is finished, tossed, or dismissed — no further events apply. */
export function isTerminal(state: InventoryState): boolean {
  return state === 'finished' || state === 'tossed' || state === 'dismissed';
}
