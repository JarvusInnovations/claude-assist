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

// Stopwords stripped when deriving the search term. Verbs are removed
// separately (via VERB_RULES patterns).
const STOPWORDS = new Set([
  'the', 'a', 'an', 'my', 'our', 'some', 'of', 'off', 'up', 'out', 'that',
  'this', 'these', 'those', 'and', 'with', 'from', 'i', 'we', 'just', 'all',
  'rest', 'last', 'bit', 'little', 'touch', 'splash', 'few', 'couple', 'half',
  'quarter', 'most', 'three', 'quarters', 'threw', 'throw', 'away', 'into',
  'broke', 'done', 'no', 'more', 'gone', 'bad', 'went',
]);

export interface ParsedRemark {
  type: InventoryEventType;
  fraction: number | null;
  /** Lowercased search term (may be empty when nothing meaningful remained). */
  term: string;
}

/** Parse a remark into an event, fraction, and search term, or null if no verb matched. */
export function parseRemark(remark: string): ParsedRemark | null {
  const text = remark.trim();
  if (!text) return null;

  let type: InventoryEventType | null = null;
  for (const rule of VERB_RULES) {
    if (rule.pattern.test(text)) {
      type = rule.type;
      break;
    }
  }
  if (!type) return null;

  let fraction: number | null = null;
  for (const rule of FRACTION_RULES) {
    if (rule.pattern.test(text)) {
      fraction = rule.factor;
      break;
    }
  }

  // Strip verb phrases, then tokenize and drop stopwords/short tokens.
  let residue = text;
  for (const rule of VERB_RULES) {
    residue = residue.replace(rule.pattern, ' ');
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
