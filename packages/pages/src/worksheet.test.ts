import { describe, expect, it } from 'bun:test';
import {
  WORKSHEET_MAX_QUANTITY,
  WorksheetValidationError,
  computeWorksheetTotals,
  isWorksheetPayload,
  normalizeWorksheetResponse,
  renderWorksheetHtml,
  summarizeWorksheet,
  validateWorksheetDefinition,
  validateWorksheetSubmission,
  type WorksheetDefinition,
} from './worksheet.js';

/**
 * A prep worksheet for a grain bowl. Synthetic per-basis numbers chosen so the
 * expected totals are checkable by hand (see the fixture test below).
 */
function grainBowlDefinition(overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: 'worksheet',
    version: 1,
    heading: 'Prep — grain bowl',
    intro: 'Weigh each component, then submit the actual numbers.',
    basis: 100,
    unit: 'g',
    fields: [
      { key: 'calories', label: 'Calories', precision: 0 },
      { key: 'protein_g', label: 'Protein', unit: 'g', precision: 1 },
      { key: 'fiber_g', label: 'Fiber', unit: 'g', precision: 1 },
    ],
    components: [
      { label: 'cooked grain', quantity: 200, per_basis: { calories: 130, protein_g: 4.5 } },
      { label: 'roast vegetable', quantity: 150, per_basis: { calories: 60, protein_g: 2, fiber_g: 3 } },
      { label: 'dressing', quantity: 30, per_basis: { calories: 400, protein_g: 0 } },
    ],
    steps: ['Roast at 425 °F for 25 min — until edges char.', 'Toss ≈ 2 × with dressing.'],
    ...overrides,
  };
}

const SUBMISSION_KEY = '01JAAAAAAAAAAAAAAAAAAAAAAA';

describe('validateWorksheetDefinition', () => {
  it('accepts a well-formed definition and fills in defaults', () => {
    const definition = validateWorksheetDefinition(grainBowlDefinition());

    expect(definition.basis).toBe(100);
    expect(definition.unit).toBe('g');
    expect(definition.fields[0]).toMatchObject({ key: 'calories', precision: 0 });
    // An unspecified precision defaults to 1 decimal, not "whatever JS prints".
    expect(definition.fields[1]!.precision).toBe(1);
    expect(definition.components).toHaveLength(3);
  });

  it.each([
    ['a non-object', 42],
    ['the wrong kind', grainBowlDefinition({ kind: 'form' })],
    ['a future version', grainBowlDefinition({ version: 2 })],
    ['no fields', grainBowlDefinition({ fields: [] })],
    ['no components', grainBowlDefinition({ components: [] })],
    ['a non-identifier field key', grainBowlDefinition({ fields: [{ key: 'Total Cals', label: 'x' }] })],
    ['a zero basis', grainBowlDefinition({ basis: 0 })],
    ['an out-of-range precision', grainBowlDefinition({ fields: [{ key: 'a', label: 'A', precision: 9 }] })],
    ['an unknown top-level key', grainBowlDefinition({ colour: 'red' })],
    [
      'a per_basis key that is not a declared field',
      grainBowlDefinition({
        components: [{ label: 'x', quantity: 1, per_basis: { sodium_mg: 3 } }],
      }),
    ],
    [
      'duplicate component labels',
      grainBowlDefinition({
        components: [
          { label: 'oats', quantity: 1, per_basis: { calories: 1 } },
          { label: 'oats', quantity: 2, per_basis: { calories: 1 } },
        ],
      }),
    ],
    [
      'a negative quantity',
      grainBowlDefinition({ components: [{ label: 'x', quantity: -1, per_basis: { calories: 1 } }] }),
    ],
    [
      'a non-numeric per_basis value',
      grainBowlDefinition({
        components: [{ label: 'x', quantity: 1, per_basis: { calories: 'lots' } }],
      }),
    ],
  ])('rejects %s', (_label, raw) => {
    expect(() => validateWorksheetDefinition(raw)).toThrow(WorksheetValidationError);
  });

  it('names the offending path in the error message', () => {
    expect(() =>
      validateWorksheetDefinition(
        grainBowlDefinition({
          components: [{ label: 'x', quantity: 1, per_basis: { calories: 'lots' } }],
        })
      )
    ).toThrow(/components\[0\]\.per_basis\.calories/);
  });

  describe('cook_mode', () => {
    it('accepts an eaten directive', () => {
      const definition = validateWorksheetDefinition(
        grainBowlDefinition({ cook_mode: { disposition: 'eaten', label: 'grain bowl' } })
      );
      expect(definition.cook_mode).toEqual({ disposition: 'eaten', label: 'grain bowl' });
    });

    it('accepts a packed directive with its conversion details', () => {
      const definition = validateWorksheetDefinition(
        grainBowlDefinition({
          cook_mode: {
            disposition: 'packed',
            label: 'grain bowl jars',
            units: 3,
            shelf_life_class: 'prepared',
            recipe_ulid: '01JBBBBBBBBBBBBBBBBBBBBBBB',
            sources: [{ item_ulid: '01JCCCCCCCCCCCCCCCCCCCCCCC', amount: 0.5 }],
          },
        })
      );
      expect(definition.cook_mode).toMatchObject({ disposition: 'packed', units: 3 });
    });

    it.each([
      ['an unknown disposition', { disposition: 'frozen', label: 'x' }],
      ['a missing label', { disposition: 'eaten' }],
      ['a non-integer unit count', { disposition: 'packed', label: 'x', units: 2.5 }],
      ['an unknown key', { disposition: 'eaten', label: 'x', colour: 'red' }],
    ])('rejects %s', (_label, cook_mode) => {
      expect(() => validateWorksheetDefinition(grainBowlDefinition({ cook_mode }))).toThrow(
        WorksheetValidationError
      );
    });

    it('rejects packed-only details on an eaten sheet rather than dropping them', () => {
      expect(() =>
        validateWorksheetDefinition(
          grainBowlDefinition({ cook_mode: { disposition: 'eaten', label: 'x', units: 3 } })
        )
      ).toThrow(/applies only to disposition 'packed'/);
    });
  });
});

