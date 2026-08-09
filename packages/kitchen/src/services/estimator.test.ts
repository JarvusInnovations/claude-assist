import { describe, expect, it } from 'bun:test';
import { applyPortionModifier, parseEstimateResponse, portionModifierFor, SYSTEM_PROMPT } from './estimator.js';
import type { ModelEstimate } from '../types.js';

/**
 * The `<estimate>` block's CONTENTS — what the invoker hands `parse` after it
 * has extracted the tag.
 */
function respond(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function mkEstimate(over: Partial<ModelEstimate> = {}): ModelEstimate {
  return {
    label: 'Chicken salad',
    calories: 400,
    protein_g: 30,
    fat_g: 20,
    sat_fat_g: 5,
    carbs_g: 10,
    sugar_g: 5,
    added_sugar_g: 0,
    fiber_g: 3,
    sodium_mg: 600,
    confidence: 0.6,
    portion_basis: 'one bowl',
    excluded: [],
    ...over,
  };
}

describe('portionModifierFor', () => {
  it('defaults to 1x with no note', () => {
    expect(portionModifierFor(null)).toBe(1);
    expect(portionModifierFor('')).toBe(1);
  });

  it('detects explicit multiplier words', () => {
    expect(portionModifierFor('had a double portion')).toBe(2);
    expect(portionModifierFor('ate a triple serving')).toBe(3);
    expect(portionModifierFor('just half of it')).toBe(0.5);
    expect(portionModifierFor('a quarter of the pan')).toBe(0.25);
  });

  it('does not fire on descriptive size words the model already reads', () => {
    expect(portionModifierFor('a large bowl of pasta')).toBe(1);
    expect(portionModifierFor('small snack')).toBe(1);
  });
});

describe('applyPortionModifier', () => {
  it('is a no-op at factor 1', () => {
    const estimate = mkEstimate();
    expect(applyPortionModifier(estimate, 1)).toEqual(estimate);
  });

  it('scales every macro field by the factor', () => {
    const doubled = applyPortionModifier(mkEstimate(), 2);
    expect(doubled.calories).toBe(800);
    expect(doubled.protein_g).toBe(60);
    expect(doubled.sat_fat_g).toBe(10);
    expect(doubled.label).toBe('Chicken salad'); // label/confidence/portion_basis untouched
    expect(doubled.confidence).toBe(0.6);
  });

  it('preserves nulls rather than scaling them into 0', () => {
    const scaled = applyPortionModifier(mkEstimate({ sodium_mg: null }), 2);
    expect(scaled.sodium_mg).toBeNull();
  });
});

describe('SYSTEM_PROMPT embedded-text precedence (claude-assist#92)', () => {
  it('instructs the estimator to trust printed text over visual inference', () => {
    expect(SYSTEM_PROMPT).toMatch(/AUTHORITATIVE/);
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('order sticker');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('menu board');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('nutrition panel');
  });

  it('ties corroborating text to a confidence bump, not just identity', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('raise your confidence');
  });

  it('still instructs a best-guess fallback for photos with no legible text', () => {
    // A photo with no text must behave as before — the model still returns
    // its best visual guess rather than refusing.
    expect(SYSTEM_PROMPT).toContain('never refuse');
  });
});

describe('SYSTEM_PROMPT added-sugar attribution (§ Filling `added_sugar_g`)', () => {
  it('enumerates added_sugar_g in the panel it asks for and in the output shape', () => {
    expect(SYSTEM_PROMPT).toContain('added_sugar_g');
    // The response template must show the field, or a model that skims the
    // instructions still returns an eight-key macros object.
    expect(SYSTEM_PROMPT).toMatch(/"macros":[^\n]*"added_sugar_g"/);
  });

  it('makes a label authoritative for it', () => {
    expect(SYSTEM_PROMPT).toContain('Includes Xg Added Sugars');
  });

  it('demands 0 rather than null for unprocessed whole foods — both words, explicitly', () => {
    // This is the load-bearing instruction: a null on a whole food silently
    // deletes part of the day's total.
    expect(SYSTEM_PROMPT).toMatch(/BY DEFINITION, NOT null/);
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('plain yogurt');
  });

  it('asks for a reasoned estimate on prepared dishes instead of null', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('reasoned');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('visible sweeteners');
    // Lower confidence there is the intended outcome, not a defect.
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('lower-confidence');
  });

  it('counts juice as added sugar (WHO free sugars) and caps added by total', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('juice counts as added');
    expect(SYSTEM_PROMPT).toContain('never exceed sugar_g');
  });
});

