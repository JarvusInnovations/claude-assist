/**
 * The panel-basis guard (specs/modules/kitchen.md § Nutrition panel §
 * A panel means nothing without its basis). Every product named here is a
 * generic food category, never a brand.
 */

import { describe, expect, it } from 'bun:test';
import {
  PANEL_BASIS_TOLERANCE_FLOOR,
  PANEL_BASIS_TOLERANCE_PCT,
  panelBasisRefusalMessage,
  resolvePanelBasis,
  sweepPanelBasisInconsistencies,
  type PanelBasisSweepCandidate,
} from './panel-basis-guard.js';

describe('resolvePanelBasis — no serving basis at all', () => {
  it('honors a caller-stated per-100g verbatim when nothing is derivable', () => {
    const resolved = resolvePanelBasis({ nutrition_per_100g: { calories: 89, sodium_mg: 1 } });
    expect(resolved.contradictions).toEqual([]);
    expect(resolved.nutrition_per_100g).toEqual({ calories: 89, sodium_mg: 1 });
  });

  it('a bare serving_size_g with no per-serving panel is still underivable', () => {
    const resolved = resolvePanelBasis({ nutrition_per_100g: { calories: 89 }, serving_size_g: 30 });
    expect(resolved.contradictions).toEqual([]);
    expect(resolved.nutrition_per_100g).toEqual({ calories: 89 });
  });

  it('nothing stated at all resolves to null, not an empty object mistaken for a real panel', () => {
    expect(resolvePanelBasis({}).nutrition_per_100g).toBeNull();
  });
});

describe('resolvePanelBasis — a serving basis exists', () => {
  const perServing = { calories: 60, protein_g: 2, fat_g: 1, sodium_mg: 45 };
  const servingSizeG = 50; // factor x2

  it('derives per-100g when nothing was stated', () => {
    const resolved = resolvePanelBasis({ nutrition_per_serving: perServing, serving_size_g: servingSizeG });
    expect(resolved.contradictions).toEqual([]);
    expect(resolved.nutrition_per_100g).toMatchObject({ calories: 120, protein_g: 4, fat_g: 2, sodium_mg: 90 });
  });

  it('ignores an AGREEING stated per-100g and uses the derived value (same number, but derived, not merely accepted)', () => {
    const resolved = resolvePanelBasis({
      nutrition_per_serving: perServing,
      serving_size_g: servingSizeG,
      nutrition_per_100g: { calories: 120, protein_g: 4, fat_g: 2, sodium_mg: 90 },
    });
    expect(resolved.contradictions).toEqual([]);
    expect(resolved.nutrition_per_100g).toMatchObject({ calories: 120, protein_g: 4, fat_g: 2, sodium_mg: 90 });
  });

  it('refuses a stated per-100g that CONTRADICTS the derived value, naming the field and both numbers', () => {
    const resolved = resolvePanelBasis({
      nutrition_per_serving: perServing,
      serving_size_g: servingSizeG,
      nutrition_per_100g: { calories: 260, protein_g: 4, fat_g: 2, sodium_mg: 90 }, // derived calories is 120
    });
    expect(resolved.contradictions).toHaveLength(1);
    expect(resolved.contradictions[0]).toMatchObject({ field: 'calories', stated: 260, derived: 120 });
    expect(resolved.nutrition_per_100g).toBeNull();
  });

  it('reports every contradicting field, not just the first', () => {
    const resolved = resolvePanelBasis({
      nutrition_per_serving: perServing,
      serving_size_g: servingSizeG,
      nutrition_per_100g: { calories: 260, protein_g: 40, fat_g: 2, sodium_mg: 90 },
    });
    const fields = resolved.contradictions.map((c) => c.field).sort();
    expect(fields).toEqual(['calories', 'protein_g']);
  });

  it('fills a field the derivation could not reach (per-serving omitted it) from the stated value — no contradiction possible with nothing to compare against', () => {
    const resolved = resolvePanelBasis({
      nutrition_per_serving: { calories: 60, sodium_mg: null }, // sodium genuinely unread
      serving_size_g: servingSizeG,
      nutrition_per_100g: { sodium_mg: 500 },
    });
    expect(resolved.contradictions).toEqual([]);
    expect(resolved.nutrition_per_100g).toMatchObject({ calories: 120, sodium_mg: 500 });
  });
});

