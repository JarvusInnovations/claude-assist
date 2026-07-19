/**
 * Kitchen-event executor: hands an ambient remark ("opened the feta", "tossed
 * half the tomatoes") to the kitchen module's event resolver, which applies the
 * best-effort inventory state change.
 *
 * The resolver is injected (composed by the server from the kitchen module's
 * decorated surface) — the capture package never imports the kitchen package,
 * exactly as the Tana executor takes an injected client rather than reaching
 * across modules. A `write` executor: a resolved remark (matched or not) is a
 * processed remark, so the capture routes to `routed`; only an infrastructure
 * failure (resolver throws) bumps the retry counter.
 */

import type { KitchenEventResolver } from '@jarvus/claude-assist-core';
import type { CaptureRecord } from '../../types.js';
import type { RoutingExecutor } from '../router.js';

export class KitchenEventExecutor implements RoutingExecutor {
  readonly destination = 'kitchen-event';
  readonly kind = 'write' as const;

  constructor(private resolve: KitchenEventResolver) {}

  async execute(capture: CaptureRecord): Promise<Record<string, unknown>> {
    const outcome = await this.resolve(capture.text);
    return {
      matched: outcome.matched,
      item_ulid: outcome.itemUlid ?? null,
      event_type: outcome.eventType ?? null,
    };
  }
}
