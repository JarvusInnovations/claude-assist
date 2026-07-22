/**
 * Deterministic free-text remark parsing for the event resolver — no model
 * call. Turns a passing remark ("opened the feta", "tossed half the
 * tomatoes") into an event type, an optional fraction, and a search term used
 * to match against on-hand items. Best-effort and directional per the module
 * principle: a remark that yields no confident event/term is simply unmatched.
 */

import type { InventoryEventType } from './inventory-types.js';

interface VerbRule {
  type: InventoryEventType;
  pattern: RegExp;
}

// Order matters: finished/tossed verbs are checked before `opened` so
// "used up the opened jar" reads as finished, not opened.
const VERB_RULES: VerbRule[] = [
  { type: 'tossed', pattern: /\b(toss(?:ed|ing)?|threw (?:out|away)|throw(?:ing)? (?:out|away)|trash(?:ed)?|chuck(?:ed)?|compost(?:ed)?|wasted|spoiled|went bad|gone bad|moldy|rotten|expired)\b/i },
  { type: 'finished', pattern: /\b(finish(?:ed)?|kill(?:ed)?|used? up|use up|polished off|ran out(?: of)?|out of|empt(?:y|ied)|all gone|no more|ate the (?:last|rest)|done with)\b/i },
  { type: 'opened', pattern: /\b(open(?:ed|ing)?|crack(?:ed)? open|start(?:ed)? (?:the|a|on)|broke into)\b/i },
];

interface FractionRule {
  factor: number;
  pattern: RegExp;
}

const FRACTION_RULES: FractionRule[] = [
  { factor: 0.5, pattern: /\bhalf\b|\b1\/2\b/i },
  { factor: 0.25, pattern: /\b(a )?quarter\b|\b1\/4\b/i },
  { factor: 0.75, pattern: /\bmost\b|\bthree[- ]quarters\b|\b3\/4\b/i },
  { factor: 0.15, pattern: /\b(a (?:bit|little|touch|splash)|some|a few|couple)\b/i },
];

// ── Recount detection (§ Reconcile) ──────────────────────────────────────────
// A remark that CORRECTS the ledger ("soymilk is actually 75% full", "the
// carton is much fuller than tracked") is an observation, not a consumption
// event — it routes to reconcile. Conservative: it needs BOTH a correction cue
// and an explicit remaining quantity, or it stays with the verb rules /
// unmatched.
const RECOUNT_CUE = /\b(actually|really|turns out|recount(?:ed)?|correct(?:ed|ion)?|ledger|wrong|off by|fuller|more like|much (?:fuller|more)|still (?:have|got))\b/i;
const PERCENT_PATTERN = /(\d{1,3})\s*(?:%|percent\b)/i;
const RECOUNT_LEVEL_RULES: FractionRule[] = [
  { factor: 1, pattern: /\b(unopened|untouched|(?:completely |totally )?full)\b/i },
  { factor: 0.8, pattern: /\b(mostly|nearly|almost) full\b/i },
  { factor: 0.75, pattern: /\bthree[- ]quarters\b|\b3\/4\b/i },
  { factor: 0.5, pattern: /\bhalf\b|\b1\/2\b/i },
  { factor: 0.25, pattern: /\b(a )?quarter\b|\b1\/4\b/i },
  { factor: 0.1, pattern: /\b(almost|nearly) (?:empty|gone|out)\b/i },
];

/**
 * Extract the corrected remaining fraction from a recount remark, or null.
 * A remark carrying MORE THAN ONE percent is ambiguous by construction — a
 * correction usually states both the wrong ledger value and the observed one
 * ("ledger's 34% … actually 75%") with no deterministic winner — so it stays
 * unmatched (the caller falls back to an explicit recount).
 */
function recountFraction(text: string): number | null {
  const pcts = [...text.matchAll(new RegExp(PERCENT_PATTERN, 'gi'))];
  if (pcts.length > 1) return null;
  if (pcts.length === 1) {
    const n = parseInt(pcts[0]![1]!, 10);
    if (n >= 1 && n <= 100) return n / 100;
    return null;
  }
  for (const rule of RECOUNT_LEVEL_RULES) {
    if (rule.pattern.test(text)) return rule.factor;
  }
  return null;
}

