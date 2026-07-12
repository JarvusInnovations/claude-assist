import { describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { LedgerStore } from './store.js';

/**
 * A recording sql double: captures the tagged-template query text + the
 * interpolated values, and returns a canned result. `sql.json` is the identity
 * so we can inspect the object that would be sent to a jsonb column.
 */
function recordingSql(result: unknown[] = [{ id: 7 }]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(result);
  }) as unknown as postgres.Sql;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return { sql: fn, calls };
}

describe('LedgerStore.recordDirect', () => {
  it('writes a direct row with source=direct and rules_version NULL, returns the id', async () => {
    const { sql, calls } = recordingSql([{ id: 42 }]);
    const store = new LedgerStore(sql);

    const { id } = await store.recordDirect({
      actor: { kind: 'service', service: 'email-executor' },
      actionType: 'email-action',
      targetSystem: 'gmail',
      targetId: 'msg-abc',
      summary: 'archive Gmail message',
      context: { email_id: 5, action: 'archive' },
    });

    expect(id).toBe(42);
    expect(calls).toHaveLength(1);
    const q = calls[0]!;
    expect(q.text).toContain('INSERT INTO ledger.actions');
    expect(q.text).toContain("'direct'");
    // The actor jsonb carries kind + service, and drops undefined fields.
    expect(q.values).toContainEqual({ kind: 'service', service: 'email-executor' });
    // The context pointer is preserved.
    expect(q.values).toContainEqual({ email_id: 5, action: 'archive' });
    // target_id + summary are bound.
    expect(q.values).toContain('msg-abc');
    expect(q.values).toContain('archive Gmail message');
  });

  it('defaults context to {} and target_id to null when omitted', async () => {
    const { sql, calls } = recordingSql();
    const store = new LedgerStore(sql);

    await store.recordDirect({
      actor: { kind: 'service', service: 'notify' },
      actionType: 'outbound',
      targetSystem: 'notification',
      summary: 'notice delivered',
    });

    const q = calls[0]!;
    expect(q.values).toContainEqual({}); // empty context
    expect(q.values).toContain(null); // target_id
  });
});
