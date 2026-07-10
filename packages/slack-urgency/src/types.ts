/**
 * Slack urgency types.
 *
 * The vocabulary the whole module speaks: a raw candidate message pulled from
 * Slack, the deterministic/model verdict over it, and the persisted record.
 */

/** Channel kinds we distinguish. `im` = 1:1 DM, `mpim` = group DM. */
export type ChannelType = 'im' | 'mpim' | 'channel' | 'group';

/**
 * A message pulled from Slack, normalized. This is the unit the classifier and
 * pipeline reason over — deliberately free of the Slack API's shape so the core
 * logic is testable without a live workspace.
 */
export interface SlackCandidate {
  channel: string;
  ts: string;
  threadTs: string | null;
  channelType: ChannelType;
  sender: string;
  senderName: string | null;
  text: string;
  /** true when the message carries a bot_id / bot subtype (never interrupts). */
  isBot: boolean;
}

/**
 * Deterministic urgency tier (the bar as implemented — see urgency.ts):
 *   emergency — explicit URGENT/emergency from a teammate; overrides quiet hours.
 *   urgent    — a directed teammate message carrying a question/blockage/deadline.
 *   residue   — a directed teammate message with no explicit signal; the model
 *               makes the call (would Chris regret seeing it an hour later?).
 *   drop      — not directed at Chris, or not from a teammate, with no ask;
 *               never an interrupt, never a near-miss (pure noise).
 */
export type UrgencyTier = 'emergency' | 'urgent' | 'residue' | 'drop';

/** What actually happened to a candidate after the full policy ran. */
export type Verdict =
  | 'interrupt' // fired a wrist-reaching alert
  | 'near_miss' // plausible but suppressed (quiet hours / model said wait) → digest backstop
  | 'folded' // a later message in a thread that already interrupted (dedup)
  | 'suppressed' // boundary hit (self / already-replied) — not noise, just handled
  | 'drop'; // pure noise

export interface DeterministicResult {
  tier: UrgencyTier;
  signals: string[];
  gist: string;
}

export interface ModelVerdict {
  urgent: boolean;
  gist: string;
  rationale: string;
  confidence: number;
  model: string;
}

/** The full decision for one candidate, ready to persist + (maybe) dispatch. */
export interface Decision {
  candidate: SlackCandidate;
  tier: UrgencyTier;
  verdict: Verdict;
  classifier: 'deterministic' | 'model';
  model: string | null;
  gist: string;
  signals: string[];
  rationale: string | null;
  confidence: number | null;
  interrupted: boolean;
  nearMiss: boolean;
  /** Reason a boundary/drop fired, for logs (not persisted). */
  reason?: string;
}

/** A roster entry: a Slack user id mapped to a display name. */
export interface RosterEntry {
  id: string;
  name: string;
}