describe('resolvePanelBasis — the tolerance is calibrated, not chosen', () => {
  const servingSizeG = 50;

  it('permits a stated value within the 8% + 0.6 band (rounding noise) and STORES THE DERIVED VALUE, not the stated one', () => {
    // derived sat_fat_g = 0.5; 8% of 0.5 + 0.6 = 0.64. 1.1 is within tolerance,
    // but it is not what gets written — the resolved panel is the DERIVED
    // number even when a within-tolerance stated one was supplied, because the
    // rule is "derived wins, ignored not merged," not "close enough passes
    // through."
    const resolved = resolvePanelBasis({
      nutrition_per_serving: { sat_fat_g: 0.25 },
      serving_size_g: servingSizeG,
      nutrition_per_100g: { sat_fat_g: 1.1 },
    });
    expect(resolved.contradictions).toEqual([]);
    expect(resolved.nutrition_per_100g?.sat_fat_g).toBe(0.5);
  });

  it('refuses just past the tolerance band', () => {
    // derived sat_fat_g = 0.5; tolerance ceiling is 0.5 + 0.64 = 1.14.
    const resolved = resolvePanelBasis({
      nutrition_per_serving: { sat_fat_g: 0.25 },
      serving_size_g: servingSizeG,
      nutrition_per_100g: { sat_fat_g: 1.2 },
    });
    expect(resolved.contradictions).toHaveLength(1);
  });

  it('the absolute floor matters at small magnitudes — a purely-percentage check would false-positive here', () => {
    // derived = 0.4; a pure 8% band is +/-0.032, which 0.5 would fail. The 0.6
    // floor is what makes this the honest "rounds hard at small magnitudes" case.
    const resolved = resolvePanelBasis({
      nutrition_per_serving: { sat_fat_g: 0.2 },
      serving_size_g: servingSizeG,
      nutrition_per_100g: { sat_fat_g: 0.5 },
    });
    expect(resolved.contradictions).toEqual([]);
  });

  it('exposes its constants for the message and for calibration review', () => {
    expect(PANEL_BASIS_TOLERANCE_PCT).toBe(0.08);
    expect(PANEL_BASIS_TOLERANCE_FLOOR).toBe(0.6);
  });
});

describe('panelBasisRefusalMessage', () => {
  it('names the food, the contradicting field, and both values', () => {
    const resolved = resolvePanelBasis({
      nutrition_per_serving: { calories: 60 },
      serving_size_g: 50,
      nutrition_per_100g: { calories: 260 },
    });
    const message = panelBasisRefusalMessage('A snack bar', resolved.contradictions);
    expect(message).toContain('A snack bar');
    expect(message).toContain('calories');
    expect(message).toContain('260');
    expect(message).toContain('120');
  });
});

/**
 * The legacy sweep, calibrated against a fixture shaped like the real corpus
 * this guard was built against: 18 products carrying both representations,
 * of which exactly 2 had silently disagreed (§ A panel means nothing without
 * its basis — "calories was wrong in both; one product under-reported its own
 * energy by a third"). Every name here is a generic category.
 */
