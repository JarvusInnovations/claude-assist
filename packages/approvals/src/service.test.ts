import { describe, expect, it } from 'bun:test';
import {
  ApprovalConflictError,
  type ApprovalListFilter,
  type ApprovalRecord,
  type ApprovalResolution,
  type NotifyInput,
  type NotifyResult,
} from '@jarvus/claude-assist-core';
import { createApprovalService, type ApprovalStorePort } from './service.js';
import type { InsertInput, InsertOutcome } from './store.js';

function makeRecord(input: InsertInput, id: string): ApprovalRecord {
  return {
    id,
    kind: input.kind,
    requestedBy: input.requestedBy,
    title: input.title,
    body: input.body,
    payload: input.payload,
    status: 'pending',
    dedupeKey: input.dedupeKey,
    resolution: null,
    resolvedBy: null,
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    resolvedAt: null,
  };
}

/** In-memory stand-in with the same pending-uniqueness rule as the index. */
class MemoryStore implements ApprovalStorePort {
  readonly rows: ApprovalRecord[] = [];
  private next = 1;

  async insert(input: InsertInput): Promise<InsertOutcome> {
    if (input.dedupeKey) {
      const pending = this.rows.find((r) => r.dedupeKey === input.dedupeKey && r.status === 'pending');
      if (pending) return { record: pending, created: false };
    }
    const record = makeRecord(input, `a${this.next++}`);
    this.rows.push(record);
    return { record, created: true };
  }

  async get(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async list(filter: ApprovalListFilter = {}) {
    return this.rows.filter(
      (r) => (!filter.status || r.status === filter.status) && (!filter.kind || r.kind === filter.kind),
    );
  }

  async resolve(id: string, resolution: ApprovalResolution, resolvedBy?: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new ApprovalConflictError(id, 'cancelled');
    if (row.status !== 'pending') throw new ApprovalConflictError(id, row.status);
    row.status = resolution.decision;
    row.resolution = resolution;
    row.resolvedBy = resolvedBy ?? null;
    row.resolvedAt = new Date().toISOString();
    return row;
  }

  async findResolved(dedupeKey: string) {
    return [...this.rows].reverse().find((r) => r.dedupeKey === dedupeKey && r.status !== 'pending') ?? null;
  }
}

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as never;

function setup() {
  const store = new MemoryStore();
  const sent: NotifyInput[] = [];
  const service = createApprovalService({
    store,
    log: silentLog,
    notify: {
      notify: async (input: NotifyInput): Promise<NotifyResult> => {
        sent.push(input);
        return { id: sent.length, priority: input.priority, deliveredVia: ['pushover'], status: 'sent' };
      },
    },
    baseUrl: 'https://assist.example/',
  });
  return { store, sent, service };
}

const base = {
  kind: 'model_budget_overage',
  requestedBy: 'invoker',
  title: 'Daily model budget reached',
  body: 'Spent $5.02 of a $5.00 ceiling.',
};

describe('approval service', () => {
  it('records the gate and notifies, without waiting for anyone', async () => {
    const { service, sent } = setup();
    const record = await service.request({ ...base, payload: { costUsd: 5.02 } });

    expect(record.status).toBe('pending');
    expect(record.payload).toEqual({ costUsd: 5.02 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.priority).toBe('notice');
    expect(sent[0]!.url).toBe(`https://assist.example/approvals/${record.id}`);
  });

  it('deduplicates a repeated key to one row and one notification', async () => {
    const { service, sent } = setup();
    const first = await service.request({ ...base, dedupeKey: 'budget:2026-08-08' });
    const second = await service.request({ ...base, dedupeKey: 'budget:2026-08-08' });

    expect(second.id).toBe(first.id);
    expect(sent).toHaveLength(1);
  });

  it('raises again once the previous request for a key is resolved', async () => {
    const { service, sent } = setup();
    const first = await service.request({ ...base, dedupeKey: 'budget:2026-08-08' });
    await service.resolve(first.id, { decision: 'denied' });
    const second = await service.request({ ...base, dedupeKey: 'budget:2026-08-08' });

    expect(second.id).not.toBe(first.id);
    expect(sent).toHaveLength(2);
  });

  it('rejects a second resolution instead of overwriting the first', async () => {
    const { service } = setup();
    const record = await service.request({ ...base, dedupeKey: 'k' });
    await service.resolve(record.id, { decision: 'approved', params: { overageUsd: 5 } });

    await expect(service.resolve(record.id, { decision: 'denied' })).rejects.toThrow(
      ApprovalConflictError,
    );
  });

  it('surfaces a resolved decision through findResolved, so nobody has to wait', async () => {
    const { service } = setup();
    const record = await service.request({ ...base, dedupeKey: 'k' });
    expect(await service.findResolved('k')).toBeNull();

    await service.resolve(record.id, { decision: 'approved', params: { overageUsd: 2.5 } });
    const resolved = await service.findResolved('k');

    expect(resolved?.status).toBe('approved');
    expect(resolved?.resolution?.params).toEqual({ overageUsd: 2.5 });
  });

  it('still records the gate when notification delivery fails', async () => {
    const store = new MemoryStore();
    const service = createApprovalService({
      store,
      log: silentLog,
      notify: {
        notify: async () => {
          throw new Error('pushover down');
        },
      },
    });

    const record = await service.request(base);
    expect(record.status).toBe('pending');
    expect(store.rows).toHaveLength(1);
  });
});