describe('validateWorksheetSubmission', () => {
  const definition = validateWorksheetDefinition(grainBowlDefinition());

  it('accepts a submission that answers the published worksheet', () => {
    const submission = validateWorksheetSubmission(
      {
        kind: 'worksheet',
        version: 1,
        submission_key: SUBMISSION_KEY,
        quantities: [{ label: 'cooked grain', quantity: 187 }],
        note: 'slightly less grain than planned',
      },
      definition
    );
    expect(submission.submission_key).toBe(SUBMISSION_KEY);
    expect(submission.quantities).toEqual([{ label: 'cooked grain', quantity: 187 }]);
  });

  it.each([
    ['a non-object payload', 'nope'],
    ['the wrong kind', { kind: 'note', version: 1, submission_key: SUBMISSION_KEY, quantities: [] }],
    [
      'a version mismatch',
      { kind: 'worksheet', version: 2, submission_key: SUBMISSION_KEY, quantities: [] },
    ],
    ['a missing submission key', { kind: 'worksheet', version: 1, quantities: [] }],
    [
      'a submission key that is not a ULID',
      { kind: 'worksheet', version: 1, submission_key: 'not-a-ulid', quantities: [] },
    ],
    [
      'quantities that are not an array',
      { kind: 'worksheet', version: 1, submission_key: SUBMISSION_KEY, quantities: {} },
    ],
    [
      'a component the worksheet never declared',
      {
        kind: 'worksheet',
        version: 1,
        submission_key: SUBMISSION_KEY,
        quantities: [{ label: 'bacon', quantity: 50 }],
      },
    ],
    [
      'the same component twice',
      {
        kind: 'worksheet',
        version: 1,
        submission_key: SUBMISSION_KEY,
        quantities: [
          { label: 'dressing', quantity: 10 },
          { label: 'dressing', quantity: 20 },
        ],
      },
    ],
    [
      'a negative quantity',
      {
        kind: 'worksheet',
        version: 1,
        submission_key: SUBMISSION_KEY,
        quantities: [{ label: 'dressing', quantity: -1 }],
      },
    ],
    [
      'an absurd quantity',
      {
        kind: 'worksheet',
        version: 1,
        submission_key: SUBMISSION_KEY,
        quantities: [{ label: 'dressing', quantity: WORKSHEET_MAX_QUANTITY + 1 }],
      },
    ],
    [
      'a non-numeric quantity',
      {
        kind: 'worksheet',
        version: 1,
        submission_key: SUBMISSION_KEY,
        quantities: [{ label: 'dressing', quantity: '30' }],
      },
    ],
    [
      'an unknown top-level key',
      {
        kind: 'worksheet',
        version: 1,
        submission_key: SUBMISSION_KEY,
        quantities: [],
        totals: { calories: 1 },
      },
    ],
  ])('rejects %s', (_label, payload) => {
    expect(() => validateWorksheetSubmission(payload, definition)).toThrow(WorksheetValidationError);
  });

  it('refuses a client-supplied totals field — the server owns the arithmetic', () => {
    expect(() =>
      validateWorksheetSubmission(
        {
          kind: 'worksheet',
          version: 1,
          submission_key: SUBMISSION_KEY,
          quantities: [],
          totals: { calories: 1 },
        },
        definition
      )
    ).toThrow(/unknown key: totals/);
  });
});

