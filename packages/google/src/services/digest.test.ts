import { describe, expect, it } from 'bun:test';
import { groupDigestBySection } from './digest.js';

function row(digest_section: string | null, id: number) {
  return { id, digest_section };
}

describe('groupDigestBySection', () => {
  it('orders sections by the canonical digest order, not insertion order', () => {
    const groups = groupDigestBySection([
      row('newsletters', 1),
      row('financial', 2),
      row('calendar', 3),
    ]);
    expect(groups.map((g) => g.section)).toEqual([
      'calendar',
      'financial',
      'newsletters',
    ]);
  });

  it('buckets null sections under "other" and sorts them last', () => {
    const groups = groupDigestBySection([
      row(null, 1),
      row('financial', 2),
      row(null, 3),
    ]);
    expect(groups.map((g) => g.section)).toEqual(['financial', 'other']);
    const other = groups.find((g) => g.section === 'other')!;
    expect(other.count).toBe(2);
    expect(other.emails.map((e) => e.id)).toEqual([1, 3]);
  });

  it('sorts unknown sections alphabetically after the known ones', () => {
    const groups = groupDigestBySection([
      row('zebra', 1),
      row('apricot', 2),
      row('calendar', 3),
    ]);
    expect(groups.map((g) => g.section)).toEqual([
      'calendar',
      'apricot',
      'zebra',
    ]);
  });

  it('preserves counts per group', () => {
    const groups = groupDigestBySection([
      row('financial', 1),
      row('financial', 2),
      row('calendar', 3),
    ]);
    expect(groups.find((g) => g.section === 'financial')!.count).toBe(2);
    expect(groups.find((g) => g.section === 'calendar')!.count).toBe(1);
  });
});
