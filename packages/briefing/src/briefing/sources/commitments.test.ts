import { describe, expect, it } from 'bun:test';
import { parseCommitments } from './commitments.js';

// A full CLI-shaped document: leading scalars, the named tabular block, and
// a trailing help footer. One title carries a comma, an embedded quote (`\"`)
// and an HTML anchor — the same shape that truncated calendar rows under the
// old hand-rolled splitter. Parsing must keep every column.
const DOC = [
  'count: 3 open',
  'range: all',
  'commitments[3]{slug,title,due_date,assignee,made_to,deadline_firmness}:',
  '  ship-it,Ship the launch,2026-07-15,alex,dana,firm',
  '  review-doc,"Review \\"the doc\\", then <a href=\\"https://x/y\\">reply</a>",2026-07-25,alex,dana,soft',
  '  undated,Someday thing,null,null,null,null',
  'help[1]:',
  '  Run `commitments-cli commitment list --help`',
].join('\n');

describe('parseCommitments', () => {
  const commitments = parseCommitments(DOC, '2026-07-20');

  it('parses every commitment row past the quoted/linked title', () => {
    expect(commitments).toHaveLength(3);
    const linked = commitments[1]!;
    expect(linked.title).toBe('Review "the doc", then <a href="https://x/y">reply</a>');
    expect(linked.dueDate).toBe('2026-07-25');
    expect(linked.assignee).toBe('alex');
    expect(linked.madeTo).toBe('dana');
    expect(linked.firmness).toBe('soft');
  });

  it('annotates overdue relative to today', () => {
    expect(commitments[0]!.overdue).toBe(true); // 2026-07-15 < 2026-07-20
    expect(commitments[1]!.overdue).toBe(false); // 2026-07-25 > 2026-07-20
  });

  it('treats a bare null due_date as undated and blanks null assignee/made_to', () => {
    const undated = commitments[2]!;
    expect(undated.dueDate).toBeNull();
    expect(undated.overdue).toBe(false);
    expect(undated.dueToday).toBe(false);
    expect(undated.assignee).toBe('');
    expect(undated.madeTo).toBe('');
    expect(undated.firmness).toBe('');
  });

  it('flags a commitment due exactly today', () => {
    const dueToday = parseCommitments(
      'commitments[1]{slug,title,due_date}:\n  x,Due now,2026-07-20',
      '2026-07-20'
    );
    expect(dueToday[0]!.dueToday).toBe(true);
    expect(dueToday[0]!.overdue).toBe(false);
  });

  it('returns [] when no commitments block is present', () => {
    expect(parseCommitments('count: 0', '2026-07-20')).toEqual([]);
  });
});
