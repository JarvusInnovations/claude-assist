import { describe, it, expect } from 'bun:test';
import { rankCandidates, similarity, priceAgreement } from './services/line-candidates.js';

const base = {
  priceCents: null as number | null,
  knownLines: [] as { line_text: string; product_ulid: string }[],
  priceHistory: new Map<string, number[]>(),
};

describe('priceAgreement', () => {
  it('returns NULL with no price to compare — absence is not disagreement', () => {
    expect(priceAgreement(null, [399])).toBeNull();
    expect(priceAgreement(399, [])).toBeNull();
  });

  it('is generous about sales and markdowns', () => {
    expect(priceAgreement(399, [399])).toBe(1);
    expect(priceAgreement(380, [399])).toBe(1); // within 5%
    expect(priceAgreement(399, [800])).toBe(0); // half off is no evidence either way
  });
});

describe('rankCandidates', () => {
  const products = [
    { ulid: 'p_oats', name: 'Organic Rolled Oats' },
    { ulid: 'p_yog', name: 'Greek Yogurt, Plain' },
  ];

  it('ranks a re-worded line onto the product a known line taught', () => {
    const out = rankCandidates({
      ...base, products, lineText: 'ORG ROLLD OATS 32Z',
      knownLines: [{ line_text: 'ORGANIC ROLLED OATS', product_ulid: 'p_oats' }],
    });
    expect(out[0]?.product_ulid).toBe('p_oats');
    expect(out[0]!.signals.line).toBeGreaterThan(0.4);
  });

  it('NEVER promotes a textually unsupported candidate on price alone', () => {
    // Two unrelated items at one price say nothing. This is the property that
    // keeps price a tie-breaker rather than a decider.
    const out = rankCandidates({
      ...base, products, lineText: 'ZZZ UNRELATED THING', priceCents: 399,
      priceHistory: new Map([['p_yog', [399]]]),
    });
    expect(out.find((c) => c.product_ulid === 'p_yog')).toBeUndefined();
  });

  it('uses price only to order candidates the text already supports', () => {
    const twoOats = [
      { ulid: 'p_a', name: 'Organic Rolled Oats' },
      { ulid: 'p_b', name: 'Organic Rolled Oats' },
    ];
    const out = rankCandidates({
      ...base, products: twoOats, lineText: 'ORGANIC ROLLED OATS', priceCents: 599,
      priceHistory: new Map([['p_a', [1200]], ['p_b', [599]]]),
    });
    expect(out[0]?.product_ulid).toBe('p_b');
  });

  it('reports a null price signal rather than a zero', () => {
    const out = rankCandidates({ ...base, products, lineText: 'ORGANIC ROLLED OATS' });
    expect(out[0]!.signals.price).toBeNull();
  });

  it('returns nothing for a line with no textual support at all', () => {
    expect(rankCandidates({ ...base, products, lineText: 'QQQQ ZZZZ' })).toEqual([]);
  });

  it('exposes no threshold — every result is a suggestion, never a decision', () => {
    const out = rankCandidates({
      ...base, products, lineText: 'Organic Rolled Oats',
    });
    // Even a perfect textual match is returned as a ranked candidate; nothing in
    // this module attaches anything.
    expect(out[0]!.score).toBeGreaterThan(0.9);
    expect(Object.keys(out[0]!)).not.toContain('attach');
  });
});

describe('similarity', () => {
  it('survives the abbreviation and truncation receipts are full of', () => {
    expect(similarity('LOW FAT COTTAGE CHSE', 'Low Fat Cottage Cheese')).toBeGreaterThan(0.6);
    expect(similarity('FRZN BLUEBERRIES', 'Organic Rolled Oats')).toBeLessThan(0.2);
  });
});