describe('computeWorksheetTotals', () => {
  const definition = validateWorksheetDefinition(grainBowlDefinition());

  it('matches a hand-checked fixture', () => {
    // 200 g grain      → 2.00 × 130 = 260 cal, 2.00 × 4.5 = 9.0 g protein
    // 150 g vegetable  → 1.50 ×  60 =  90 cal, 1.50 × 2   = 3.0 g protein, 1.5 × 3 = 4.5 g fiber
    //  30 g dressing   → 0.30 × 400 = 120 cal, 0.30 × 0   = 0.0 g protein
    //                    ------------------------------------------------
    //                                470 cal,               12.0 g protein, 4.5 g fiber
    const totals = computeWorksheetTotals(definition, []);
    expect(totals).toEqual({ calories: 470, protein_g: 12, fiber_g: 4.5 });
  });

  it('recomputes from the submitted quantities, not the planned ones', () => {
    // Grain down to 187 g, dressing up to 45 g; vegetable left unstated.
    // 187 g grain     → 1.87 × 130 = 243.1 cal, 1.87 × 4.5 = 8.415 g protein
    // 150 g vegetable →              90    cal,              3     g protein, 4.5 g fiber
    //  45 g dressing  → 0.45 × 400 = 180    cal,              0     g protein
    //                   -----------------------------------------------------
    //                                513.1 → 513 cal (precision 0)
    //                                             11.415 → 11.4 g protein
    const totals = computeWorksheetTotals(definition, [
      { label: 'cooked grain', quantity: 187 },
      { label: 'dressing', quantity: 45 },
    ]);
    expect(totals).toEqual({ calories: 513, protein_g: 11.4, fiber_g: 4.5 });
  });

  it('leaves a field null when NO component carried it, and never coerces to 0', () => {
    const sparse = validateWorksheetDefinition(
      grainBowlDefinition({
        fields: [
          { key: 'calories', label: 'Calories', precision: 0 },
          { key: 'sodium_mg', label: 'Sodium', unit: 'mg', precision: 0 },
        ],
        components: [{ label: 'cooked grain', quantity: 100, per_basis: { calories: 130 } }],
      })
    );
    const totals = computeWorksheetTotals(sparse, []);
    expect(totals.calories).toBe(130);
    expect(totals.sodium_mg).toBeNull();
  });

  it('counts a component that states 0 as a real zero, not as unknown', () => {
    // `dressing` states protein_g: 0 — the total is 0, and 0 is not null.
    const totals = computeWorksheetTotals(definition, [
      { label: 'cooked grain', quantity: 0 },
      { label: 'roast vegetable', quantity: 0 },
      { label: 'dressing', quantity: 30 },
    ]);
    expect(totals.protein_g).toBe(0);
    expect(totals.fiber_g).toBe(0);
  });

  it('treats an omitted component as its planned quantity, not as zero', () => {
    const all = computeWorksheetTotals(definition, [
      { label: 'cooked grain', quantity: 200 },
      { label: 'roast vegetable', quantity: 150 },
      { label: 'dressing', quantity: 30 },
    ]);
    expect(computeWorksheetTotals(definition, [])).toEqual(all);
  });
});

