import { describe, expect, it } from 'bun:test';
import { createLeaseQueue } from './queue.js';

interface Captured {
  sql: string;
  params: unknown[];
}

/** Captures the SQL the helper builds, and replays canned rows back. */
function fakeSql(rows: Record<string, unknown>[] = []) {
  const captured: Captured[] = [];
  const sql = {
    unsafe: (text: string, params: unknown[]) => {
      captured.push({ sql: text, params });
      return Promise.resolve(rows);
    },
  } as never;
  return { sql, captured };
}

const config = {
  schema: 'capture',
  table: 'captures',
  readyStatus: 'queued',
  runningStatus: 'classifying',
  failedStatus: 'failed',
  doneStatus: 'classified',
  maxAttempts: 3,
  leaseMs: 60_000,
};

describe('lease queue claim', () => {
  it('claims atomically under FOR UPDATE … SKIP LOCKED and takes ownership in one statement', async () => {
    const { sql, captured } = fakeSql([{ id: 'r1', attempts: 1 }]);
    const queue = createLeaseQueue(sql, config, 'worker-a');

    const claimed = await queue.claim(5);

    const stmt = captured[0]!;
    expect(stmt.sql).toContain('FOR UPDATE OF t SKIP LOCKED');
    expect(stmt.sql).toContain('"capture"."captures"');
    // Owner, expiry, and the attempt increment all land in the same UPDATE:
    // a claim that set them in a second statement would leave a window where
    // a crash strands the row with no owner.
    expect(stmt.sql).toContain('"lease_owner" = $4');
    expect(stmt.sql).toContain('"lease_expires_at" = NOW()');
    expect(stmt.sql).toContain('"attempts" = t."attempts" + 1');
    expect(stmt.params).toEqual(['queued', 'classifying', 5, 'worker-a']);
    expect(claimed).toEqual([{ id: 'r1', attempts: 1 }]);
  });

  it('skips rows whose backoff has not elapsed and rows past the attempt cap', async () => {
    const { sql, captured } = fakeSql();
    const queue = createLeaseQueue(sql, config, 'worker-a');
    await queue.claim(1);

    expect(captured[0]!.sql).toContain('"attempts" < 3');
    expect(captured[0]!.sql).toContain('"next_attempt_at" IS NULL OR t."next_attempt_at" <= NOW()');
  });

  it('serializes by key when asked, so one account cannot be processed twice at once', async () => {
    const { sql, captured } = fakeSql();
    const queue = createLeaseQueue(sql, { ...config, serializeBy: 'account_id' }, 'worker-a');
    await queue.claim(3);

    expect(captured[0]!.sql).toContain('NOT EXISTS');
    expect(captured[0]!.sql).toContain('a."account_id" = t."account_id"');
  });

  it('does no work for a non-positive limit', async () => {
    const { sql, captured } = fakeSql();
    const queue = createLeaseQueue(sql, config, 'worker-a');
    expect(await queue.claim(0)).toEqual([]);
    expect(captured).toHaveLength(0);
  });
});

describe('lease queue release paths', () => {
  it('returns a failed row to ready with a backed-off next attempt', async () => {
    const { sql, captured } = fakeSql([{ id: 'r1', attempts: 1, status: 'queued' }]);
    const queue = createLeaseQueue(sql, config, 'worker-a');

    const outcome = await queue.fail('r1', 'model timed out');

    expect(captured[0]!.sql).toContain('POWER(2,');
    expect(captured[0]!.sql).toContain('"next_attempt_at" = CASE');
    expect(captured[0]!.params).toEqual(['failed', 'queued', 'model timed out', 'r1']);
    expect(outcome).toEqual({ id: 'r1', attempts: 1, status: 'queued', exhausted: false });
  });

  it('reports exhaustion when the attempt cap sent the row terminal', async () => {
    const { sql } = fakeSql([{ id: 'r1', attempts: 3, status: 'failed' }]);
    const queue = createLeaseQueue(sql, config, 'worker-a');

    expect(await queue.fail('r1', 'still broken')).toMatchObject({ exhausted: true });
  });

  it('reclaims only leases that have actually expired', async () => {
    const { sql, captured } = fakeSql([]);
    const queue = createLeaseQueue(sql, config, 'worker-a');
    await queue.reclaimExpired();

    expect(captured[0]!.sql).toContain('"lease_expires_at" < NOW()');
    expect(captured[0]!.params[3]).toBe('classifying');
  });

  it('renews only rows this worker still owns', async () => {
    const { sql, captured } = fakeSql([{ id: 'r1' }]);
    const queue = createLeaseQueue(sql, config, 'worker-a');

    expect(await queue.renew(['r1'])).toBe(1);
    expect(captured[0]!.sql).toContain('"lease_owner" = $2');
    expect(captured[0]!.params).toEqual([['r1'], 'worker-a', 'classifying']);
  });

  it('clears owner, expiry, backoff, and error on completion', async () => {
    const { sql, captured } = fakeSql();
    const queue = createLeaseQueue(sql, config, 'worker-a');
    await queue.complete('r1');

    expect(captured[0]!.sql).toContain('"lease_owner" = NULL');
    expect(captured[0]!.sql).toContain('"last_error" = NULL');
    expect(captured[0]!.params).toEqual(['classified', 'r1']);
  });

  it('rejects an identifier that is not a plain column or table name', () => {
    expect(() => createLeaseQueue(fakeSql().sql, { ...config, table: 'captures; DROP TABLE x' })).toThrow(
      /Invalid table/,
    );
  });
});
