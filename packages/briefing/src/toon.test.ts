import { describe, expect, it } from 'bun:test';
import { ToonDecodeError } from '@toon-format/toon';
import { decodeToonRows, sliceNamedBlock } from './toon.js';

describe('sliceNamedBlock', () => {
  const doc = [
    'count: 2 open',
    'commitments[2]{slug,title,due_date}:',
    '  a1,"Finalize, send it",2026-04-07',
    '  b2,Second thing,null',
    'help[1]:',
    '  Run --help',
  ].join('\n');

  it('slices the named block through its indented rows, stopping before help', () => {
    expect(sliceNamedBlock(doc, 'commitments')).toBe(
      [
        'commitments[2]{slug,title,due_date}:',
        '  a1,"Finalize, send it",2026-04-07',
        '  b2,Second thing,null',
      ].join('\n')
    );
  });

  it('returns null for an absent block', () => {
    expect(sliceNamedBlock(doc, 'events')).toBeNull();
  });
});

describe('decodeToonRows', () => {
  const doc = [
    'count: 2 open',
    'commitments[2]{slug,title,due_date}:',
    '  a1,"Finalize, send it",2026-04-07',
    '  b2,Second thing,null',
    'help[1]:',
    '  Run --help',
  ].join('\n');

  it('decodes rows as string-keyed records, ignoring the surrounding decoration', () => {
    const rows = decodeToonRows(doc, 'commitments');
    expect(rows).toEqual([
      { slug: 'a1', title: 'Finalize, send it', due_date: '2026-04-07' },
      // Bare `null` token decodes to JS null → coerced to ''.
      { slug: 'b2', title: 'Second thing', due_date: '' },
    ]);
  });

  it('coerces unquoted numeric cells to strings', () => {
    const rows = decodeToonRows('nums[1]{a,b}:\n  hello,7', 'nums');
    expect(rows).toEqual([{ a: 'hello', b: '7' }]);
  });

  it('keeps commas inside quoted fields', () => {
    const rows = decodeToonRows(
      'events[1]{id,attendees}:\n  x,"5 (1 accepted, 3 needsAction, 1 declined)"',
      'events'
    );
    expect(rows).toEqual([{ id: 'x', attendees: '5 (1 accepted, 3 needsAction, 1 declined)' }]);
  });

  it('unescapes backslash-escaped quotes without truncating the row', () => {
    // TOON escapes an embedded quote as `\"` (JSON-style), not `""` (RFC-4180).
    // The row must keep every column after such a field — the regression that
    // dropped the trailing hangoutLink when a description carried a link.
    const rows = decodeToonRows(
      'events[1]{id,description,hangoutLink}:\n' +
        '  x,"<a href=\\"https://docs.example/x\\">agenda</a>","https://meet.google.com/abc"',
      'events'
    );
    expect(rows).toEqual([
      {
        id: 'x',
        description: '<a href="https://docs.example/x">agenda</a>',
        hangoutLink: 'https://meet.google.com/abc',
      },
    ]);
  });

  it('decodes an escaped newline to a real newline', () => {
    const rows = decodeToonRows('events[1]{id,description}:\n  x,"Line1\\nLine2"', 'events');
    expect(rows![0]!.description).toBe('Line1\nLine2');
  });

  it('returns null for an absent block', () => {
    expect(decodeToonRows('account: x\ncount: 0', 'events')).toBeNull();
  });

  it('throws ToonDecodeError on a malformed block (declared count mismatch)', () => {
    // Header declares 2 rows but only 1 is present — strict decode rejects it.
    expect(() => decodeToonRows('events[2]{id}:\n  a', 'events')).toThrow(ToonDecodeError);
  });
});