describe('normalizeWorksheetResponse', () => {
  it('stores the stated quantities, their references, and the computed totals', () => {
    const definition = validateWorksheetDefinition(grainBowlDefinition());
    const submission = validateWorksheetSubmission(
      {
        kind: 'worksheet',
        version: 1,
        submission_key: SUBMISSION_KEY,
        quantities: [{ label: 'cooked grain', quantity: 187 }],
      },
      definition
    );

    const payload = normalizeWorksheetResponse(definition, submission);

    expect(payload.submission_key).toBe(SUBMISSION_KEY);
    expect(payload.basis).toBe(100);
    expect(payload.components).toHaveLength(3);
    expect(payload.components[0]).toEqual({
      label: 'cooked grain',
      quantity: 187,
      per_basis: { calories: 130, protein_g: 4.5 },
    });
    // An unstated row resolves to its planned quantity in the stored record —
    // a consumer never has to go back to the definition to interpret it.
    expect(payload.components[1]!.quantity).toBe(150);
    // 1.87 × 130 = 243.1 + 90 + 120 = 453.1 → 453 cal (precision 0);
    // 1.87 × 4.5 = 8.415 + 3 + 0 = 11.415 → 11.4 g protein.
    expect(payload.totals).toEqual({ calories: 453, protein_g: 11.4, fiber_g: 4.5 });
    expect(payload.cook_mode).toBeUndefined();
  });

  it('carries the cook-mode directive with the submission key as its ULID', () => {
    const definition = validateWorksheetDefinition(
      grainBowlDefinition({ cook_mode: { disposition: 'packed', label: 'grain bowl jars', units: 3 } })
    );
    const submission = validateWorksheetSubmission(
      { kind: 'worksheet', version: 1, submission_key: SUBMISSION_KEY, quantities: [] },
      definition
    );

    expect(normalizeWorksheetResponse(definition, submission).cook_mode).toEqual({
      disposition: 'packed',
      label: 'grain bowl jars',
      ulid: SUBMISSION_KEY,
    });
  });
});

describe('isWorksheetPayload', () => {
  it.each([
    [{ kind: 'worksheet' }, true],
    [{ kind: 'freeform' }, false],
    [null, false],
    ['worksheet', false],
    [[{ kind: 'worksheet' }], false],
  ])('%p → %p', (payload, expected) => {
    expect(isWorksheetPayload(payload)).toBe(expected);
  });
});

describe('summarizeWorksheet', () => {
  it('leads with the cook-mode label and the first few totals', () => {
    const definition = validateWorksheetDefinition(
      grainBowlDefinition({ cook_mode: { disposition: 'eaten', label: 'grain bowl' } })
    );
    const submission = validateWorksheetSubmission(
      { kind: 'worksheet', version: 1, submission_key: SUBMISSION_KEY, quantities: [] },
      definition
    );
    const summary = summarizeWorksheet(definition, normalizeWorksheetResponse(definition, submission));
    expect(summary).toBe('grain bowl: Calories 470, Protein 12 g, Fiber 4.5 g');
  });
});

