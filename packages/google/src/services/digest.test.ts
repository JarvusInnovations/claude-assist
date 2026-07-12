import { describe, expect, it } from 'bun:test';
import {
  bucketDigestSections,
  fillSummaries,
  digestHeadline,
  hasActionTag,
  sectionForRow,
  fallbackSummary,
  type DigestEmailDetail,
  type DigestSummarizer,
} from './digest.js';

/** Build a detailed row with sensible defaults for the field under test. */
function row(overrides: Partial<DigestEmailDetail> = {}): DigestEmailDetail {
  return {
    id: 1,
    account_identifier: 'personal',
    from_address: 'sender@example.com',
    from_name: 'A Sender',
    subject: 'Subject',
    date: '2026-07-10T12:00:00Z',
    digest_section: 'notifications',
    gmail_action: 'archive',
    planned_labels: [],
    workflow_status: 'triaged',
    triaged_at: '2026-07-10T12:00:00Z',
    analysis: { sender_type: 'automated', message_type: 'alert', overview: 'gist' } as never,
    ...overrides,
  };
}

const NOW = new Date('2026-07-12T12:00:00Z');

describe('hasActionTag', () => {
  it('detects Respond/Review leaf segments regardless of prefix', () => {
    expect(hasActionTag(['TODO/Respond'])).toBe(true);
    expect(hasActionTag(['Action/Review'])).toBe(true);
    expect(hasActionTag(['AI/Type/Newsletter'])).toBe(false);
    expect(hasActionTag(null)).toBe(false);
  });
});

describe('sectionForRow', () => {
  it('routes spam by gmail_action', () => {
    expect(sectionForRow({ gmail_action: 'spam', planned_labels: null, digest_section: 'newsletters' })).toBe('spam');
  });
  it('routes anything with an action tag to actionable (over its digest_section)', () => {
    expect(
      sectionForRow({ gmail_action: 'leave', planned_labels: ['TODO/Respond'], digest_section: 'newsletters' })
    ).toBe('actionable');
  });
  it('routes known summary categories to themselves', () => {
    expect(sectionForRow({ gmail_action: 'archive', planned_labels: [], digest_section: 'financial' })).toBe('financial');
  });
  it('routes notifications / unknown / null to archive', () => {
    expect(sectionForRow({ gmail_action: 'archive', planned_labels: [], digest_section: 'notifications' })).toBe('archive');
    expect(sectionForRow({ gmail_action: 'archive', planned_labels: [], digest_section: null })).toBe('archive');
  });
});

