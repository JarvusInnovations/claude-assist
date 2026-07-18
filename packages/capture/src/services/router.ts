/**
 * Routing executor layer.
 *
 * Each classified capture carries a destination name; the router resolves
 * it against a registry of executors at route time. Contract:
 *
 * - `hold` executors never write anywhere — the row parks in
 *   awaiting_review for the owner's explicit judgment (the firewall's
 *   capture-side enforcement: actionable/team_relevant NEVER auto-write).
 * - `write` executors move a row to `routed` only after the destination
 *   write succeeds; failures bump route_attempts and are retried by the
 *   next sweep until the cap.
 * - An unregistered destination parks the row in awaiting_executor with no
 *   attempt burned — deploying the executor later (or fixing config) lets
 *   the sweep pick those rows back up.
 *
 * Adding a destination (e.g. a future diet estimator) = implement
 * RoutingExecutor, register it, and map a type to it in ROUTING_TABLE.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { CaptureRecord, CaptureStatus } from '../types.js';
import type { CaptureStore } from '../store.js';
import { transition } from '../state.js';

export interface RoutingExecutor {
  /** Destination name referenced by ROUTING_TABLE */
  readonly destination: string;
  /** hold = park for human review; write = perform a destination write */
  readonly kind: 'hold' | 'write';
  /** Perform the destination write; return a receipt stored in route_result */
  execute(capture: CaptureRecord): Promise<Record<string, unknown>>;
}

export class CaptureRouter {
  private executors = new Map<string, RoutingExecutor>();

  constructor(
    private store: CaptureStore,
    private log: FastifyBaseLogger
  ) {}

  register(executor: RoutingExecutor): void {
    this.executors.set(executor.destination, executor);
    this.log.info(
      { destination: executor.destination, kind: executor.kind },
      'Capture executor registered'
    );
  }

  registeredDestinations(): string[] {
    return [...this.executors.keys()];
  }

  /**
   * Route one classified/awaiting_executor capture. Returns the resulting
   * status (unchanged on write failure).
   */
  async route(capture: CaptureRecord): Promise<CaptureStatus> {
    const destination = capture.route_destination;
    if (!destination) {
      // Defensive: selectForRouting should never yield these
      await this.store.recordRoutingFailure(capture.ulid, 'No route destination set');
      return capture.status;
    }

    const executor = this.executors.get(destination);

    if (!executor) {
      const next = transition(capture.status, { kind: 'no_executor' });
      if (next !== capture.status) {
        await this.store.applyRouting(capture.ulid, next, null);
      }
      this.log.warn(
        { ulid: capture.ulid, destination },
        'No executor registered for destination - capture parked'
      );
      return next;
    }

    if (executor.kind === 'hold') {
      const next = transition(capture.status, { kind: 'held' });
      await this.store.applyRouting(capture.ulid, next, {
        held_by: destination,
        held_at: new Date().toISOString(),
      });
      this.log.info({ ulid: capture.ulid, destination }, 'Capture held for review');
      return next;
    }

    try {
      const result = await executor.execute(capture);
      const next = transition(capture.status, { kind: 'route_succeeded' });
      await this.store.applyRouting(capture.ulid, next, result);
      this.log.info({ ulid: capture.ulid, destination }, 'Capture routed');
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = await this.store.recordRoutingFailure(capture.ulid, message);
      this.log.error(
        { ulid: capture.ulid, destination, attempts, error: message },
        'Capture routing failed'
      );
      return capture.status;
    }
  }
}
