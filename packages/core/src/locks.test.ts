import { describe, expect, it } from 'bun:test';
import { advisoryLockKey, withAdvisoryLock } from './locks.js';

/**
 * Minimal stand-in for a reserved postgres.js connection: a tagged-template
 * function that answers the two statements `withAdvisoryLock` issues.
 */
function fakeSql(opts: { locked: boolean; onQuery?: (sql: string) => void }) {
  const released: boolean[] = [];
  let unlocked = 0;

  const reserved = ((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    opts.onQuery?.(text);
    if (text.includes('pg_try_advisory_lock')) {
      return Promise.resolve([{ locked: opts.locked }]);
    }
    if (text.includes('pg_advisory_unlock')) {
      unlocked += 1;
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as { release: () => void };
  (reserved as { release: () => void }).release = () => released.push(true);

  return {
    sql: { reserve: async () => reserved } as never,
    get unlockCount() {
      return unlocked;
    },
    get releaseCount() {
      return released.length;
    },
  };
}

describe('advisoryLockKey', () => {
  it('is stable for a name and fits the two-int lock signature', () => {
    const a = advisoryLockKey('scheduler:kitchen:estimate');
    const b = advisoryLockKey('scheduler:kitchen:estimate');
    expect(a).toEqual(b);
    for (const half of [a.hi, a.lo]) {
      expect(Number.isInteger(half)).toBe(true);
      expect(half).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(half).toBeLessThan(2 ** 31);
    }
  });

  it('separates different task names', () => {
    expect(advisoryLockKey('scheduler:a')).not.toEqual(advisoryLockKey('scheduler:b'));
  });
});

describe('withAdvisoryLock', () => {
  it('runs the work and releases the lock when it acquires', async () => {
    const seen: string[] = [];
    const fake = fakeSql({ locked: true, onQuery: (q) => seen.push(q) });

    const result = await withAdvisoryLock(fake.sql, 'scheduler:task', async () => 'done');

    expect(result).toEqual({ acquired: true, value: 'done' });
    expect(seen.some((q) => q.includes('pg_try_advisory_lock'))).toBe(true);
    expect(fake.unlockCount).toBe(1);
    expect(fake.releaseCount).toBe(1);
  });

  it('skips the work — and does not unlock — when another holder has it', async () => {
    const fake = fakeSql({ locked: false });
    let ran = false;

    const result = await withAdvisoryLock(fake.sql, 'scheduler:task', async () => {
      ran = true;
      return 'done';
    });

    expect(result.acquired).toBe(false);
    expect(ran).toBe(false);
    // Unlocking a lock this session never took would release someone else's.
    expect(fake.unlockCount).toBe(0);
    expect(fake.releaseCount).toBe(1);
  });

  it('releases the lock and the connection when the work throws', async () => {
    const fake = fakeSql({ locked: true });

    await expect(
      withAdvisoryLock(fake.sql, 'scheduler:task', async () => {
        throw new Error('handler blew up');
      }),
    ).rejects.toThrow('handler blew up');

    expect(fake.unlockCount).toBe(1);
    expect(fake.releaseCount).toBe(1);
  });
});
