import { describe, expect, it } from 'bun:test';
import { applyPortionModifier, portionModifierFor } from './estimator.js';
import type { ModelEstimate } from '../types.js';

function mkEstimate(over: Partial<ModelEstimate> = {}): ModelEstimate {
  return {
    label: 'Chicken salad',
    calories: 400,
    protein_g: 30,
    fat_g: 20,
    sat_fat_g: 5,
    carbs_g: 10,
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
