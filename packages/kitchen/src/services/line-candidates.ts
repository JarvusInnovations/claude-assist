/**
 * Ranked candidate products for a receipt line that did not match exactly
 * (specs/modules/kitchen.md § Near-miss candidates).
 *
 * **Scores rank the picker. They never decide.** There is no threshold in this
 * file, deliberately — the only automatic product attachment is an exact lexicon
 * hit, which replays a decision a human already made rather than making one. A
 * wrong product silently corrupts a nutrition panel, a price series, and (since
 * an eaten sheet decrements what it names) stock itself, and nothing about a
 * plausible ranking distinguishes that from a right answer.
 */

export interface CandidateSignals {
  /** Similarity to a known receipt line for this store, 0..1. */
  line: number;
  /** Similarity to the product's name or an alias, 0..1. */
  name: number;
  /**
   * Price agreement with this product's history at this store, 0..1, or null
   * when there is no price to compare — never 0, which would read as
   * disagreement rather than absence.
   */
  price: number | null;
}

export interface LineCandidate {
  product_ulid: string;
  product_name: string;
  score: number;
  signals: CandidateSignals;
  /** The known line this matched against, when the line signal carried it. */
  matched_line?: string;
}

/** Receipt lines are terse and abbreviation-heavy; character trigrams survive that better than tokens. */
function trigrams(value: string): Set<string> {
  const v = ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const out = new Set<string>();
  for (let i = 0; i < v.length - 2; i++) out.add(v.slice(i, i + 3));
  return out;
}

/** Dice coefficient over character trigrams: 0 (nothing shared) .. 1 (identical). */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const [x, y] = [trigrams(a), trigrams(b)];
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared += 1;
  return (2 * shared) / (x.size + y.size);
}

/**
 * Price agreement, 0..1. Returns NULL when either side has no price — absence
 * of evidence must not read as evidence of disagreement.
 *
 * Deliberately generous: a sale, a markdown, or a size change should not sink a
 * candidate the text supports. It exists to break ties, not to make calls.
 */
export function priceAgreement(lineCents: number | null, historyCents: number[]): number | null {
  if (lineCents == null || historyCents.length === 0) return null;
  const best = Math.min(...historyCents.map((h) => Math.abs(h - lineCents) / Math.max(h, 1)));
  if (best <= 0.05) return 1;
  if (best >= 0.5) return 0;
  return 1 - (best - 0.05) / 0.45;
}

export interface CandidateInput {
  lineText: string;
  priceCents: number | null;
  products: { ulid: string; name: string; aliases?: string[] | null }[];
  /** Known lines for THIS store, so a re-worded line can find its product. */
  knownLines: { line_text: string; product_ulid: string }[];
  /** product_ulid → its observed prices at this store, in cents. */
  priceHistory: Map<string, number[]>;
  limit?: number;
}

/**
 * Rank candidates. Text carries the decision; price only ever adjusts among
 * candidates the text already supports — a candidate with no textual support
 * cannot be promoted by matching a price, because two unrelated items at one
 * price say nothing.
 */
export function rankCandidates(input: CandidateInput): LineCandidate[] {
  const bestLine = new Map<string, { score: number; line: string }>();
  for (const known of input.knownLines) {
    const score = similarity(input.lineText, known.line_text);
    const prev = bestLine.get(known.product_ulid);
    if (!prev || score > prev.score) bestLine.set(known.product_ulid, { score, line: known.line_text });
  }

  const ranked = input.products.map((p) => {
    const line = bestLine.get(p.ulid);
    const nameScore = Math.max(
      similarity(input.lineText, p.name),
      ...(p.aliases ?? []).map((a) => similarity(input.lineText, a)),
      0
    );
    const signals: CandidateSignals = {
      line: line?.score ?? 0,
      name: nameScore,
      price: priceAgreement(input.priceCents, input.priceHistory.get(p.ulid) ?? []),
    };

    // Text is the whole basis; a known line for this store outweighs a catalog
    // name because it is evidence about how THIS store prints THIS product.
    const text = Math.max(signals.line * 1.15, signals.name);
    // Price adjusts within +/-10% and only scales what text already found. A
    // zero-text candidate stays zero however well the price agrees.
    const priceFactor = signals.price == null ? 1 : 0.9 + signals.price * 0.2;

    return {
      product_ulid: p.ulid,
      product_name: p.name,
      score: Number(Math.min(text * priceFactor, 1).toFixed(4)),
      signals,
      ...(line ? { matched_line: line.line } : {}),
    };
  });

  return ranked
    .filter((c) => c.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 5);
}
