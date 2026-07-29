/**
 * The `nutrition_negligible` sodium guard
 * (specs/modules/kitchen.md § Nutritionally negligible products — § Sodium is
 * the exception that breaks the marker).
 *
 * The marker asserts that EVERY panel field is ~0 at any realistic serving. Its
 * justification is that the error stays bounded by the category: a teaspoon of a
 * dried spice is single-digit calories however wrong the zeros are. Sodium is
 * where that reasoning fails, and it fails in the one direction the module
 * tracks a ceiling in. Table salt is ~0 on eight of the nine fields and
 * ~38,700 mg/100 g on the ninth — a gram is ~390 mg (about 17% of a 2,300 mg
 * ceiling), a teaspoon is essentially the whole day. A salt product marked
 * negligible asserts zero sodium while being the largest sodium contributor in
 * the house.
 *
 * What makes this worth code rather than prose: the qualifying intuition ("it's
 * a seasoning, you use a pinch") is TRUE and the conclusion is still wrong, so a
 * careful reader talking themselves through the rule arrives at the wrong
 * answer. The discriminating pair is garlic powder (~60 mg/100 g — qualifies)
 * versus garlic salt (~26,000 mg/100 g — does not). They are adjacent on a shelf
 * and identical to a name filter.
 *
 * The guard is a REFUSAL WITH AN OVERRIDE, never a silent correction. A caller
 * who means it (flaked sea salt bought purely as a finishing garnish, whose
 * realistic contribution really is a few crystals) states
 * `nutrition_negligible_override: true` and is obeyed. That shape is what makes
 * the guard affordable: a false positive costs one extra flag, while a false
 * negative is a wrong number on a tracked ceiling that nothing downstream flags.
 */

import type { NutritionPer100g } from './inventory-types.js';

/**
 * The per-100 g sodium ceiling a negligible product may claim, in mg.
 *
 * Chosen with room on both sides rather than tuned to a line. Real spices and
 * dried herbs sit far below it — garlic powder ~60, black pepper ~20, paprika
 * ~68, onion powder ~73, celery seed ~160, and even a salt-bearing chili powder
 * blend lands under ~1,700. Everything the marker gets wrong sits far above it:
 * table salt ~38,700, garlic and celery salt ~26,000, baking soda ~27,400,
 * bouillon powder ~24,000, MSG ~12,300, baking powder ~10,000, soy sauce
 * ~5,500. At the ceiling itself a generous 10 g serving contributes 200 mg —
 * under 9% of a 2,300 mg day, which is the "bounded by the category" claim the
 * marker rests on. Above it the claim is simply false.
 */
export const NEGLIGIBLE_SODIUM_MAX_PER_100G = 2_000;

/**
 * The per-serving sodium ceiling used when a label states sodium per serving and
 * no serving size, so per-100 g cannot be derived. 100 mg is ~4% of a 2,300 mg
 * day — the most a product can contribute per use and still be honestly
 * describable as zero.
 */
export const NEGLIGIBLE_SODIUM_MAX_PER_SERVING = 100;

/** Why the guard refused. Stable codes so callers and tests don't match on prose. */
export type NegligibleRefusalCode = 'sodium_known' | 'ingredients_salt' | 'name_salt';

export interface NegligibleRefusal {
  code: NegligibleRefusalCode;
  /** The specific evidence, quoted, so the message names the thing that fired. */
  evidence: string;
}

/**
 * The product facts the guard reads. Deliberately structural rather than a
 * `ProductRecord`: every door (create, explicit-ulid replace, name-key enrich,
 * patch) composes the record it is ABOUT TO WRITE and hands that over, so the
 * guard judges the resulting product rather than whichever half the request
 * happened to state.
 */
export interface NegligibleCandidate {
  name: string;
  aliases?: string[] | null;
  ingredients?: string | null;
  nutrition_per_100g?: Partial<NutritionPer100g> | null;
  nutrition_per_serving?: Partial<NutritionPer100g> | null;
  serving_size_g?: number | null;
}

/**
 * Phrases that make a "salt" mention a DENIAL of salt rather than a declaration
 * of it. `salt-free`, `no salt added`, and a potassium-chloride salt substitute
 * are the legitimately-negligible members of the shelf the name rule sweeps, and
 * they read identically to a substring match. ("unsalted" needs no entry — the
 * word-boundary match never fires inside it.)
 */
const SALT_NEGATIONS: readonly RegExp[] = [
  /\bsalt[\s-]*free\b/i,
  /\bsaltless\b/i,
  /\bno[\s-]+salt\b/i,
  /\bwithout\s+salt\b/i,
  /\bsalt\s+substitute\b/i,
];

/**
 * Salt-forward products whose names never say "salt". Each is a case where
 * sodium is the dominant term at a realistic pinch: bouillon and MSG are
 * seasoning powders, the leavening agents are literally sodium salts (baking
 * soda ~27,400 mg/100 g, baking powder ~10,000), and the two sauces are the
 * condiments most likely to be waved through next to vinegar — a tablespoon of
 * soy sauce is ~900 mg.
 *
 * The list is short on purpose. It is not trying to enumerate every salty food;
 * it covers the products a reasonable person WOULD mark negligible, which is a
 * much smaller set than "things containing sodium".
 */