describe('renderWorksheetHtml', () => {
  const definition = validateWorksheetDefinition(
    grainBowlDefinition({ cook_mode: { disposition: 'eaten', label: 'grain bowl' } })
  );
  const html = renderWorksheetHtml(definition, 'Prep — grain bowl');

  it('declares UTF-8 and preserves the non-ASCII glyphs in its steps verbatim', () => {
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('425 °F');
    expect(html).toContain('≈ 2 × with dressing');
  });

  it('renders one editable input per component, keyed by label', () => {
    for (const component of definition.components) {
      expect(html).toContain(`data-pw-label="${component.label}"`);
    }
    expect(html).toContain('value="200"');
  });

  it('renders a placeholder per computed field, filled in by the shared runtime', () => {
    for (const field of definition.fields) {
      expect(html).toContain(`data-pw-total="${field.key}"`);
    }
    // No bespoke arithmetic in the page — that is the point of the pattern.
    expect(html).not.toContain('per_basis[');
  });

  it('embeds the definition as JSON and loads the shared helper', () => {
    expect(html).toContain('<script src="/pages/_helper.js"></script>');
    expect(html).toContain('window.pagesWorksheetInit()');

    const embedded = html.match(
      /<script type="application\/json" id="pw-definition"[^>]*>(.*?)<\/script>/s
    )?.[1];
    expect(embedded).toBeTruthy();
    expect(JSON.parse(embedded!)).toEqual(definition as unknown as WorksheetDefinition);
  });

  it('carries a fresh data-pw-instance token on the definition element, distinct per render', () => {
    const match = html.match(/<script type="application\/json" id="pw-definition" data-pw-instance="([^"]+)">/);
    expect(match?.[1]).toBeTruthy();

    // A republish is a second render call — even of the identical definition —
    // and must mint a DIFFERENT instance token, because the client-side draft
    // that would otherwise resurrect the prior submission's key and quantities
    // is scoped to (slug, instance) (see specs/modules/pages.md § Idempotency).
    const secondHtml = renderWorksheetHtml(definition, 'Prep — grain bowl');
    const secondMatch = secondHtml.match(
      /<script type="application\/json" id="pw-definition" data-pw-instance="([^"]+)">/
    );
    expect(secondMatch?.[1]).toBeTruthy();
    expect(secondMatch?.[1]).not.toBe(match?.[1]);
  });

  it('escapes a label that would otherwise close the JSON block or inject markup', () => {
    const hostile = validateWorksheetDefinition(
      grainBowlDefinition({
        components: [
          {
            label: '</script><img src=x onerror=alert(1)>',
            quantity: 1,
            per_basis: { calories: 1 },
          },
        ],
      })
    );
    const rendered = renderWorksheetHtml(hostile, 'x');
    expect(rendered).not.toContain('<img src=x');
    expect(rendered).not.toContain('</script><img');
    // The JSON block still parses, so the runtime still gets its definition.
    const embedded = rendered.match(
      /<script type="application\/json" id="pw-definition"[^>]*>(.*?)<\/script>/s
    )?.[1];
    expect(JSON.parse(embedded!).components[0].label).toBe(
      '</script><img src=x onerror=alert(1)>'
    );
  });
});

describe('cook_mode.consumes (eaten decrements)', () => {
  const base = (cook: any) => ({
    kind: 'worksheet', version: 1,
    fields: [{ key: 'calories', label: 'Calories' }],
    components: [{ label: 'yogurt', quantity: 100, per_basis: { calories: 50 } }],
    cook_mode: cook,
  });

  it('accepts a well-formed binding on an eaten sheet', () => {
    const d = validateWorksheetDefinition(base({
      disposition: 'eaten', label: 'meal',
      consumes: [{ component: 'yogurt', item_ulid: '01ABC', model: 'divisible' }],
    }));
    expect(d.cook_mode!.consumes).toHaveLength(1);
  });

  it('REJECTS a binding naming a component that does not exist', () => {
    // A binding that matches nothing would decrement nothing — the silent skip
    // the feature exists to remove. Caught at publish, where it is fixable.
    expect(() => validateWorksheetDefinition(base({
      disposition: 'eaten', label: 'meal',
      consumes: [{ component: 'granola', item_ulid: '01ABC', model: 'divisible' }],
    }))).toThrow(/not in components/);
  });

  it('rejects an unknown model', () => {
    expect(() => validateWorksheetDefinition(base({
      disposition: 'eaten', label: 'meal',
      consumes: [{ component: 'yogurt', item_ulid: '01ABC', model: 'weighed' }],
    }))).toThrow(/divisible/);
  });

  it('accepts consumes on a packed sheet — a binding follows the submitted weight, a source cannot', () => {
    const def = validateWorksheetDefinition(base({
      disposition: 'packed', label: 'batch',
      consumes: [{ component: 'yogurt', item_ulid: '01ABC', model: 'divisible' }],
    }));
    expect(def.cook_mode!.consumes).toHaveLength(1);
  });

  it('accepts components_per on a packed sheet and rejects any other value', () => {
    const def = validateWorksheetDefinition(base({
      disposition: 'packed', label: 'batch', units: 3, components_per: 'unit',
    }));
    expect(def.cook_mode!.components_per).toBe('unit');

    expect(() => validateWorksheetDefinition(base({
      disposition: 'packed', label: 'batch', components_per: 'each',
    }))).toThrow(/'batch' or 'unit'/);
  });

  it('rejects components_per on an eaten sheet — it describes a batch that does not exist', () => {
    expect(() => validateWorksheetDefinition(base({
      disposition: 'eaten', label: 'meal', components_per: 'unit',
    }))).toThrow(/only to disposition 'packed'/);
  });
});
