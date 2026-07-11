/**
 * Generic cold-outreach heuristic.
 *
 * A recurring nuisance class is personalized-SEEMING cold outreach: a stranger
 * on a fresh vanity/freemail domain, no prior thread, a short solicitation body
 * ("can I share info about the cohort/collective?"), the recipient's first name
 * sprinkled in for warmth, and an opt-out sign-off ("reply no thanks"). It reads
 * personal enough that a per-message classifier sometimes waves it through as
 * `personal` mail — which would then be eligible for the attention/interrupt
 * tiers. This heuristic catches it structurally so it stays `neither`.
 *
 * The signal is a CONJUNCTION, never a single keyword: opt-out language alone is
 * far too common in legitimate mail. A message must clear a score threshold
 * across independent features to be flagged. All tokens/weights are parameters —
 * NO real sender, domain, or campaign string is baked in. An operator tunes the
 * lists to their own inbox; the defaults below are generic and illustrative.
 *
 * Pure and dependency-free.
 */

export interface ColdOutreachConfig {
  /** Solicitation-language tokens (cohort/collective/exclusive-invite framing). */
  solicitationTokens: readonly string[];
  /** Opt-out sign-off tokens ("reply no thanks", "not aligned"). */
  optOutTokens: readonly string[];
  /** Permission-to-send framing ("can I share", "shall I send", "mind if I"). */
  permissionTokens: readonly string[];
  /**
   * Score at/above which a message is flagged as cold outreach. Each satisfied
   * feature contributes its weight; see `scoreColdOutreach`.
   */
  threshold: number;
}

/** Generic, inbox-agnostic defaults. Operators override via config. */
export const DEFAULT_COLD_OUTREACH_CONFIG: ColdOutreachConfig = {
  solicitationTokens: [
    'cohort',
    'consortia',
    'consortium',
    'collective',
    'early-stage',
    'early stage',
    'bootstrapped',
    'venture-backed',
    'venture backed',
    'accelerator',
    'founders',
    'reserve a spot',
    'holding a spot',
    'opened up seats',
    'additional seats',
    'a few spots',
  ],
  optOutTokens: [
    'no thanks',
    'not aligned',
    'misaligned',
    'wrong fit',
    'no more emails',
    'sitting this out',
    'skip thanks',
    'opt out',
    'opt-out',
    'unsubscribe',
    'reply stop',
    'reply no',
  ],
  permissionTokens: [
    'can i share',
    'shall i send',
    'mind if i',
    'may i share',
    'want me to send',
    'should i send',
    'ok if i forward',
    'alright if i forward',
    'can i forward',
    'happy to forward',
  ],
  threshold: 3,
};

export interface ColdOutreachInput {
  senderAddress: string | null;
  subject: string | null;
  bodyText: string | null;
  snippet: string | null;
  /** Recipient first name(s) to detect warmth-personalization tokens. */
  recipientNames: readonly string[];
  /** True when this is the sender's first message (no prior thread / no standing). */
  firstContact: boolean;
  /** Body length in characters — cold outreach skews short. */
  bodyLength: number;
}

export interface ColdOutreachResult {
  isColdOutreach: boolean;
  score: number;
  signals: string[];
}

function includesAny(haystack: string, tokens: readonly string[]): string | null {
  for (const t of tokens) {
    if (haystack.includes(t.toLowerCase())) return t;
  }
  return null;
}

/**
 * Score a message against the cold-outreach features. Weights are chosen so no
 * single feature can trip the default threshold (3): first-contact + one content
 * feature is not enough; it takes the multi-feature signature to flag.
 */
export function scoreColdOutreach(
  input: ColdOutreachInput,
  config: ColdOutreachConfig = DEFAULT_COLD_OUTREACH_CONFIG
): ColdOutreachResult {
  const haystack = `${input.subject ?? ''}\n${input.bodyText ?? input.snippet ?? ''}`.toLowerCase();
  const signals: string[] = [];
  let score = 0;

  // First contact is a precondition, not a strong signal on its own (weight 1).
  if (input.firstContact) {
    score += 1;
    signals.push('first-contact');
  }

  const solicit = includesAny(haystack, config.solicitationTokens);
  if (solicit) {
    score += 2;
    signals.push(`solicitation:${solicit}`);
  }

  const permission = includesAny(haystack, config.permissionTokens);
  if (permission) {
    score += 1;
    signals.push('permission-to-send');
  }

  const optOut = includesAny(haystack, config.optOutTokens);
  if (optOut) {
    score += 1;
    signals.push('opt-out-signoff');
  }

  // Warmth personalization: recipient's first name in a short body.
  const personalized = input.recipientNames.some(
    (n) => n.length >= 2 && haystack.includes(n.toLowerCase())
  );
  if (personalized && input.bodyLength > 0 && input.bodyLength <= 600) {
    score += 1;
    signals.push('personalized-short-body');
  }

  return {
    isColdOutreach: input.firstContact && score >= config.threshold,
    score,
    signals,
  };
}
