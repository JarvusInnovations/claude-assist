/**
 * Solicitation-class gate — the cheap deterministic detector for procurement /
 * bid-opportunity mail (RFP / RFQ / RFI / contract opportunity / bid notice).
 *
 * It is only a GATE: a match means "this looks like a solicitation, worth an
 * opportunity evaluation against the owner's interest spec" (see opportunity.ts).
 * It never assigns a tier itself. Kept deterministic and generous — a false
 * positive costs one cheap model call; a false negative silently drops a real
 * opportunity, which is the worse error here.
 *
 * Pure and dependency-free.
 */

export interface SolicitationInput {
  subject: string | null;
  bodyText: string | null;
  snippet: string | null;
  senderAddress: string | null;
}

/** Procurement / bid-opportunity signal phrases. */
export const SOLICITATION_TOKENS: readonly string[] = [
  'rfp',
  'rfq',
  'rfi',
  'request for proposal',
  'request for proposals',
  'request for qualifications',
  'request for quotation',
  'request for information',
  'invitation to bid',
  'invitation for bid',
  'notice of funding',
  'solicitation',
  'procurement',
  'bid opportunity',
  'contract opportunity',
  'bid notice',
  'sources sought',
  'pre-solicitation',
  'presolicitation',
  'addendum',
  'statement of qualifications',
  'scope of work',
  'notice of intent',
  'competitive solicitation',
];

/** Sender-side tips: bid-portal / procurement notification domains & local-parts. */
const SOLICITATION_SENDER_HINTS: readonly string[] = [
  'bid',
  'bids',
  'procure',
  'procurement',
  'solicitation',
  'econtract',
  'govspend',
  'bidnet',
  'biddingo',
  'demandstar',
  'bonfire',
  'planetbids',
];

function hostAndLocal(address: string | null): string {
  return (address ?? '').toLowerCase();
}

/** True when the mail carries a procurement / bid-opportunity signal. */
export function isSolicitationClass(input: SolicitationInput): boolean {
  const haystack = `${input.subject ?? ''}\n${input.bodyText ?? input.snippet ?? ''}`.toLowerCase();
  // Word-ish match for the short acronyms so "rfp" doesn't match inside a word.
  const tokenHit = SOLICITATION_TOKENS.some((t) => {
    if (t.length <= 3) {
      return new RegExp(`\\b${t}\\b`, 'i').test(haystack);
    }
    return haystack.includes(t);
  });
  if (tokenHit) return true;

  const sender = hostAndLocal(input.senderAddress);
  return SOLICITATION_SENDER_HINTS.some((h) => sender.includes(h));
}
