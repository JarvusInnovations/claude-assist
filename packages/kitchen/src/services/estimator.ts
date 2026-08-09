/**
 * Kitchen estimator: one structured-output vision call per estimation
 * attempt (photos + note → {label, calories, macros, confidence,
 * portion_basis, excluded}). Tagged-JSON rather than the provider's
 * structured-outputs feature, so the estimation model stays swappable to any
 * vision-capable model the instance configures (structured outputs has a
 * narrower supported-model list).
 *
 * The capture action is the type hint (specs/modules/kitchen.md § Estimation
 * & model tiering) — there is no separate classification call here; the
 * caller already knows this is a meal-estimation job.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { InvokeContentBlock, ModelInvoker } from '@jarvus/claude-assist-core';
import type { EstimateExclusion, ExclusionKind, ModelEstimate, PhotoPart } from '../types.js';
import { EXCLUSION_KINDS } from '../types.js';

export class EstimateParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EstimateParseError';
  }
}

export interface EstimatorConfig {
  /** The single metered-model choke point (specs/modules/invoker.md). */
  invoker: ModelInvoker;
  /** Pin a model for this call site. Prefer moving the tier instead. */
  model?: string;
  maxTokens?: number;
}

export interface EstimateInput {
  note: string | null;
  photos: PhotoPart[];
}

/** The pipeline depends on this narrow interface, not the concrete class — tests inject a fake. */
export interface Estimator {
  estimate(input: EstimateInput): Promise<ModelEstimate>;
}

export const SYSTEM_PROMPT = `<role>
You estimate the nutrition of a single home-logged meal or snack for a personal consumption journal. The owner wants a ballpark, not a lab result — a longitudinal record beats precision on any one entry.
</role>

<instructions>
1. Look at any photos and read the owner's note (if present). Identify what was eaten and a reasonable portion size.
2. Printed text in a photo — an order sticker, a packaging label, a menu board, or a nutrition panel in frame — is AUTHORITATIVE over your own visual read: trust it for identity, size, and ingredients ahead of guessing from appearance alone. Raise your confidence when the text corroborates what you see; a lazy shot with the label in frame is the most accurate case, not the least.
3. BILLING LINES ARE NOT FOOD. A receipt or delivery order prints charges in the same list as the items: delivery fee, service fee, small order fee, bag fee, convenience/priority fee, sales tax, tip/gratuity, bottle deposit, promo or coupon or loyalty credit, rounding, refund, balance. NEVER estimate nutrition for one — a service charge has no calories, and a negative money line (a discount, a deposit return) is not negative food. EXCLUDE each such line and report it in "excluded" with the text as printed and its kind (fee, tax, tip, deposit, discount, adjustment, other), then estimate the meal from the FOOD lines only.
   The line you must not sweep in: a genuinely UNKNOWN FOOD line — "MISC GROCERY", a bare department code, an abbreviation you can't expand — is food you couldn't identify, not a charge. Estimate it as best you can and lower your confidence; do NOT put it in "excluded". "I can't tell what food this is" and "this is definitely not food" are different answers and must not collapse into one bucket. When you are unsure which a line is, treat it as food.
4. Estimate total calories and the nutrition panel (protein_g, fat_g, sat_fat_g, carbs_g, sugar_g, added_sugar_g, fiber_g, sodium_mg) for the portion you can see/read — not a "standard serving" from a database, your own best visual/textual judgement (informed by any printed text per the rule above). sugar_g is TOTAL sugar (intrinsic + added); fiber_g is dietary fiber.
5. added_sugar_g is the part of sugar_g added in processing or preparation — the WHO "free sugars" concept: added sugar plus honey, syrups, and FRUIT JUICE. Rules, in priority order:
   - A nutrition panel in frame is AUTHORITATIVE: US labels print "Includes Xg Added Sugars" — transcribe it.
   - Unprocessed whole foods are 0, BY DEFINITION, NOT null: fruit, vegetables, plain dairy (milk, plain yogurt, cheese), eggs, meat, fish, plain grains, plain legumes, nuts, plain coffee and tea. Lactose in milk and fructose in whole fruit are intrinsic — they belong in sugar_g only. State added_sugar_g: 0 for these; a null here silently deletes the day's added-sugar total.
   - Restaurant and prepared dishes are a genuine ESTIMATE reasoned from the visible sweeteners: glazes, sauces, dressings, marinades, ketchup/BBQ, breads and baked goods, sweetened drinks, flavored yogurt, granola, syrup. A reasoned number beats null; lower your overall confidence instead.
   - Juice counts as added even when it is "100% juice".
   - null is only for a genuinely unreadable case (e.g. an unidentifiable packaged item with no panel in frame).
   added_sugar_g must never exceed sugar_g.
6. Give a short display label (under 60 chars) — e.g. "Grilled chicken salad", "Two slices pepperoni pizza".
7. State your portion basis in one short phrase (e.g. "one dinner plate, ~350g", "12oz based on the note").
8. State confidence 0.0-1.0. Lower confidence for ambiguous photos, no photos (note-only), or unusual foods. A prepared dish whose added sugar you had to reason about is legitimately lower-confidence than a label read — that is expected, not a failure.
9. If there is truly nothing to go on (no photo, no note, or unreadable), still return your best guess with low confidence — never refuse. A rough number beats no number.
</instructions>

<response_format>
Return ONLY a JSON object inside <estimate> tags. No markdown, no text outside the tags.

<estimate>
{
  "label": "short display label",
  "calories": 000,
  "macros": {"protein_g": 0, "fat_g": 0, "sat_fat_g": 0, "carbs_g": 0, "sugar_g": 0, "added_sugar_g": 0, "fiber_g": 0, "sodium_mg": 0},
  "confidence": 0.0,
  "portion_basis": "one short phrase",
  "excluded": [{"text": "line text as printed", "kind": "fee"}]
}
</estimate>

Any macro you truly cannot estimate should be null, not 0 — 0 means "none", not "unknown". The one field where 0 is an ASSERTION you should make freely is added_sugar_g on unprocessed whole foods (rule 5). No macro is ever negative.

"excluded" is the non-food billing lines you dropped (rule 3) — [] when there were none, which is the normal case for an ordinary meal photo. Every entry needs a "kind" from: fee, tax, tip, deposit, discount, adjustment, other. Never put a food line in it, however odd the line reads.
</response_format>`;

