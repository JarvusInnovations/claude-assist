import { describe, expect, it } from 'bun:test';
import { parseCsvRow, parseToonTable, rowRecord } from './toon.js';

describe('parseCsvRow', () => {
  it('splits a plain row', () => {
    expect(parseCsvRow('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps commas inside quoted fields', () => {
    expect(parseCsvRow('5 (1 accepted, 3 needsAction, 1 declined)'.replace(/^/, '"') + '"')).toEqual([
      '5 (1 accepted, 3 needsAction, 1 declined)',
    ]);
  });

  it('handles a mix of quoted and bare fields', () => {
    expect(parseCsvRow('abc,"Check with Carl re: sharing, please",2026-04-10')).toEqual([
      'abc',
      'Check with Carl re: sharing, please',
      '2026-04-10',
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsvRow('"she said ""hi""",x')).toEqual(['she said "hi"', 'x']);
  });

  it('treats empty quoted fields as empty strings', () => {
    expect(parseCsvRow('a,"","",b')).toEqual(['a', '', '', 'b']);
  });

  it('unescapes backslash-escaped quotes without truncating the row', () => {
    // gws-axi emits `\"` for embedded quotes (e.g. an HTML anchor in a meeting
    // description). The parser must keep reading columns AFTER such a field —
    // regression for meetings that vanished from alerts/briefings when their
    // description carried a link and the trailing hangoutLink column was lost.
    expect(
      parseCsvRow('id,"<a href=\\"https://docs.example/x\\">agenda</a>","https://meet.google.com/abc"')
    ).toEqual(['id', '<a href="https://docs.example/x">agenda</a>', 'https://meet.google.com/abc']);
  });

  it('takes a backslash-escaped backslash literally', () => {
    expect(parseCsvRow('"a\\\\b",x')).toEqual(['a\\b', 'x']);
  });
});

describe('parseToonTable', () => {
  const sample = [
    'count: 2 open',
    'commitments[2]{slug,title,due_date}:',
    '  a1,"Finalize, send it",2026-04-07',
    '  b2,Second thing,null',
    'help[1]:',
    '  Run --help',
  ].join('\n');

  it('parses the named section and stops before help', () => {
    const table = parseToonTable(sample, 'commitments');
    expect(table).not.toBeNull();
    expect(table!.columns).toEqual(['slug', 'title', 'due_date']);
    expect(table!.rows).toHaveLength(2);
    expect(rowRecord(table!.columns, table!.rows[1]!)).toEqual({
      slug: 'b2',
      title: 'Second thing',
      due_date: 'null',
    });
  });

  it('returns null for an absent section', () => {
    expect(parseToonTable(sample, 'events')).toBeNull();
  });
});
