/**
 * Hold executor: the destination for capture types that must terminate in
 * the owner rather than in an automated write (actionable, team_relevant).
 *
 * FIREWALL: this executor is intentionally inert. The capture service has
 * no HQ client and no HQ write path anywhere; team-relevant material
 * surfaces to the owner (daily digest / dashboard reads status=awaiting_review)
 * and crosses into team spaces only through his explicit synthesis.
 * See the owner's private personal↔team firewall spec.
 */

import type { RoutingExecutor } from '../router.js';

export class HoldExecutor implements RoutingExecutor {
  readonly destination = 'review';
  readonly kind = 'hold' as const;

  async execute(): Promise<Record<string, unknown>> {
    // Never called: the router short-circuits hold executors before
    // execute(). Guard anyway so a router bug can't silently "succeed".
    throw new Error('HoldExecutor.execute must never be invoked');
  }
}