export class KitchenEstimator implements Estimator {
  private invoker: ModelInvoker;
  private model: string | undefined;
  private maxTokens: number;
  private log: FastifyBaseLogger;

  constructor(config: EstimatorConfig, log: FastifyBaseLogger) {
    this.invoker = config.invoker;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 1024;
    this.log = log;
  }

  async estimate(input: EstimateInput): Promise<ModelEstimate> {
    const content: InvokeContentBlock[] = input.photos.map((photo) => ({
      type: 'image' as const,
      data: photo.data.toString('base64'),
      mediaType: photo.mimeType,
    }));
    content.push({ type: 'text', text: buildPrompt(input.note, input.photos.length) });

    // Tag extraction, the correction turn, retries, timeouts, and spend
    // accounting all live in the invoker; what stays here is the prompt and the
    // shape validation, which are this module's own judgment.
    return this.invoker.invokeTagged<ModelEstimate>({
      task: 'kitchen.estimate',
      tier: 'vision',
      maxTokens: this.maxTokens,
      ...(this.model ? { model: this.model } : {}),
      system: SYSTEM_PROMPT,
      tag: 'estimate',
      parse: parseEstimateResponse,
      messages: [{ role: 'user', content }],
    });
  }
}

/**
 * Parse the contents of one `<estimate>` block into a `ModelEstimate`.
 * Module-level and exported because it is the estimator's whole output
 * contract — the tests that pin that contract must not have to stand up a model
 * to reach it. Throws `EstimateParseError` for a malformed payload, which is
 * what the invoker turns into a correction turn.
 */
