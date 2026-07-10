import { describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { buildWhitelist, WhitelistService } from './whitelist.js';

describe('buildWhitelist (pure)', () => {
  it('lowercases, trims, and dedups valid addresses', () => {
    const wl = buildWhitelist([' Nate@Client.org ', 'nate@client.org', 'A@B.co']);
    expect([...wl].sort()).toEqual(['a@b.co', 'nate@client.org']);
  });

  it('drops null/blank and malformed addresses (display-name noise)', () => {
    const wl = buildWhitelist([null, undefined, '', 'not-an-email', 'no@dotdomain', 'ok@x.io']);
    expect([...wl]).toEqual(['ok@x.io']);
  });
});

/**
 * A tagged-template sql stub that dispatches on the query text and asserts the
 * owner email is parameterized in. The three queries the service issues, in
 * order: account lookup, sent-mail recipients, thread correspondents.
 */
function mockSql(rowsByMatch: Array<{ match: string; rows: unknown[] }>): postgres.Sql {
  return ((strings: TemplateStringsArray, ..._params: unknown[]) => {
    const text = strings.join(' ');
    for (const { match, rows } of rowsByMatch) {
      if (text.includes(match)) return Promise.resolve(rows);
    }
    throw new Error(`unexpected sql: ${text}`);
  }) as unknown as postgres.Sql;
}

describe('WhitelistService.deriveWhitelist', () => {
  it('unions sent-mail recipients, thread correspondents, and injected contacts', async () => {
    const sql = mockSql([
      { match: 'SELECT email FROM google.accounts', rows: [{ email: 'user@example.com' }] },
      { match: 'unnest(e.to_addresses)', rows: [{ addr: 'nate@client.org' }] },
      { match: 'e.thread_id IN', rows: [{ addr: 'dana@example.org' }, { addr: 'nate@client.org' }] },
    ]);
    const svc = new WhitelistService(sql, { externalContacts: ['contact@partner.example'] });
    const wl = await svc.deriveWhitelist(1);
    expect([...wl].sort()).toEqual([
      'contact@partner.example',
      'dana@example.org',
      'nate@client.org',
    ]);
  });

  it('returns an empty set for an unknown account', async () => {
    const sql = mockSql([{ match: 'SELECT email FROM google.accounts', rows: [] }]);
    const svc = new WhitelistService(sql);
    const wl = await svc.deriveWhitelist(999);
    expect(wl.size).toBe(0);
  });
});
