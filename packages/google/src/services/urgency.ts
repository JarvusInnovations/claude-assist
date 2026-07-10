/**
 * Urgent-alert classifier for the "interrupts are earned" bar.
 *
 * An interrupt (phone + watch, via the notification dispatcher) fires only for
 * mail that genuinely can't wait. The bar, kept deliberately narrow:
 *
 *   1. The sender is a HUMAN (automated mail never interrupts), AND
 *   2. The sender is KNOWN — their address is on the whitelist (reply history
 *      plus any optional external contacts source) or their domain is a team
 *      domain, AND
 *   3. There is a genuine time-sensitivity signal — an explicit deadline /
 *      urgency phrase, or the analysis surfaced a concrete action item.
 *
 * Everything else is digest material. A too-eager bar destroys the value of the
 * push channel (silence must be trustworthy), so near-misses are meant to be
 * caught by the daily digest's false-negative backstop, not by loosening this.
 *
 * Pure and dependency-free for boundary testing.
 */

export interface UrgencyInput {
  senderAddress: string | null;
  senderType: 'human' | 'automated';
  subject: string | null;
  bodyText: string | null;
  snippet: string | null;
  actionItems: string[];
  /** Lowercased whitelist addresses (reply history + optional external contacts). */
  whitelist: ReadonlySet<string>;
  /** Team domains (e.g. ['example.com']); a sender in one is treated as known. */
  teamDomains: readonly string[];
}

export interface UrgencyResult {
  urgent: boolean;
  reason: string;
}

/**
 * Strong time-sensitivity phrases. Kept to unambiguous deadline / blockage
 * signals — generic CTAs ("check this out", "let me know") are excluded on
 * purpose so marketing and FYI mail can't trip the bar.
 */
export const URGENCY_PHRASES: readonly string[] = [
  'urgent',
  'asap',
  'as soon as possible',
  'end of day',
  'eod',
  'by today',
  'by tomorrow',
  'by end of day',
  'by end of week',
  'time-sensitive',
  'time sensitive',
  'right away',
  'deadline',
  "i'm blocked",
  'im blocked',
  'blocked on',
  'blocker',
  'waiting on you',
  'waiting for you',
  'waiting on your',
  'please respond by',
  'need your',
  'need this by',
  'need it by',
  'can you review by',
  'before the call',
  'before our meeting',
];

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1) : '';
}

/** True if the sender is on the whitelist or in a team domain. */
export function isKnownSender(
  address: string | null,
  whitelist: ReadonlySet<string>,
  teamDomains: readonly string[]
): boolean {
  if (!address) return false;
  const addr = address.toLowerCase();
  if (whitelist.has(addr)) return true;
  const domain = domainOf(addr);
  return teamDomains.some((d) => domain === d.toLowerCase());
}

/** True if any strong time-sensitivity phrase appears in subject/body/snippet. */
export function hasTimeSensitivitySignal(
  subject: string | null,
  bodyText: string | null,
  snippet: string | null
): boolean {
  const haystack = `${subject ?? ''}\n${bodyText ?? snippet ?? ''}`.toLowerCase();
  return URGENCY_PHRASES.some((p) => haystack.includes(p));
}

export function classifyUrgency(input: UrgencyInput): UrgencyResult {
  if (input.senderType !== 'human') {
    return { urgent: false, reason: 'sender is automated' };
  }

  if (!isKnownSender(input.senderAddress, input.whitelist, input.teamDomains)) {
    return { urgent: false, reason: 'sender not on whitelist or team domain' };
  }

  const phraseSignal = hasTimeSensitivitySignal(
    input.subject,
    input.bodyText,
    input.snippet
  );
  const actionSignal = input.actionItems.length > 0;

  if (!phraseSignal && !actionSignal) {
    return { urgent: false, reason: 'no time-sensitivity signal' };
  }

  const parts: string[] = [];
  if (phraseSignal) parts.push('deadline/urgency phrase');
  if (actionSignal) parts.push(`${input.actionItems.length} action item(s)`);
  return {
    urgent: true,
    reason: `known human sender + ${parts.join(' + ')}`,
  };
}