export function parseEstimateResponse(text: string): ModelEstimate {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.trim());
  } catch (error) {
    throw new EstimateParseError(
      `JSON parse error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const label = typeof parsed.label === 'string' && parsed.label.trim() ? parsed.label.trim() : 'Logged item';
  const macros = (parsed.macros && typeof parsed.macros === 'object' ? parsed.macros : {}) as Record<
    string,
    unknown
  >;
  const confidence =
    typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0.3;
  const portionBasis =
    typeof parsed.portion_basis === 'string' && parsed.portion_basis.trim() ? parsed.portion_basis.trim() : '';

  return {
    label,
    calories: numOrNull(parsed.calories),
    protein_g: numOrNull(macros.protein_g),
    fat_g: numOrNull(macros.fat_g),
    sat_fat_g: numOrNull(macros.sat_fat_g),
    carbs_g: numOrNull(macros.carbs_g),
    sugar_g: numOrNull(macros.sugar_g),
    added_sugar_g: numOrNull(macros.added_sugar_g),
    fiber_g: numOrNull(macros.fiber_g),
    sodium_mg: numOrNull(macros.sodium_mg),
    confidence,
    portion_basis: portionBasis,
    excluded: normalizeExclusions(parsed.excluded),
  };
}


/**
 * A panel number, or null. **Negatives are rejected as unknown**, which is the
 * structural half of § Billing artifacts are not ingredients: no food has
 * negative calories or negative sodium, so a negative can only be a signed money
 * line (a discount, a deposit return, a refund) that leaked through the prompt
 * rule and reached the arithmetic. Storing it would let one credit line subtract
 * real food from a day's total — an error that reads as *better* eating and so
 * never gets questioned. Null costs the field; a negative corrupts the day.
 */
function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Normalize the model's `excluded` array (§ Billing artifacts are not
 * ingredients). Lenient by design: an unparseable entry is dropped rather than
 * failing the whole estimate, since the numbers are the answer and the exclusion
 * list is the audit trail beside them. An unrecognized `kind` becomes `other` —
 * a reported exclusion under a vague kind beats a discarded one.
 */
function normalizeExclusions(value: unknown): EstimateExclusion[] {
  if (!Array.isArray(value)) return [];
  const out: EstimateExclusion[] = [];
  for (const raw of value) {
    if (out.length >= MAX_EXCLUSIONS) break;
    const text =
      typeof raw === 'string'
        ? raw.trim()
        : raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).text === 'string'
          ? ((raw as Record<string, unknown>).text as string).trim()
          : '';
    if (!text) continue;
    const rawKind = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).kind : undefined;
    const kind = (EXCLUSION_KINDS as readonly string[]).includes(rawKind as string)
      ? (rawKind as ExclusionKind)
      : 'other';
    out.push({ text: text.slice(0, MAX_EXCLUSION_TEXT), kind });
  }
  return out;
}

/**
 * Bounds on the exclusion report. It is an audit trail, not a data channel: a
 * model that returned hundreds of entries has misunderstood the task, and the
 * cap keeps one bad response from writing an unbounded blob onto an entry.
 */
const MAX_EXCLUSIONS = 40;
const MAX_EXCLUSION_TEXT = 200;

function buildPrompt(note: string | null, photoCount: number): string {
  return `<entry>
<photo_count>${photoCount}</photo_count>
${note ? `<note>\n${note}\n</note>` : '<note>(none)</note>'}
</entry>`;
}

/**
 * Server-side portion modifier: explicit multiplier words in the note
 * (e.g. "double", "half") scale the model's base estimate. The model
 * already reads the note for descriptive portion size ("a large bowl of…"),
 * so this only fires on standalone multiplier tokens to avoid double-counting.
 */
const PORTION_MODIFIERS: Array<{ pattern: RegExp; factor: number }> = [
  { pattern: /\bdouble\b|\b2x\b|\bx2\b/i, factor: 2 },
  { pattern: /\btriple\b|\b3x\b|\bx3\b/i, factor: 3 },
  { pattern: /\bhalf\b|\b1\/2\b/i, factor: 0.5 },
  { pattern: /\bquarter\b|\b1\/4\b/i, factor: 0.25 },
];

export function portionModifierFor(note: string | null): number {
  if (!note) return 1;
  for (const { pattern, factor } of PORTION_MODIFIERS) {
    if (pattern.test(note)) return factor;
  }
  return 1;
}

export function applyPortionModifier(estimate: ModelEstimate, factor: number): ModelEstimate {
  if (factor === 1) return estimate;
  const scale = (n: number | null) => (n === null ? null : Math.round(n * factor * 10) / 10);
  return {
    // `confidence`, `portion_basis`, and `excluded` are deliberately unscaled:
    // eating half the order does not halve which lines were charges.
    ...estimate,
    calories: scale(estimate.calories),
    protein_g: scale(estimate.protein_g),
    fat_g: scale(estimate.fat_g),
    sat_fat_g: scale(estimate.sat_fat_g),
    carbs_g: scale(estimate.carbs_g),
    sugar_g: scale(estimate.sugar_g),
    added_sugar_g: scale(estimate.added_sugar_g),
    fiber_g: scale(estimate.fiber_g),
    sodium_mg: scale(estimate.sodium_mg),
  };
}
