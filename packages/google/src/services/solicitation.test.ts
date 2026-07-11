import { describe, expect, it } from 'bun:test';
import { isSolicitationClass } from './solicitation.js';

describe('isSolicitationClass', () => {
  it('matches RFP / RFQ / RFI acronyms as whole words', () => {
    expect(isSolicitationClass({ subject: 'RFP: Transit data platform', bodyText: null, snippet: null, senderAddress: 'x@a.test' })).toBe(true);
    expect(isSolicitationClass({ subject: 'New RFQ posted', bodyText: null, snippet: null, senderAddress: 'x@a.test' })).toBe(true);
  });

  it('does not match a short acronym embedded in a larger word', () => {
    // "grfp" contains the letters r-f-p but not as a whole word → no match.
    expect(isSolicitationClass({ subject: 'grfp fellowship news', bodyText: 'congratulations on the award', snippet: null, senderAddress: 'x@a.test' })).toBe(false);
  });

  it('matches longer procurement phrases in the body', () => {
    expect(isSolicitationClass({ subject: 'Opportunity', bodyText: 'A request for proposals has been issued.', snippet: null, senderAddress: 'x@a.test' })).toBe(true);
  });

  it('matches a bid-portal sender even without subject keywords', () => {
    expect(isSolicitationClass({ subject: 'New posting', bodyText: 'see attached', snippet: null, senderAddress: 'noreply@bidnet.test' })).toBe(true);
  });

  it('is negative for ordinary mail', () => {
    expect(isSolicitationClass({ subject: 'Lunch next week?', bodyText: 'Are you free Tuesday?', snippet: null, senderAddress: 'nate@client.org' })).toBe(false);
  });
});
