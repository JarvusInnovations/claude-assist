/**
 * Two-tier email urgency — the deterministic core, as code.
 *
 * The system sorts triaged mail into two explicit, model-legible tiers per the
 * "interrupts are earned" principle:
 *
 *   INTERRUPT ("bad if unseen for an hour") — a KNOWN human sender, an ask
 *     DIRECTED at the owner, AND an inferred blocking / time-sensitive signal.
 *     Keywords (urgent/ASAP/deadline) are strong signals but NOT the definition:
 *     a directed ask that simply can't wait an hour qualifies even without them.
 *
 *   ATTENTION ("bad if unseen until tomorrow") — a concrete ask addressed to the
 *     owner, OR substantive mail from an individual client contact. Criteria-
 *     driven; never interrupts; surfaces in the morning briefing.
 *
 * This module is the cheap, explainable first cut. It answers structural
 * questions deterministically — is the sender known? is the mail directed at the
 * owner? is it automated? — and either decides a tier outright (a keyword hit
 * from a known, directed human is an INTERRUPT with no model call) or hands the
 * ambiguous middle to the model residue pass, which judges the one question
 * keywords can't: "is this a concrete ask of the owner that cannot wait an hour?"
 *
 * Everything that fails the structural gates is `neither` — no model call, no
 * interrupt, no attention entry. A too-eager bar erodes the one thing this
 * system cannot spend: the trustworthiness of silence.
 *
 * Pure and dependency-free for boundary testing.
 */

/** The two earned tiers, plus the calm default. */
export type EmailTier = 'interrupt' | 'attention' | 'neither';

/** Where a sender's standing comes from (drives the directed-gate rules). */
export type SenderStanding = 'whitelist' | 'client-contact' | 'team-domain' | 'none';

export interface UrgencyInput {
  /** Every address the owner sends as (all accounts). Self-sent mail → neither. */
  ownerAddresses: ReadonlySet<string>;
  senderAddress: string | null;
  senderType: 'human' | 'automated';
  subject: string | null;
  bodyText: string | null;
  snippet: string | null;
  /** Recipients in the To header (compared case-insensitively). */
  toAddresses: readonly string[];
  ccAddresses: readonly string[];
  actionItems: string[];
  /** Reply-history whitelist (addresses the owner has corresponded with). */
  whitelist: ReadonlySet<string>;
  /** Individual client contacts (pluggable contacts source) — get known standing. */
  clientContacts: ReadonlySet<string>;
  /** Team domains (e.g. ['example.com']); a sender in one keeps standing. */
  teamDomains: readonly string[];
  /** Automated-sender heuristic inputs — override sender_type='human' misclassifications. */
  listUnsubscribe?: boolean;
  precedenceBulk?: boolean;
  gmailLabels?: readonly string[];
  /**
   * True when an external participant is replying on a thread the owner is
   * copied on (pipeline-supplied via a thread lookback). Promotes an otherwise
   * calm message to an ATTENTION candidate.
   */
  threadHasOwnerParticipation?: boolean;
}

export interface DeterministicResult {
  /** Best tier the deterministic pass can commit to on its own. */
  tier: EmailTier;
  /**
   * True when structural gates pass but the tier turns on inference the model
   * must make (a directed ask with no keyword certainty, a body-ask addressed to
   * the owner while CC-only, or client-contact substantiveness). The pipeline
   * calls the residue judge; a deterministic `tier` of interrupt/attention with
   * needsModel=false skips the model entirely.
   */
  needsModel: boolean;
  signals: string[];
  reason: string;
  standing: SenderStanding;
  /** Owner address present in the To header (structural directed gate). */
  directedTo: boolean;
  /** Effective automated after the noreply/bulk/list-unsubscribe heuristic. */
  automated: boolean;
}

/**
 * Strong time-sensitivity phrases. Kept to unambiguous deadline / blockage
 * signals — generic CTAs ("check this out", "let me know") are excluded on
 * purpose so marketing and FYI mail can't trip the bar. These are the DETERMINISTIC
 * shortcut to INTERRUPT for a known, directed human; their ABSENCE never rules
 * out an interrupt (the model residue still infers un-keyworded blockage).
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

/** Explicit emergency language — the only thing that pierces quiet hours. */
export const EMERGENCY_PHRASES: readonly string[] = [
  'emergency',
  'urgent',
  'p0',
  'sev-0',
  'sev0',
  'sev-1',
  'production down',
  'prod is down',
  'site is down',
  'outage',
  'critical',
];

/**
 * Local-parts / substrings that mark a machine sender regardless of a model's
 * sender_type call — the "Chewy class" of transactional mail that presents as a
 * human display name but is really automated.
 */
