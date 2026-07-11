import { describe, expect, it } from 'bun:test';
import { scoreColdOutreach, DEFAULT_COLD_OUTREACH_CONFIG } from './cold-outreach.js';

// A SYNTHETIC cold-outreach exemplar (invented sender/domain — no real data): a
// personalized-seeming first-contact solicitation with permission-to-send framing
// and an opt-out sign-off.
function cold(over = {}) {
  return {
    senderAddress: 'jay@freshvcfund.test',
    subject: 'Startup cohort',
    bodyText:
      'Hi Owner, holding a spot in the early-stage founders cohort. Can I share info? Reply no thanks if not a fit.',
    snippet: null,
    recipientNames: ['Owner'],
    firstContact: true,
    bodyLength: 110,
    ...over,
  };
}

describe('scoreColdOutreach', () => {
  it('flags the multi-feature cold-outreach signature', () => {
    const r = scoreColdOutreach(cold());
    expect(r.isColdOutreach).toBe(true);
    expect(r.signals).toContain('permission-to-send');
    expect(r.signals).toContain('opt-out-signoff');
    expect(r.signals.some((s) => s.startsWith('solicitation:'))).toBe(true);
  });

  it('does NOT flag a legitimate first-contact note with none of the solicitation features', () => {
    const r = scoreColdOutreach(
      cold({
        subject: 'Following up from the conference',
        bodyText: 'Great to meet you yesterday — here is the deck I mentioned. Talk soon.',
        bodyLength: 70,
      })
    );
    expect(r.isColdOutreach).toBe(false);
  });

  it('opt-out language ALONE (no solicitation) does not clear the threshold', () => {
    const r = scoreColdOutreach(
      cold({
        subject: 'Re: our call',
        bodyText: 'No worries if now is not a good time, reply no thanks and I will stop.',
        bodyLength: 70,
      })
    );
    // first-contact(1) + opt-out(1) + personalized-short? name "Owner" not present → 2 < 3
    expect(r.isColdOutreach).toBe(false);
  });

  it('never flags an established (non-first-contact) sender', () => {
    const r = scoreColdOutreach(cold({ firstContact: false }));
    expect(r.isColdOutreach).toBe(false);
  });

  it('respects a custom threshold', () => {
    const r = scoreColdOutreach(cold(), { ...DEFAULT_COLD_OUTREACH_CONFIG, threshold: 99 });
    expect(r.isColdOutreach).toBe(false);
  });
});
