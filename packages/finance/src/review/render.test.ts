import { describe, expect, test } from 'bun:test';
import { escapeHtml, renderReviewPage, reviewSlug, reviewTitle } from './render.js';
import { composeReview } from './compose.js';
import { renderTanaPaste, reviewHeading, extractNodeId, tanaNodeLink } from './tana.js';
import { periodFromKey } from '../period.js';
import type { SuggestionRecord, TransactionRecord } from '../types.js';

function txn(over: Partial<TransactionRecord> & { externalId: string }): TransactionRecord {
  return {
    postedOn: '2026-03-10',
    amount: -900,
    currency: 'USD',
    merchant: 'Big Spend Co',
    description: null,
    accountId: 'a1',
    categoryId: null,
    categoryName: null,
    notes: null,
    tags: [],
    isPending: false,
    needsReview: false,
    ...over,
  };
}

const summary = composeReview({
  period: periodFromKey('2026-03'),
  transactions: [txn({ externalId: 't1' }), txn({ externalId: 't2', amount: -12, categoryName: 'Dining' })],
  currency: 'USD',
});

const suggestion: SuggestionRecord = {
  id: 7,
  reviewId: 3,
  transactionId: 't1',
  kind: 'category',
  currentValue: null,
  suggestedValue: 'Home Improvement',
  rationale: 'hardware store',
  confidence: 'medium',
  status: 'proposed',
  decidedAt: null,
  decidedBy: null,
  appliedAt: null,
  applyError: null,
};

describe('renderReviewPage', () => {
  const html = renderReviewPage({ reviewId: 3, summary, suggestions: [suggestion] });

  test('is self-contained — no external subresources the pages CSP would block', () => {
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=["']https?:/i);
  });

  test('carries the totals and the flagged rows', () => {
    expect(html).toContain('Finance review — March 2026');
    expect(html).toContain('Big Spend Co');
    expect(html).toContain('Home Improvement');
  });

  test('posts decisions at the review it was rendered for', () => {
    expect(html).toContain('data-review-id="3"');
    expect(html).toContain("'/api/finance/reviews/' + reviewId + '/suggestions/'");
  });

  test('says in the page that accepting is not applying', () => {
    expect(html).toContain('does <b>not</b> change the');
  });

  test('escapes merchant names rather than trusting the provider', () => {
    const hostile = composeReview({
      period: periodFromKey('2026-03'),
      transactions: [txn({ externalId: 'x', merchant: '<script>alert(1)</script>' })],
    });
    const rendered = renderReviewPage({ reviewId: 1, summary: hostile, suggestions: [] });
    expect(rendered).not.toContain('<script>alert(1)</script>');
    expect(rendered).toContain('&lt;script&gt;');
  });

  test('escapeHtml covers the five characters that matter', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });

  test('slug and title are stable per period, so a re-run republishes in place', () => {
    expect(reviewSlug('2026-03')).toBe('finance-review-2026-03');
    expect(reviewTitle(summary)).toBe('Finance review — March 2026');
  });
});

describe('renderTanaPaste', () => {
  test('is a pointer, not a second copy of the review', () => {
    const paste = renderTanaPaste(summary, 'https://example.test/pages/finance-review-2026-03');
    expect(paste).toContain(reviewHeading('2026-03'));
    expect(paste).toContain('https://example.test/pages/finance-review-2026-03');
    // The per-transaction detail belongs on the page; two copies means one stale.
    expect(paste).not.toContain('Big Spend Co');
  });

  test('omits the link line when nothing was published', () => {
    expect(renderTanaPaste(summary, null)).not.toContain('Open the review');
  });
});

describe('tana helpers', () => {
  test('extracts a node id from either JSON or loose text', () => {
    expect(extractNodeId('{"nodeId":"abc12345"}')).toBe('abc12345');
    expect(extractNodeId('created node xyz98765 ok')).toBe('xyz98765');
  });

  test('builds a deep link only when there is a node', () => {
    expect(tanaNodeLink('abc')).toContain('nodeid=abc');
    expect(tanaNodeLink(null)).toBeUndefined();
  });
});