const AUTOMATED_LOCALPARTS: readonly string[] = [
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'notifications',
  'notification',
  'notify',
  'mailer',
  'mailer-daemon',
  'bounce',
  'bounces',
  'automated',
  'auto-confirm',
  'updates',
  'alerts',
  'newsletter',
  'marketing',
  'billing',
  'receipts',
  'invoices',
];

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1) : '';
}

function localOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(0, at) : address;
}

function inTeamDomain(address: string, teamDomains: readonly string[]): boolean {
  const domain = domainOf(address.toLowerCase());
  return teamDomains.some((d) => domain === d.toLowerCase());
}

/**
 * The sender's standing. Order matters: an explicit individual contact/whitelist
 * beats a team-domain match (a team domain keeps standing but NEVER bypasses the
 * directed gate, so distinguishing it is load-bearing downstream).
 */
export function senderStanding(
  address: string | null,
  whitelist: ReadonlySet<string>,
  clientContacts: ReadonlySet<string>,
  teamDomains: readonly string[]
): SenderStanding {
  if (!address) return 'none';
  const addr = address.toLowerCase();
  if (clientContacts.has(addr)) return 'client-contact';
  if (whitelist.has(addr)) return 'whitelist';
  if (inTeamDomain(addr, teamDomains)) return 'team-domain';
  return 'none';
}

/** Back-compat helper retained for callers/tests: any non-'none' standing. */
export function isKnownSender(
  address: string | null,
  whitelist: ReadonlySet<string>,
  teamDomains: readonly string[]
): boolean {
  return senderStanding(address, whitelist, new Set(), teamDomains) !== 'none';
}

/**
 * The independent automated-sender heuristic. Fires on a machine local-part, a
 * List-Unsubscribe header, a bulk precedence header, or Gmail's own CATEGORY_*
 * bucketing — and OVERRIDES a model's sender_type='human' call (the Chewy class).
 */