describe('bucketDigestSections', () => {
  it('orders sections priority-first: actionable → categories → archive → spam', () => {
    const sections = bucketDigestSections(
      [
        row({ id: 1, gmail_action: 'spam', digest_section: 'spam' }),
        row({ id: 2, gmail_action: 'archive', digest_section: 'notifications' }),
        row({ id: 3, gmail_action: 'archive', digest_section: 'newsletters' }),
        row({ id: 4, gmail_action: 'archive', digest_section: 'financial' }),
        row({ id: 5, gmail_action: 'leave', planned_labels: ['TODO/Respond'], digest_section: 'personal' }),
      ],
      NOW
    );
    expect(sections.map((s) => s.key)).toEqual([
      'actionable',
      'financial',
      'newsletters',
      'archive',
      'spam',
    ]);
  });

  it('assigns render modes as data: summary for categories, listed otherwise', () => {
    const sections = bucketDigestSections(
      [
        row({ id: 1, gmail_action: 'leave', planned_labels: ['TODO/Respond'] }),
        row({ id: 2, gmail_action: 'archive', digest_section: 'calendar' }),
        row({ id: 3, gmail_action: 'archive', digest_section: 'notifications' }),
        row({ id: 4, gmail_action: 'spam' }),
      ],
      NOW
    );
    const mode = Object.fromEntries(sections.map((s) => [s.key, s.render]));
    expect(mode).toEqual({
      actionable: 'listed',
      calendar: 'summary',
      archive: 'listed',
      spam: 'listed',
    });
  });

  it('omits sections with nothing to say', () => {
    const sections = bucketDigestSections([row({ gmail_action: 'archive', digest_section: 'financial' })], NOW);
    expect(sections.map((s) => s.key)).toEqual(['financial']);
    expect(sections.find((s) => s.key === 'spam')).toBeUndefined();
  });

  it('marks unconfirmed actionable items with a rollover age', () => {
    const sections = bucketDigestSections(
      [
        row({
          id: 9,
          gmail_action: 'leave',
          planned_labels: ['TODO/Respond'],
          triaged_at: '2026-07-10T12:00:00Z', // 2 days before NOW
        }),
      ],
      NOW
    );
    const item = sections[0]!.items[0]!;
    expect(item.age_days).toBe(2);
    expect(item.rolled_over).toBe(true);
  });

  it('does not roll over same-day actionable items', () => {
    const sections = bucketDigestSections(
      [row({ gmail_action: 'leave', planned_labels: ['TODO/Respond'], triaged_at: NOW.toISOString() })],
      NOW
    );
    expect(sections[0]!.items[0]!.rolled_over).toBe(false);
  });

  it('flags newsletter senders (standing-eligible)', () => {
    const sections = bucketDigestSections(
      [
        row({
          gmail_action: 'archive',
          digest_section: 'newsletters',
          analysis: { sender_type: 'automated', message_type: 'newsletter', overview: 'x' } as never,
        }),
      ],
      NOW
    );
    expect(sections[0]!.items[0]!.is_newsletter).toBe(true);
  });

  it('derives sender_kind + gist from the analysis (parsing JSON strings)', () => {
    const sections = bucketDigestSections(
      [
        row({
          gmail_action: 'leave',
          planned_labels: ['TODO/Respond'],
          analysis: JSON.stringify({ sender_type: 'human', message_type: 'personal', overview: 'please reply' }),
        }),
      ],
      NOW
    );
    const item = sections[0]!.items[0]!;
    expect(item.sender_kind).toBe('human');
    expect(item.gist).toBe('please reply');
  });
});

describe('digestHeadline', () => {
  it('counts need-response (actionable) vs to-confirm (all)', () => {
    const sections = bucketDigestSections(
      [
        row({ id: 1, gmail_action: 'leave', planned_labels: ['TODO/Respond'] }),
        row({ id: 2, gmail_action: 'leave', planned_labels: ['TODO/Review'] }),
        row({ id: 3, gmail_action: 'archive', digest_section: 'financial' }),
        row({ id: 4, gmail_action: 'archive', digest_section: 'notifications' }),
      ],
      NOW
    );
    const h = digestHeadline(sections);
    expect(h.needResponse).toBe(2);
    expect(h.toConfirm).toBe(4);
    expect(h.title).toBe('Digest · 2 need response · 4 to confirm');
  });
});

describe('fillSummaries', () => {
  const fake: DigestSummarizer = {
    async summarize(section, items) {
      return [`${section}: ${items.length} item(s)`];
    },
  };

  it('fills summary-mode sections via the summarizer and leaves listed ones null', async () => {
    const sections = bucketDigestSections(
      [
        row({ id: 1, gmail_action: 'leave', planned_labels: ['TODO/Respond'] }),
        row({ id: 2, gmail_action: 'archive', digest_section: 'financial' }),
        row({ id: 3, gmail_action: 'archive', digest_section: 'financial' }),
      ],
      NOW
    );
    await fillSummaries(sections, fake);
    const actionable = sections.find((s) => s.key === 'actionable')!;
    const financial = sections.find((s) => s.key === 'financial')!;
    expect(actionable.summary).toBeNull();
    expect(financial.summary).toEqual(['financial: 2 item(s)']);
  });

  it('falls back to deterministic lines when no summarizer is wired', async () => {
    const sections = bucketDigestSections(
      [row({ id: 5, gmail_action: 'archive', digest_section: 'calendar' })],
      NOW
    );
    await fillSummaries(sections);
    const calendar = sections.find((s) => s.key === 'calendar')!;
    expect(calendar.summary).toEqual(fallbackSummary(calendar.items));
    expect(calendar.summary!.length).toBe(1);
  });
});