describe('sweepPanelBasisInconsistencies — flags exactly the known-bad rows', () => {
  function soundProduct(ulid: string, name: string, perServing: Record<string, number>, servingSizeG: number): PanelBasisSweepCandidate {
    const factor = 100 / servingSizeG;
    const per100g: Record<string, number> = {};
    for (const [k, v] of Object.entries(perServing)) per100g[k] = Math.round(v * factor * 10) / 10;
    return { ulid, name, nutrition_per_serving: perServing, serving_size_g: servingSizeG, nutrition_per_100g: per100g };
  }

  // Sixteen correctly-scaled rows spanning a range of serving sizes and food
  // categories — every field agrees with its derived value exactly.
  const soundFixture: PanelBasisSweepCandidate[] = [
    soundProduct('01', 'Rolled Oats', { calories: 150, protein_g: 5, fat_g: 3, carbs_g: 27, sodium_mg: 0 }, 40),
    soundProduct('02', 'Canned Black Beans', { calories: 110, protein_g: 7, fat_g: 0.5, carbs_g: 19, sodium_mg: 360 }, 130),
    soundProduct('03', 'Whole Milk', { calories: 149, protein_g: 8, fat_g: 8, carbs_g: 12, sodium_mg: 105 }, 244),
    soundProduct('04', 'Plain Yogurt', { calories: 100, protein_g: 9, fat_g: 5, carbs_g: 7, sodium_mg: 65 }, 170),
    soundProduct('05', 'A snack bar', { calories: 190, protein_g: 6, fat_g: 8, carbs_g: 24, sodium_mg: 95 }, 40),
    soundProduct('06', 'A boxed side dish', { calories: 220, protein_g: 5, fat_g: 3, carbs_g: 45, sodium_mg: 480 }, 70),
    soundProduct('07', 'Cheddar Cheese', { calories: 110, protein_g: 7, fat_g: 9, carbs_g: 1, sodium_mg: 180 }, 28),
    soundProduct('08', 'A fruit spread', { calories: 50, protein_g: 0, fat_g: 0, carbs_g: 13, sodium_mg: 0 }, 20),
    soundProduct('09', 'A dried-fruit mix', { calories: 130, protein_g: 1, fat_g: 0, carbs_g: 32, sodium_mg: 5 }, 40),
    soundProduct('10', 'A cereal box', { calories: 120, protein_g: 2, fat_g: 1, carbs_g: 25, sodium_mg: 210 }, 30),
    soundProduct('11', 'A jar of sauce', { calories: 70, protein_g: 2, fat_g: 3, carbs_g: 9, sodium_mg: 480 }, 125),
    soundProduct('12', 'A trail mix', { calories: 140, protein_g: 4, fat_g: 9, carbs_g: 12, sodium_mg: 55 }, 30),
    soundProduct('13', 'A yogurt cup', { calories: 90, protein_g: 15, fat_g: 0, carbs_g: 6, sodium_mg: 55 }, 150),
    soundProduct('14', 'Sparkling Water', { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0, sodium_mg: 10 }, 355),
    soundProduct('15', 'A partial-panel item', { calories: 210, protein_g: 8, fat_g: 10, carbs_g: 22, sodium_mg: 340 }, 55),
    soundProduct('16', 'A link pack', { calories: 250, protein_g: 12, fat_g: 21, carbs_g: 2, sodium_mg: 520 }, 65),
  ];

  // Two rows that "silently disagreed" — most fields scaled correctly, but one
  // or two were substituted with a plausible-for-the-category round number
  // instead of computed. Calories wrong in both, one under-reporting energy by
  // roughly a third, exactly as the observed failure describes.
  const badRow1: PanelBasisSweepCandidate = {
    ulid: '17',
    name: 'A granola bar (mis-scaled)',
    serving_size_g: 40,
    nutrition_per_serving: { calories: 160, protein_g: 3, fat_g: 6, carbs_g: 24, sodium_mg: 95 },
    // Correctly-scaled would be calories 400; someone recalled "a granola bar
    // is about 130 per 100g" instead of computing it.
    nutrition_per_100g: { calories: 130, protein_g: 7.5, fat_g: 15, carbs_g: 60, sodium_mg: 238 },
  };
  const badRow2: PanelBasisSweepCandidate = {
    ulid: '18',
    name: 'A frozen entree (mis-scaled)',
    serving_size_g: 280,
    nutrition_per_serving: { calories: 420, protein_g: 22, fat_g: 14, carbs_g: 48, sodium_mg: 740 },
    // Correctly-scaled calories would be 150; a plausible-looking round number
    // for the category landed instead — the third-under-reported case.
    nutrition_per_100g: { calories: 100, protein_g: 7.9, fat_g: 5, carbs_g: 17.1, sodium_mg: 264.3 },
  };

  const fixture = [...soundFixture, badRow1, badRow2];

  it('flags exactly the two known-bad rows and none of the sixteen sound ones', () => {
    const findings = sweepPanelBasisInconsistencies(fixture);
    const flaggedUlids = findings.map((f) => f.ulid).sort();
    expect(flaggedUlids).toEqual(['17', '18']);
  });

  it('each finding names the disagreeing field(s), including calories in both', () => {
    const findings = sweepPanelBasisInconsistencies(fixture);
    for (const finding of findings) {
      expect(finding.contradictions.some((c) => c.field === 'calories')).toBe(true);
    }
  });

  it('never mutates or rewrites anything — the sweep only reports', () => {
    const before = JSON.parse(JSON.stringify(fixture));
    sweepPanelBasisInconsistencies(fixture);
    expect(fixture).toEqual(before);
  });
});
