/**
 * Deterministic urgency core — the interrupt bar, as code.
 *
 * "Interrupts are earned": an interrupt fires only for what genuinely can't
 * wait. This pass is the cheap, explainable first cut. It answers one question
 * per message — is this a directed ask from a teammate, and does it carry a
 * signal that it can't wait? — and assigns a tier. Anything it can't decide
 * confidently (a directed teammate message with no explicit signal) it hands to
 * the model as `residue`; everything not directed at the owner, or not from a
 * teammate with an ask, is `drop` (never an interrupt, never even a near-miss).
 *
 * The regexes are deliberately conservative on the promote-to-urgent side and
 * generous on hand-to-model: the correction path + digest backstop tune the
 * edges, but a loose deterministic core would erode silence, which is the one
 * thing this system cannot spend.
 */

import type { DeterministicResult, SlackCandidate, UrgencyTier } from './types.js';

/** Explicit emergency language — the only thing that pierces quiet hours. */
const EMERGENCY_RE =
  /\b(urgent|emergency|911|p0|sev-?[01]|outage|prod(uction)?\s+(is\s+)?down|site\s+(is\s+)?down|on\s+fire)\b/i;

/** A question / direct ask aimed at the reader. */
const QUESTION_RE =
  /\?|\b(can|could|would|will)\s+you\b|\bcan\s+u\b|\blet\s+me\s+know\b|\bthoughts\?*\b|\bwhat\s+do\s+you\s+think\b|\bneed\s+(your|you\s+to)\b/i;

/** Blockage — someone is stuck on the owner. */
const BLOCKAGE_RE =
  /\b(blocked|blocker|stuck|waiting\s+on\s+you|waiting\s+for\s+you|can'?t\s+(proceed|move|continue|start)|cannot\s+proceed|held\s+up|holding\s+(us|me)\s+up|depends\s+on\s+you|need\s+this\s+from\s+you|on\s+hold)\b/i;

/** Time pressure. */
const DEADLINE_RE =
  /\b(today|tonight|eod|end\s+of\s+day|asap|deadline|due\s+(today|by|soon)|before\s+the\s+(call|meeting|demo|standup)|by\s+(noon|\d{1,2}\s*(am|pm|:\d{2}))|in\s+(an\s+hour|\d+\s*(min|mins|minutes|hour|hours))|right\s+now|time[-\s]?sensitive|can'?t\s+wait)\b/i;

export interface DeterministicInput {
  candidate: SlackCandidate;
  /** true when the message is a DM to the owner (im/mpim). */
  isDirectMessage: boolean;
  /** true when the channel message @mentions the owner. */
  mentionsOwner: boolean;
  /** true when the sender is a known teammate (roster). */
  senderIsTeam: boolean;
  /**
   * Learned correction weight for this sender/channel (summed). Positive leans
   * toward interrupting borderline cases; negative leans away. Only nudges the
   * `residue` boundary — it never manufactures an interrupt from pure noise, and
   * never suppresses an explicit emergency.
   */
  weight: number;
}

/** Promote/demote thresholds for the learned weight (corrections). */
const PROMOTE_AT = 1.0;
const DEMOTE_AT = -1.0;

export function classifyDeterministic(input: DeterministicInput): DeterministicResult {
  const { candidate, isDirectMessage, mentionsOwner, senderIsTeam, weight } = input;
  const text = candidate.text ?? '';
  const directed = isDirectMessage || mentionsOwner;

  const signals: string[] = [];
  if (isDirectMessage) signals.push('dm');
  if (mentionsOwner) signals.push('mention');
  if (senderIsTeam) signals.push('team');

  const hasQuestion = QUESTION_RE.test(text);
  const hasBlockage = BLOCKAGE_RE.test(text);
  const hasDeadline = DEADLINE_RE.test(text);
  const hasEmergency = EMERGENCY_RE.test(text);
  if (hasQuestion) signals.push('question');
  if (hasBlockage) signals.push('blockage');
  if (hasDeadline) signals.push('deadline');
  if (hasEmergency) signals.push('emergency');

  const gist = summarize(text);

  // Not directed at the owner at all → pure noise. Channel chatter never interrupts.
  if (!directed) {
    return { tier: 'drop', signals, gist };
  }

  // Emergency tier: explicit emergency language from a teammate, directed at
  // the owner. This is the only path that overrides quiet hours (gated downstream).
  if (senderIsTeam && hasEmergency) {
    return { tier: 'emergency', signals, gist };
  }

  const hasAsk = hasQuestion || hasBlockage || hasDeadline;

  if (senderIsTeam) {
    if (hasAsk) {
      // A teammate is directly asking / blocked / on a clock → earns an interrupt,
      // unless corrections have taught us this sender is a false-positive machine.
      if (weight <= DEMOTE_AT) return { tier: 'residue', signals, gist };
      return { tier: 'urgent', signals, gist };
    }
    // Directed teammate message, no explicit signal → let the model judge.
    // A strong positive correction weight promotes it straight to urgent.
    if (weight >= PROMOTE_AT) return { tier: 'urgent', signals, gist };
    return { tier: 'residue', signals, gist };
  }

  // Directed at the owner but NOT from a known teammate. A concrete ask (@mention
  // with a direct question/blockage/deadline) is worth a model look; otherwise
  // it's cold/irrelevant → drop. A positive correction weight (the owner flagged
  // this sender/channel as interrupt-worthy) can lift a bare mention to residue.
  if (hasAsk || weight >= PROMOTE_AT) {
    return { tier: 'residue', signals, gist };
  }
  return { tier: 'drop', signals, gist };
}

/** One-line gist: strip Slack mention/link tokens, collapse whitespace, clip. */
export function summarize(text: string, max = 140): string {
  const cleaned = (text ?? '')
    .replace(/<@[A-Z0-9]+(\|[^>]+)?>/g, '') // <@U123|julia>
    .replace(/<#[A-Z0-9]+(\|[^>]+)?>/g, '') // <#C123|general>
    .replace(/<(https?:[^|>]+)(\|([^>]+))?>/g, (_m, url, _p, label) => label || url)
    .replace(/[*_~`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 1).trimEnd() + '…';
}

/* --------------------------------------------------------------------------
 * Quiet hours
 * ------------------------------------------------------------------------ */

/** The local wall-clock hour (0–23) at `date` in the given IANA time zone. */
export function localHourInTz(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  });
  // hour12:false can render "24" at midnight in some environments; normalize.
  const hour = parseInt(fmt.format(date), 10);
  return hour === 24 ? 0 : hour;
}

/**
 * Is `hour` inside the quiet window [startHour, endHour)? The window wraps
 * midnight when start > end (the usual 22:00–07:00 case). The boundary is
 * half-open: exactly `startHour` is quiet, exactly `endHour` is not.
 */
export function isQuietHour(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false; // empty / disabled window
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  // Wrapping window (e.g. 22 → 7): quiet if at/after start OR before end.
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