const SALT_FORWARD_TERMS: readonly RegExp[] = [
  /\bsalt(s|ed)?\b/i,
  /\bbouillon\b/i,
  /\bmsg\b/i,
  /\bmonosodium\s+glutamate\b/i,
  /\bbaking\s+soda\b/i,
  /\bbaking\s+powder\b/i,
  /\b(sodium\s+)?bicarbonate(\s+of\s+soda)?\b/i,
  /\bsoy\s+sauce\b/i,
  /\bfish\s+sauce\b/i,
];

/** Salt under its label name, for an ingredients list that spells it out. */
const INGREDIENT_SALT_TERMS: readonly RegExp[] = [/\bsalt(s|ed)?\b/i, /\bsodium\s+chloride\b/i];

/**
 * Decide whether `candidate` may be marked `nutrition_negligible`. Null means
 * yes; a refusal names the code and the evidence so the caller's error message
 * can quote what fired.
 *
 * Three tiers in DESCENDING order of evidence strength, so the reported reason
 * is the best one available:
 *
 * 1. **Known sodium** — a number someone actually read off a label. Precise and
 *    false-positive-free, but rarely present: the category the marker exists for
 *    is exactly the category with no panel to read.
 * 2. **The ingredients list** — the owner transcribed "salt" or "sodium
 *    chloride". Catches the commercial blend whose NAME says nothing ("poultry
 *    seasoning" listing salt first), which is the case a name filter cannot see.
 * 3. **The name and its aliases** — the cheap heuristic, and the only tier that
 *    fires on the bare spice jar with no panel and no transcribed ingredients.
 *    That is the case the whole guard is for, so the weakest evidence is the one
 *    that does the most work; the override is what makes that acceptable.
 *
 * **No tier grants permission — each only refuses.** A stated sodium under the
 * ceiling does not excuse a salt-shaped name, because a product that carries a
 * readable panel never needed the marker in the first place: `needs_nutrition`
 * is satisfiable by scanning it. Refusing there costs nothing, while letting a
 * low number vouch for a salt product would hand the guard's whole job to
 * whichever transcription happened to land first.
 */
export function checkNegligible(candidate: NegligibleCandidate): NegligibleRefusal | null {
  const sodium = knownSodium(candidate);
  if (sodium) return sodium;

  const ingredients = candidate.ingredients ?? '';
  if (ingredients && !isNegated(ingredients) && matchAny(ingredients, INGREDIENT_SALT_TERMS)) {
    return { code: 'ingredients_salt', evidence: `ingredients list "${truncate(ingredients)}"` };
  }

  for (const text of [candidate.name, ...(candidate.aliases ?? [])]) {
    if (!text || isNegated(text)) continue;
    if (matchAny(text, SALT_FORWARD_TERMS)) {
      return { code: 'name_salt', evidence: `name "${truncate(text)}"` };
    }
  }

  return null;
}

/**
 * The refusal rendered as the message a `400` carries. It states the evidence,
 * the rule, and the exact way to proceed anyway — a guard that refuses without
 * naming its override is a dead end.
 */
export function negligibleRefusalMessage(name: string, refusal: NegligibleRefusal): string {
  return (
    `Refusing to mark "${name}" nutrition_negligible: its ${refusal.evidence} says it carries salt. ` +
    'The marker asserts every panel field is ~0 at any realistic serving INCLUDING sodium, and salt ' +
    `breaks that on sodium alone (~38,700 mg/100 g — a teaspoon is a whole day's ceiling). ` +
    'Garlic powder qualifies; garlic salt does not. ' +
    'If a realistic serving of this really contributes ~0 sodium, state ' +
    'nutrition_negligible_override: true and the marker is applied as asked.'
  );
}

/**
 * Sodium the product is already known to carry, normalized to per-100 g where
 * that is possible. A per-serving figure with no serving size cannot be
 * normalized, so it is judged against the per-serving ceiling directly rather
 * than being thrown away. Either panel may fire — the per-100 g figure is
 * preferred when both are stated, since it is the denominator the ceiling is
 * defined in.
 */
function knownSodium(candidate: NegligibleCandidate): NegligibleRefusal | null {
  const per100g = finite(candidate.nutrition_per_100g?.sodium_mg);
  if (per100g !== null && per100g > NEGLIGIBLE_SODIUM_MAX_PER_100G) {
    return {
      code: 'sodium_known',
      evidence: `stated ${per100g} mg sodium per 100 g (over the ${NEGLIGIBLE_SODIUM_MAX_PER_100G} mg negligible ceiling)`,
    };
  }
  if (per100g !== null) return null;

  const perServing = finite(candidate.nutrition_per_serving?.sodium_mg);
  if (perServing === null) return null;

  const servingG = finite(candidate.serving_size_g);
  if (servingG !== null && servingG > 0) {
    const scaled = (perServing * 100) / servingG;
    return scaled > NEGLIGIBLE_SODIUM_MAX_PER_100G
      ? {
          code: 'sodium_known',
          evidence: `stated ${perServing} mg sodium per ${servingG} g serving (${Math.round(scaled)} mg/100 g, over the ${NEGLIGIBLE_SODIUM_MAX_PER_100G} mg negligible ceiling)`,
        }
      : null;
  }

  return perServing > NEGLIGIBLE_SODIUM_MAX_PER_SERVING
    ? {
        code: 'sodium_known',
        evidence: `stated ${perServing} mg sodium per serving (over the ${NEGLIGIBLE_SODIUM_MAX_PER_SERVING} mg negligible ceiling)`,
      }
    : null;
}

function isNegated(text: string): boolean {
  return SALT_NEGATIONS.some((re) => re.test(text));
}

function matchAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function truncate(text: string, max = 80): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
