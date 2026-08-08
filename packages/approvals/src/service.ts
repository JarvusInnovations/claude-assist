import type { FastifyBaseLogger } from 'fastify';
import type {
  ApprovalListFilter,
  ApprovalRecord,
  ApprovalRequestInput,
  ApprovalResolution,
  ApprovalService,
  NotifyDispatcher,
} from '@jarvus/claude-assist-core';
import type { InsertInput, InsertOutcome } from './store.js';

export const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * The persistence seam. Narrow on purpose: a test satisfies it with an
 * in-memory object, which is how every model- and DB-backed service in this
 * repo stays testable without a live Postgres.
 */
export interface ApprovalStorePort {
  insert(input: InsertInput): Promise<InsertOutcome>;
  get(id: string): Promise<ApprovalRecord | null>;
  list(filter?: ApprovalListFilter): Promise<ApprovalRecord[]>;
  resolve(id: string, resolution: ApprovalResolution, resolvedBy?: string): Promise<ApprovalRecord>;
  findResolved(dedupeKey: string): Promise<ApprovalRecord | null>;
}

export interface ApprovalServiceDeps {
  store: ApprovalStorePort;
  log: FastifyBaseLogger;
  notify?: NotifyDispatcher;
  defaultExpiryMs?: number;
  /** Base URL for the link a human opens to act on a request. */
  baseUrl?: string;
}

export function createApprovalService(deps: ApprovalServiceDeps): ApprovalService {
  const defaultExpiryMs = deps.defaultExpiryMs ?? DEFAULT_EXPIRY_MS;

  return {
    async request(input: ApprovalRequestInput): Promise<ApprovalRecord> {
      const expiresAt = new Date(Date.now() + (input.expiresInMs ?? defaultExpiryMs));
      const { record, created } = await deps.store.insert({
        kind: input.kind,
        requestedBy: input.requestedBy,
        title: input.title,
        body: input.body,
        payload: input.payload ?? {},
        dedupeKey: input.dedupeKey ?? null,
        expiresAt,
      });

      // A repeat of an already-pending key notifies nothing. This is the whole
      // point of the dedupe key: a sweep that hits the same wall every minute
      // would otherwise send a notification every minute, and the channel stops
      // being trustworthy inside an hour.
      if (!created) return record;

      const url = input.url ?? (deps.baseUrl ? `${deps.baseUrl.replace(/\/$/, '')}/approvals/${record.id}` : undefined);
      try {
        await deps.notify?.notify({
          priority: input.priority ?? 'notice',
          title: input.title,
          body: input.body,
          ...(url ? { url, urlTitle: 'Review' } : {}),
        });
      } catch (err) {
        // A delivery failure must not fail the requester: the gate is recorded,
        // which is the durable half. Staleness monitoring is what catches a
        // channel that has stopped working.
        deps.log.error({ err, approval: record.id }, 'Approval raised but notification failed');
      }

      deps.log.info(
        { approval: record.id, kind: record.kind, requestedBy: record.requestedBy },
        `Approval requested: ${record.title}`,
      );
      return record;
    },

    get: (id) => deps.store.get(id),
    list: (filter?: ApprovalListFilter) => deps.store.list(filter),

    async resolve(id: string, resolution: ApprovalResolution, resolvedBy?: string) {
      const record = await deps.store.resolve(id, resolution, resolvedBy);
      deps.log.info(
        { approval: id, decision: resolution.decision, resolvedBy },
        `Approval ${resolution.decision}: ${record.title}`,
      );
      return record;
    },

    findResolved: (dedupeKey) => deps.store.findResolved(dedupeKey),
  };
}
