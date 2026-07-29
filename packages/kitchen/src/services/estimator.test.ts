import { describe, expect, it } from 'bun:test';
import { applyPortionModifier, portionModifierFor, SYSTEM_PROMPT } from './estimator.js';
import type { ModelEstimate } from '../types.js';

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
