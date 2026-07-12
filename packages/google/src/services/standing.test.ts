import { describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import {
  normalizeSender,
  SenderStandingStore,
  RefinementStore,
} from './standing.js';

/**
 * Capturing tagged-template sql stub: records every query's text + params and
 * returns canned rows by matching a substring. Lets a test both drive the store
 * and assert on WHAT it issued (e.g. that no rule/prompt table is ever touched).
 */
function mockSql(rowsByMatch: Array<{ match: string; rows: unknown[] }>): {
  sql: postgres.Sql;
  queries: { text: string; params: unknown[] }[];
} {
  const queries: { text: string; params: unknown[] }[] = [];
  const sql = ((strings: TemplateStringsArray, ...params: unknown[]) => {
    const text = strings.join('?');
    queries.push({ text, params });
    for (const { match, rows } of rowsByMatch) {
      if (text.includes(match)) return Promise.resolve(rows);
    }
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;
  return { sql, queries };
}

describe('normalizeSender', () => {
  it('lowercases and trims', () => {
    expect(normalizeSender('  Nate@Client.ORG ')).toBe('nate@client.org');
  });
});

describe('SenderStandingStore.set', () => {
  it('upserts a lowercased sender with the given standing + source', async () => {
    const { sql, queries } = mockSql([
      {
        match: 'INSERT INTO google.sender_standing',
        rows: [{ sender_email: 'news@example.com', standing: 'whitelist', set_at: new Date(), source: 'digest_page' }],
      },
    ]);
    const store = new SenderStandingStore(sql);
    const row = await store.set('News@Example.com', 'whitelist');
    expect(row.standing).toBe('whitelist');
    // The lowercased address + standing are parameterized in.
    expect(queries[0]!.params).toContain('news@example.com');
    expect(queries[0]!.params).toContain('whitelist');
    expect(queries[0]!.text).toContain('ON CONFLICT');
  });

  it('supports the unsubscribe_queue standing (the automation source)', async () => {
    const { sql } = mockSql([
      {
        match: 'INSERT INTO google.sender_standing',
        rows: [{ sender_email: 's@x.io', standing: 'unsubscribe_queue', set_at: new Date(), source: 'digest_page' }],
      },
    ]);
    const store = new SenderStandingStore(sql);
    const row = await store.set('s@x.io', 'unsubscribe_queue');
    expect(row.standing).toBe('unsubscribe_queue');
  });
});

describe('RefinementStore.append', () => {
  it('records the correction and NEVER mutates any rule/prompt table', async () => {
    const { sql, queries } = mockSql([
      {
        match: 'INSERT INTO google.classification_refinements',
        rows: [
          {
            id: 1,
            email_id: 42,
            from_class: 'newsletters',
            to_class: 'archive',
            note: 'not a newsletter',
            status: 'pending',
            resolution: null,
            created_at: new Date(),
            resolved_at: null,
          },
        ],
      },
    ]);
    const store = new RefinementStore(sql);
    const row = await store.append({
      emailId: 42,
      fromClass: 'newsletters',
      toClass: 'archive',
      note: 'not a newsletter',
    });

    expect(row.status).toBe('pending');
    expect(row.to_class).toBe('archive');

    // The append path issues exactly one write — into the refinement queue.
    expect(queries.length).toBe(1);
    const allText = queries.map((q) => q.text).join(' ').toLowerCase();
    expect(allText).toContain('classification_refinements');
    // Corrections are gathered, revisions are sessions: no rule/prompt mutation.
    expect(allText).not.toContain('triage_rules');
    expect(allText).not.toContain('update google.triage_rules');
    expect(allText).not.toMatch(/update .*rule/);
    expect(allText).not.toContain('topics_of_interest');
  });
});

describe('RefinementStore.resolve', () => {
  it('marks an entry resolved with the resolution text', async () => {
    const { sql, queries } = mockSql([
      {
        match: 'UPDATE google.classification_refinements',
        rows: [
          {
            id: 1,
            email_id: 42,
            from_class: 'newsletters',
            to_class: 'archive',
            note: null,
            status: 'resolved',
            resolution: 'added exclude rule',
            created_at: new Date(),
            resolved_at: new Date(),
          },
        ],
      },
    ]);
    const store = new RefinementStore(sql);
    const row = await store.resolve(1, 'added exclude rule');
    expect(row?.status).toBe('resolved');
    expect(queries[0]!.params).toContain('added exclude rule');
  });
});