export function isAutomatedSender(input: {
  senderAddress: string | null;
  senderType: 'human' | 'automated';
  listUnsubscribe?: boolean;
  precedenceBulk?: boolean;
  gmailLabels?: readonly string[];
}): boolean {
  if (input.senderType === 'automated') return true;
  if (input.listUnsubscribe) return true;
  if (input.precedenceBulk) return true;
  const labels = (input.gmailLabels ?? []).map((l) => l.toUpperCase());
  if (labels.some((l) => l.startsWith('CATEGORY_PROMOTIONS') || l.startsWith('CATEGORY_UPDATES'))) {
    return true;
  }
  const local = input.senderAddress ? localOf(input.senderAddress.toLowerCase()) : '';
  return AUTOMATED_LOCALPARTS.some((m) => local === m || local.includes(m));
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

/** True if explicit emergency language appears (pierces quiet hours). */
export function hasEmergencySignal(
  subject: string | null,
  bodyText: string | null,
  snippet: string | null
): boolean {
  const haystack = `${subject ?? ''}\n${bodyText ?? snippet ?? ''}`.toLowerCase();
  return EMERGENCY_PHRASES.some((p) => haystack.includes(p));
}

/** True when any owner address appears in the To header (structural directed gate). */
export function isDirectedToOwner(
  toAddresses: readonly string[],
  ownerAddresses: ReadonlySet<string>
): boolean {
  return toAddresses.some((a) => ownerAddresses.has(a.trim().toLowerCase()));
}

function isSelfSent(address: string | null, ownerAddresses: ReadonlySet<string>): boolean {
  return address != null && ownerAddresses.has(address.trim().toLowerCase());
}

/**
 * The deterministic classification. Commits a tier when the structural gates are
 * decisive; otherwise reports the gate state and `needsModel` so the pipeline can
 * run the residue judge. NEVER interrupts on its own without a keyword hit — the
 * un-keyworded "can't wait an hour" case is the model's to make.
 */
export function classifyEmailDeterministic(input: UrgencyInput): DeterministicResult {
  const signals: string[] = [];

  // Boundary: the owner's own mail (any account) is never a tier.
  if (isSelfSent(input.senderAddress, input.ownerAddresses)) {
    return neither('self-sent', 'none', false, false, ['self']);
  }

  const automated = isAutomatedSender(input);
  if (automated) signals.push('automated');

  const standing = senderStanding(
    input.senderAddress,
    input.whitelist,
    input.clientContacts,
    input.teamDomains
  );
  if (standing !== 'none') signals.push(`standing:${standing}`);

  const directedTo = isDirectedToOwner(input.toAddresses, input.ownerAddresses);
  if (directedTo) signals.push('directed-to');

  // Automated mail never earns a tier — overrides a human misclassification.
  if (automated) {
    return {
      tier: 'neither',
      needsModel: false,
      signals,
      reason: 'automated sender (heuristic override)',
      standing,
      directedTo,
      automated: true,
    };
  }

  const keyword = hasTimeSensitivitySignal(input.subject, input.bodyText, input.snippet);
  if (keyword) signals.push('deadline/urgency phrase');
  const hasAction = input.actionItems.length > 0;
  if (hasAction) signals.push(`${input.actionItems.length} action item(s)`);

  // No standing → the sender is a stranger; never interrupt/attention on the
  // ordinary gates. (The opportunity path handles wanted RFPs from strangers, and
  // the cold-outreach heuristic tags unwanted ones — both run in the pipeline, not
  // here.) A thread the owner is on can still promote a reply (below).
  if (standing === 'none') {
    if (input.threadHasOwnerParticipation) {
      signals.push('thread-owner-participation');
      return {
        tier: 'attention',
        needsModel: false,
        signals,
        reason: 'external reply on a thread the owner is on',
        standing,
        directedTo,
        automated: false,
      };
    }
    return {
      tier: 'neither',
      needsModel: false,
      signals,
      reason: 'sender has no standing (not whitelist/contact/team)',
      standing,
      directedTo,
      automated: false,
    };
  }

  // Known human + directed (To) + keyword → INTERRUPT, deterministically. This is
  // the only path that skips the model on the way to an interrupt.
  if (directedTo && keyword) {
    return {
      tier: 'interrupt',
      needsModel: false,
      signals,
      reason: `known human (${standing}) + directed + deadline/urgency phrase`,
      standing,
      directedTo,
      automated: false,
    };
  }

  if (input.threadHasOwnerParticipation) {
    signals.push('thread-owner-participation');
  }

  // A candidate the model should judge: is this a concrete ask of the owner
  // (attention), and does it also carry blockage the owner would regret missing
  // for an hour (interrupt)? We call the model when there is a real reason to:
  //  - directed to the owner (To line), OR
  //  - from an individual client contact (judge substantiveness — e.g. an AP thread), OR
  //  - a reply on a thread the owner participates in, OR
  //  - CC-only but carrying an ask hint (a body ask could be addressed to the owner
  //    by name — model-inferable). A CC-only FYI with no ask hint stays calm with
  //    NO model call, which is what keeps the residue-pass cost bounded.
  const askHint = hasAction || hasAskLanguage(input.bodyText, input.snippet);
  const shouldJudge =
    directedTo ||
    standing === 'client-contact' ||
    Boolean(input.threadHasOwnerParticipation) ||
    askHint;

  if (!shouldJudge) {
    return {
      tier: 'neither',
      needsModel: false,
      signals,
      reason: 'known human, CC-only FYI with no ask — calm',
      standing,
      directedTo,
      automated: false,
    };
  }

  return {
    tier: 'neither',
    needsModel: true,
    signals,
    reason: directedTo
      ? 'directed to a known human — model judges ask/urgency'
      : standing === 'client-contact'
        ? 'client contact — model judges substantive ask'
        : input.threadHasOwnerParticipation
          ? 'known human on owner thread — model judges ask'
          : 'CC-only with an ask hint — model judges body-ask-to-owner',
    standing,
    directedTo,
    automated: false,
  };
}

/** Cheap ask-language sniff (a question or request phrasing) for CC-only mail. */
const ASK_LANGUAGE_RE =
  /\?|\b(can|could|would|will)\s+you\b|\bplease\s+(send|review|approve|confirm|advise|sign|respond|reply)\b|\blet\s+me\s+know\b|\bneed\s+(you|your)\b|\bwaiting\s+on\b|\bcan\s+you\s+(send|share|confirm)\b/i;

export function hasAskLanguage(bodyText: string | null, snippet: string | null): boolean {
  return ASK_LANGUAGE_RE.test(bodyText ?? snippet ?? '');
}

function neither(
  reason: string,
  standing: SenderStanding,
  directedTo: boolean,
  automated: boolean,
  signals: string[]
): DeterministicResult {
  return { tier: 'neither', needsModel: false, signals, reason, standing, directedTo, automated };
}

/* --------------------------------------------------------------------------
 * Quiet hours (mirrors slack-urgency/urgency.ts — the SAME semantics, owner TZ)
 * ------------------------------------------------------------------------ */

/** The local wall-clock hour (0–23) at `date` in the given IANA time zone. */
export function localHourInTz(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false });
  const hour = parseInt(fmt.format(date), 10);
  return hour === 24 ? 0 : hour;
}

/**
 * Is `hour` inside the quiet window [startHour, endHour)? The window wraps
 * midnight when start > end (the usual 22:00–07:00 case). Half-open: exactly
 * `startHour` is quiet, exactly `endHour` is not.
 */
export function isQuietHour(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

export interface QuietHoursConfig {
  timeZone: string;
  startHour: number;
  endHour: number;
}

export function isQuietHours(date: Date, config: QuietHoursConfig): boolean {
  return isQuietHour(localHourInTz(date, config.timeZone), config.startHour, config.endHour);
}
