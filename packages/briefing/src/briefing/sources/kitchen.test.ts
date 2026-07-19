import { describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { fetchSuggestions, scoreSuggestions } from './kitchen.js';

/**
 * Fake postgres.Sql: a tagged-template function that routes on the query text.
 * fetchSuggestions issues (1) the on-hand stock query and, only in the
 * no-provider fallback, (2) the kitchen.recipes read.
 */
function fakeSql(handler: (query: string) => unknown[]): postgres.Sql {
  const sql = (strings: TemplateStringsArray, ..._values: unknown[]) =>
    Promise.resolve(handler(strings.join('?')));
  return sql as unknown as postgres.Sql;
}

const stockRows = [
  { name: 'Feta Cheese', aliases: ['feta'], raw_label: 'FETA CHEESE' },
  { name: null, aliases: null, raw_label: 'TOMATOESOR' },
  { name: 'Cucumber', aliases: [], raw_label: null },
];

describe('stock-aware suggestions via the injected recipes provider', () => {
  it('a sheet-only recipe (no DB row) with on-hand component classes qualifies', async () => {
    let recipesQueried = false;
    const sql = fakeSql((query) => {
      if (query.includes('kitchen.inventory_items')) return stockRows;
      if (query.includes('kitchen.recipes')) {
        recipesQueried = true;
        return [];
      }
      return [];
    });

    // Provider represents the kitchen module's merged view; this recipe exists
    // only in the meal-bank SHEET (it would never appear in kitchen.recipes).
    const provider = async () => [
      { name: 'Greek salad bowl', component_labels: ['feta', 'tomatoes', 'cucumber'] },
      { name: 'Fish tacos', component_labels: ['white fish', 'tortillas', 'cabbage'] },
    ];

    const suggestions = await fetchSuggestions(sql, 3, provider);
    expect(suggestions).toEqual([{ name: 'Greek salad bowl', have: 3, total: 3 }]);
    // The provider replaces the SQL recipe read entirely.
    expect(recipesQueried).toBe(false);
  });

  it('falls back to the DB-persisted recipe read when no provider is injected', async () => {
    const sql = fakeSql((query) => {
      if (query.includes('kitchen.inventory_items')) return stockRows;
      if (query.includes('kitchen.recipes')) {
        return [
          { name: 'Feta plate', components: [{ label: 'feta', default_qty_g: 50, per_100g: { calories: 260, protein_g: 14, sat_fat_g: 15 } }] },
        ];
      }
      return [];
    });
    const suggestions = await fetchSuggestions(sql, 3);
    expect(suggestions).toEqual([{ name: 'Feta plate', have: 1, total: 1 }]);
  });

  it('returns [] when nothing is on hand (line omitted, never an error)', async () => {
    const sql = fakeSql(() => []);
    const provider = async () => [{ name: 'Greek salad bowl', component_labels: ['feta'] }];
    expect(await fetchSuggestions(sql, 3, provider)).toEqual([]);
  });

  it('a throwing provider degrades to [] rather than failing the summary', async () => {
    const sql = fakeSql((query) => (query.includes('kitchen.inventory_items') ? stockRows : []));
    const provider = async () => {
      throw new Error('sheet read failed');
    };
    expect(await fetchSuggestions(sql, 3, provider)).toEqual([]);
  });
});

describe('scoreSuggestions', () => {
  const stock = ['feta cheese', 'feta', 'tomatoesor', 'cucumber'];

  it('requires a majority (>=60%) of components on hand', () => {
    const half = scoreSuggestions(stock, [{ name: 'Half there', component_labels: ['feta', 'octopus'] }], 3);
    expect(half).toEqual([]); // 1/2 = 50% < 60%
    const most = scoreSuggestions(stock, [{ name: 'Mostly there', component_labels: ['feta', 'cucumber', 'octopus'] }], 3);
    expect(most).toEqual([{ name: 'Mostly there', have: 2, total: 3 }]);
  });

  it('skips componentless recipes and ranks by stock used', () => {
    const out = scoreSuggestions(
      stock,
      [
        { name: 'No components', component_labels: [] },
        { name: 'Small', component_labels: ['feta'] },
        { name: 'Big', component_labels: ['feta', 'tomatoes', 'cucumber'] },
      ],
      3
    );
    expect(out.map((s) => s.name)).toEqual(['Big', 'Small']);
  });
});
