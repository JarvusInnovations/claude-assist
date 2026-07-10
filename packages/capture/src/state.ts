/**
 * Capture routing state machine + routing table.
 *
 * This module is the single authority on which status moves are legal.
 * Stores persist whatever `transition` returns; the router never invents a
 * status on its own. Failures are deliberately NOT transitions — a failed
 * classify/route attempt bumps an attempt counter and records last_error
 * while the status stays put (mirrors the email triage retry pattern).
 */

import type { CaptureStatus, CaptureType } from './types.js';

/**
 * Where each classified type goes. Destinations name executors, not
 * mechanisms — the router looks the executor up at route time, so a
 * destination can exist here before its executor ships (rows park in
 * awaiting_executor until it does).
 *
 * FIREWALL NOTE: there is deliberately no HQ destination and this module
 * has no HQ write path. `actionable` and `team_relevant` route to `review`,
 * a hold-only executor — those captures surface to Chris (daily digest /
 * dashboard) and cross into team spaces only through his explicit
 * synthesis. See Hari specs/behaviors/personal-team-firewall.md.
 */
export const ROUTING_TABLE: Record<CaptureType, string> = {
  stray_thought: 'tana-inbox',
  link_reference: 'references',
  actionable: 'review',
  team_relevant: 'review',
};

export type CaptureEvent =
  /** Classification produced a type; destination comes from ROUTING_TABLE */
  | { kind: 'classified'; destination: string }
  /** Destination executor is hold-only (review) */
  | { kind: 'held' }
  /** Destination executor write succeeded */
  | { kind: 'route_succeeded' }
  /** No executor registered for the destination (e.g. Tana unconfigured) */
  | { kind: 'no_executor' }
  /** Chris corrected the type; capture re-enters routing with a new destination */
  | { kind: 'corrected'; destination: string };

export class InvalidTransitionError extends Error {
  constructor(status: CaptureStatus, event: CaptureEvent) {
    super(`Invalid capture transition: ${status} + ${event.kind}`);
    this.name = 'InvalidTransitionError';
  }
}

const ROUTABLE: readonly CaptureStatus[] = ['classified', 'awaiting_executor'];

/**
 * Compute the next status for a capture, or throw InvalidTransitionError.
 */
export function transition(status: CaptureStatus, event: CaptureEvent): CaptureStatus {
  switch (event.kind) {
    case 'classified':
      if (status === 'queued') return 'classified';
      throw new InvalidTransitionError(status, event);

    case 'held':
      if (ROUTABLE.includes(status)) return 'awaiting_review';
      throw new InvalidTransitionError(status, event);

    case 'route_succeeded':
      if (ROUTABLE.includes(status)) return 'routed';
      throw new InvalidTransitionError(status, event);

    case 'no_executor':
      if (ROUTABLE.includes(status)) return 'awaiting_executor';
      throw new InvalidTransitionError(status, event);

    case 'corrected':
      // A correction is legal from any post-classification state: held
      // items get re-routed, mis-routed items get routed again to the right
      // place (the original destination write, if any, is not unwound —
      // corrections are additive, and review surfaces show both).
      if (status !== 'queued') return 'classified';
      throw new InvalidTransitionError(status, event);
  }
}

/** Destination for a capture type (single source of truth: ROUTING_TABLE) */
export function destinationFor(type: CaptureType): string {
  return ROUTING_TABLE[type];
}