describe('SYSTEM_PROMPT non-food billing lines (§ Billing artifacts are not ingredients)', () => {
  it('names the money lines a receipt or order prints beside the food', () => {
    const prompt = SYSTEM_PROMPT.toLowerCase();
    for (const line of [
      'delivery fee',
      'service fee',
      'small order fee',
      'bag fee',
      'sales tax',
      'tip/gratuity',
      'bottle deposit',
      'rounding',
    ]) {
      expect(prompt).toContain(line);
    }
  });

  it('forbids estimating them rather than merely discouraging it', () => {
    expect(SYSTEM_PROMPT).toContain('BILLING LINES ARE NOT FOOD');
    expect(SYSTEM_PROMPT).toContain('NEVER estimate nutrition for one');
  });

  it('states that a negative money line is not negative food', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('is not negative food');
    expect(SYSTEM_PROMPT).toContain('No macro is ever negative');
  });

  it('keeps an unknown FOOD line separate from a charge — the two must not collapse', () => {
    // The distinction that makes the rule safe: "I can't tell what food this
    // is" is not "this is definitely not food".
    expect(SYSTEM_PROMPT).toContain('UNKNOWN FOOD');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('misc grocery');
    expect(SYSTEM_PROMPT).toContain('must not collapse into one bucket');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('when you are unsure which a line is, treat it as food');
  });

  it('asks for the exclusions to be REPORTED, in the response template', () => {
    expect(SYSTEM_PROMPT).toMatch(/"excluded":\s*\[\{"text"/);
    expect(SYSTEM_PROMPT).toContain('fee, tax, tip, deposit, discount, adjustment, other');
  });
});

describe('parseEstimateResponse — the exclusion report', () => {
  const base = {
    label: 'Delivery order',
    calories: 900,
    macros: { protein_g: 40, sodium_mg: 1800 },
    confidence: 0.5,
    portion_basis: 'one order',
  };

  it('carries the reported exclusions through verbatim', () => {
    const estimate = parseEstimateResponse(
      respond({
        ...base,
        excluded: [
          { text: 'DELIVERY FEE', kind: 'fee' },
          { text: 'SALES TAX', kind: 'tax' },
          { text: 'DRIVER TIP', kind: 'tip' },
        ],
      })
    );
    expect(estimate.excluded).toEqual([
      { text: 'DELIVERY FEE', kind: 'fee' },
      { text: 'SALES TAX', kind: 'tax' },
      { text: 'DRIVER TIP', kind: 'tip' },
    ]);
    // The food still got estimated — excluding the charges is not skipping the meal.
    expect(estimate.calories).toBe(900);
  });

  it('defaults to an empty array, so "nothing excluded" is never undefined', () => {
    expect(parseEstimateResponse(respond(base)).excluded).toEqual([]);
    expect(parseEstimateResponse(respond({ ...base, excluded: 'nope' })).excluded).toEqual([]);
  });

  it('files an unrecognized kind as `other` rather than dropping the exclusion', () => {
    const estimate = parseEstimateResponse(
      respond({ ...base, excluded: [{ text: 'SMALL ORDER FEE', kind: 'surcharge' }, 'BAG FEE'] })
    );
    expect(estimate.excluded).toEqual([
      { text: 'SMALL ORDER FEE', kind: 'other' },
      { text: 'BAG FEE', kind: 'other' },
    ]);
  });

  it('drops textless entries and bounds the report', () => {
    const estimate = parseEstimateResponse(
      respond({
        ...base,
        excluded: [{ kind: 'fee' }, { text: '   ', kind: 'fee' }, 42, null, { text: 'TIP', kind: 'tip' }],
      })
    );
    expect(estimate.excluded).toEqual([{ text: 'TIP', kind: 'tip' }]);

    const flooded = parseEstimateResponse(
      respond({ ...base, excluded: Array.from({ length: 200 }, (_, i) => ({ text: `FEE ${i}`, kind: 'fee' })) })
    );
    expect(flooded.excluded).toHaveLength(40);
    expect(
      parseEstimateResponse(respond({ ...base, excluded: [{ text: 'X'.repeat(500), kind: 'fee' }] })).excluded[0]!.text
    ).toHaveLength(200);
  });
});

describe('parseEstimateResponse — a negative money line never becomes negative nutrition', () => {
  it('reads a negative panel field as unknown, not as a subtraction', () => {
    // The failure this closes: a discount or deposit-return line leaking into
    // the arithmetic and making a day read as LESS eaten than it was — an error
    // in the direction nobody questions.
    const estimate = parseEstimateResponse(
      respond({
        label: 'Order with promo credit',
        calories: -300,
        macros: { protein_g: 20, fat_g: -5, sodium_mg: -120, carbs_g: 0 },
        confidence: 0.4,
        portion_basis: 'one order',
        excluded: [{ text: 'PROMO -$3.00', kind: 'discount' }],
      })
    );
    expect(estimate.calories).toBeNull();
    expect(estimate.fat_g).toBeNull();
    expect(estimate.sodium_mg).toBeNull();
    // Legitimate values are untouched, and 0 still means zero.
    expect(estimate.protein_g).toBe(20);
    expect(estimate.carbs_g).toBe(0);
    expect(estimate.excluded).toEqual([{ text: 'PROMO -$3.00', kind: 'discount' }]);
  });

  it('never scales the exclusion report with the portion modifier', () => {
    const halved = applyPortionModifier(mkEstimate({ excluded: [{ text: 'SERVICE FEE', kind: 'fee' }] }), 0.5);
    expect(halved.excluded).toEqual([{ text: 'SERVICE FEE', kind: 'fee' }]);
    expect(halved.calories).toBe(200);
  });
});
