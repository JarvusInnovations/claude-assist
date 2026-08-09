import { describe, expect, test } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import { base32Decode, totpCode } from './totp.js';
import { mapAccount, mapTransaction, ApiFinanceSource } from './api-source.js';
import { CommandFinanceSource, normalizeTransaction } from './command-source.js';
import { FinanceSourceError } from './types.js';

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

describe('totp', () => {
  test('decodes base32, padding and spacing tolerated', () => {
    expect(Array.from(base32Decode('MZXW6==='))).toEqual([0x66, 0x6f, 0x6f]);
    expect(Array.from(base32Decode('mzxw 6'))).toEqual([0x66, 0x6f, 0x6f]);
  });

  /** RFC 6238 test vector: secret "12345678901234567890" as base32, T=59. */
  test('matches the RFC 6238 SHA-1 vector', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(await totpCode(secret, { atSeconds: 59, digits: 8 })).toBe('94287082');
    expect(await totpCode(secret, { atSeconds: 1111111109, digits: 8 })).toBe('07081804');
  });
});

describe('mapTransaction', () => {
  test('flattens the nested provider shape', () => {
    const mapped = mapTransaction({
      id: 't1',
      date: '2026-03-04',
      amount: -12.5,
      pending: false,
      needsReview: true,
      notes: 'a note',
      category: { id: 'c1', name: 'Dining' },
      merchant: { id: 'm1', name: 'Coffee Bar' },
      account: { id: 'a1' },
      tags: [{ id: 'g1', name: 'reimbursable' }],
    });
    expect(mapped).toMatchObject({
      id: 't1',
      amount: -12.5,
      merchant: 'Coffee Bar',
      categoryName: 'Dining',
      accountId: 'a1',
      needsReview: true,
      tags: ['reimbursable'],
    });
  });

  /**
   * A row with no usable amount is drift, not a zero-dollar transaction.
   * Coercing it to 0 would quietly understate a month's spending.
   */
  test('treats a missing amount as schema drift', () => {
    expect(() => mapTransaction({ id: 't1', date: '2026-03-04' })).toThrow(FinanceSourceError);
  });

  test('reads a balance from either of the provider balance fields', () => {
    expect(mapAccount({ id: 'a1', displayName: 'Checking', currentBalance: 100 }).balance).toBe(100);
    expect(mapAccount({ id: 'a1', name: 'Checking', displayBalance: 250 }).balance).toBe(250);
  });
});

describe('ApiFinanceSource preflight', () => {
  test('reports not_configured before it tries anything', async () => {
    const source = new ApiFinanceSource(
      { email: 'a@example.test', password: 'x' },
      { read: async () => null, write: async () => {}, clear: async () => {} },
      log,
    );
    const result = await source.preflight();
    expect(result).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(result.detail).toContain('FINANCE_API_BASE_URL');
  });

  test('reports not_configured when credentials are absent', async () => {
    const source = new ApiFinanceSource(
      { baseUrl: 'https://api.example.test' },
      { read: async () => null, write: async () => {}, clear: async () => {} },
      log,
    );
    expect((await source.preflight()).detail).toContain('FINANCE_API_EMAIL');
  });
});

describe('normalizeTransaction (exporter contract)', () => {
  test('accepts the documented flat shape', () => {
    expect(
      normalizeTransaction({
        id: 't1',
        date: '2026-03-04',
        amount: -9.99,
        merchant: 'Shop',
        categoryName: 'Dining',
        tags: ['x', 3],
      }),
    ).toMatchObject({ id: 't1', amount: -9.99, merchant: 'Shop', tags: ['x'] });
  });

  test('rejects a row with no numeric amount', () => {
    expect(() => normalizeTransaction({ id: 't1', date: '2026-03-04', amount: 'lots' })).toThrow(
      FinanceSourceError,
    );
  });
});

describe('CommandFinanceSource', () => {
  test('reports not_configured with no command set', async () => {
    const source = new CommandFinanceSource({}, log);
    expect(await source.preflight()).toMatchObject({
      ok: false,
      mode: 'command',
      reason: 'not_configured',
    });
  });

  test('passes a clean refusal through with its reason intact', async () => {
    // A logged-out browser session must stay distinguishable from a broken
    // exporter: one needs a human at a VNC console, the other needs a bug fix.
    const source = new CommandFinanceSource(
      {
        command: [
          'sh',
          '-c',
          'cat >/dev/null; echo \'{"ok":false,"reason":"unauthenticated","detail":"session expired"}\'',
        ],
      },
      log,
    );
    const result = await source.preflight();
    expect(result).toMatchObject({ ok: false, reason: 'unauthenticated' });
    expect(result.detail).toContain('session expired');
  });

  test('reads transactions from the documented envelope', async () => {
    const payload = JSON.stringify({
      ok: true,
      data: [{ id: 't1', date: '2026-03-04', amount: -5, merchant: 'Shop' }],
    });
    const source = new CommandFinanceSource(
      { command: ['sh', '-c', `cat >/dev/null; printf '%s' '${payload}'`] },
      log,
    );
    const rows = await source.listTransactions({ startDate: '2026-03-01', endDate: '2026-03-31' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 't1', amount: -5 });
  });

  test('treats a broken exporter as unavailable, not as a refusal', async () => {
    const source = new CommandFinanceSource(
      { command: ['sh', '-c', 'cat >/dev/null; echo not-json; exit 3'] },
      log,
    );
    expect(await source.preflight()).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  test('reports a missing binary as not_configured', async () => {
    const source = new CommandFinanceSource({ command: ['definitely-not-a-real-binary-xyz'] }, log);
    expect(await source.preflight()).toMatchObject({ ok: false, reason: 'not_configured' });
  });
});