// Stopwords stripped when deriving the search term. Verbs are removed
// separately (via VERB_RULES patterns).
const STOPWORDS = new Set([
  'the', 'a', 'an', 'my', 'our', 'some', 'of', 'off', 'up', 'out', 'that',
  'this', 'these', 'those', 'and', 'with', 'from', 'i', 'we', 'just', 'all',
  'rest', 'last', 'bit', 'little', 'touch', 'splash', 'few', 'couple', 'half',
  'quarter', 'most', 'three', 'quarters', 'threw', 'throw', 'away', 'into',
  'broke', 'done', 'no', 'more', 'gone', 'bad', 'went',
  // Recount-remark filler (§ Reconcile)
  'is', 'are', 'was', 'were', 'than', 'not', 'its', 'it', 'like', 'left',
  'remaining', 'tracked', 'says', 'said', 'much', 'roughly', 'about',
]);

export interface ParsedRemark {
  /** An event verb, or `recount` — a ledger correction that routes to § Reconcile. */
  type: InventoryEventType | 'recount';
  fraction: number | null;
  /** Lowercased search term (may be empty when nothing meaningful remained). */
  term: string;
}

/**
 * Parse a remark into an event (or recount), fraction, and search term, or
 * null when neither a verb nor a confident recount matched. Verbs win: a
 * remark that describes something HAPPENING ("tossed half…") is an event even
 * when it also carries correction language; recount applies only to pure
 * observations ("…is actually 75% full").
 */
export function parseRemark(remark: string): ParsedRemark | null {
  const text = remark.trim();
  if (!text) return null;

  let type: InventoryEventType | 'recount' | null = null;
  for (const rule of VERB_RULES) {
    if (rule.pattern.test(text)) {
      type = rule.type;
      break;
    }
  }

  let fraction: number | null = null;
  if (type) {
    for (const rule of FRACTION_RULES) {
      if (rule.pattern.test(text)) {
        fraction = rule.factor;
        break;
      }
    }
  } else {
    // No verb — a correction cue plus an explicit remaining quantity reads as
    // a recount; anything less stays unmatched (conservative by principle).
    const level = recountFraction(text);
    if (RECOUNT_CUE.test(text) && level !== null) {
      type = 'recount';
      fraction = level;
    }
  }
  if (!type) return null;

  // Strip verb/cue/quantity phrases, then tokenize and drop stopwords/short tokens.
  let residue = text;
  for (const rule of VERB_RULES) {
    residue = residue.replace(rule.pattern, ' ');
  }
  if (type === 'recount') {
    residue = residue.replace(RECOUNT_CUE, ' ').replace(PERCENT_PATTERN, ' ');
    for (const rule of RECOUNT_LEVEL_RULES) {
      residue = residue.replace(rule.pattern, ' ');
    }
  }
  const term = residue
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((tok) => tok.length > 1 && !STOPWORDS.has(tok))
    .join(' ')
    .trim();

  return { type, fraction, term };
}

/**
 * Score how well a candidate label/name matches a search term. Conservative:
 * 3 = exact, 2 = candidate contains the whole term (or vice versa), 1 = a term
 * word matches a candidate word, 0 = no match. The caller keeps only a single
 * unambiguous best match.
 */
export function matchScore(term: string, candidate: string | null | undefined): number {
  if (!term || !candidate) return 0;
  const a = term.toLowerCase().trim();
  const b = candidate.toLowerCase().trim();
  if (!a || !b) return 0;
  if (a === b) return 3;
  if (b.includes(a) || a.includes(b)) return 2;
  const aWords = new Set(a.split(/\s+/));
  const bWords = new Set(b.split(/\s+/));
  for (const w of aWords) {
    if (w.length > 2 && bWords.has(w)) return 1;
  }
  return 0;
}
