import { describe, expect, it } from 'bun:test';
import { DailyTargetsConfigError, parseDailyTargets } from './daily-targets.js';

describe('parseDailyTargets (§ Daily targets)', () => {
  it('parses a valid config verbatim — any subset of panel fields, either bound', () => {
    const raw = '{"added_sugar_g":{"max":36},"fiber_g":{"min":42},"calories":{"max":1000}}';
    expect(parseDailyTargets(raw)).toEqual({
      added_sugar_g: { max: 36 },
      fiber_g: { min: 42 },
      calories: { max: 1000 },
    });
  });

  it('takes a ceiling on added_sugar_g — the sugar target lives HERE now', () => {
    expect(parseDailyTargets('{"added_sugar_g":{"max":36}}')).toEqual({ added_sugar_g: { max: 36 } });
  });

  it('REFUSES a sugar_g target and says where the line went', () => {
    // Total sugar is captured and displayed but never targeted (§ added_sugar_g
    // vs sugar_g) — there is no established total-sugar guideline, and the
    // borrowed line read "over" on days of fruit and plain dairy. An instance
    // still carrying the retired ceiling must be told where it moved, not just
    // that the field is unknown, so this is its own message.
    expect(() => parseDailyTargets('{"sugar_g":{"max":100}}')).toThrow(DailyTargetsConfigError);
    expect(() => parseDailyTargets('{"sugar_g":{"max":100}}')).toThrow(/total sugar carries no target/);
    expect(() => parseDailyTargets('{"sugar_g":{"max":100}}')).toThrow(/added_sugar_g/);
  });

  it('leaves every OTHER field targetable — removing one line disturbs none', () => {
    const raw =
      '{"calories":{"max":2100},"protein_g":{"min":150},"fat_g":{"max":70},' +
      '"sat_fat_g":{"max":15},"carbs_g":{"max":220},"added_sugar_g":{"max":36},' +
      '"fiber_g":{"min":42},"sodium_mg":{"max":2300}}';
    expect(parseDailyTargets(raw)).toEqual({
      calories: { max: 2100 },
      protein_g: { min: 150 },
      fat_g: { max: 70 },
      sat_fat_g: { max: 15 },
      carbs_g: { max: 220 },
      added_sugar_g: { max: 36 },
      fiber_g: { min: 42 },
      sodium_mg: { max: 2300 },
    });
  });

  it('returns undefined for absent, blank, or empty-object config — feature off', () => {
    expect(parseDailyTargets(undefined)).toBeUndefined();
    expect(parseDailyTargets('')).toBeUndefined();
    expect(parseDailyTargets('   ')).toBeUndefined();
    // {} configures zero lines — same as no config, never a served empty block.
    expect(parseDailyTargets('{}')).toBeUndefined();
  });

  it('throws on invalid JSON — boot-loud, never a silent drop', () => {
    expect(() => parseDailyTargets('{not json')).toThrow(DailyTargetsConfigError);
    expect(() => parseDailyTargets('{not json')).toThrow(/not valid JSON/);
  });

  it('throws on a non-object root (array, string, number, null)', () => {
    expect(() => parseDailyTargets('[{"max":100}]')).toThrow(DailyTargetsConfigError);
    expect(() => parseDailyTargets('"added_sugar_g"')).toThrow(DailyTargetsConfigError);
    expect(() => parseDailyTargets('100')).toThrow(DailyTargetsConfigError);
    expect(() => parseDailyTargets('null')).toThrow(DailyTargetsConfigError);
  });

  it('throws on an unknown field name', () => {
    expect(() => parseDailyTargets('{"caffeine_mg":{"max":100}}')).toThrow(/unknown field "caffeine_mg"/);
  });

  it('throws when a field sets both bounds or neither — a line points one way', () => {
    expect(() => parseDailyTargets('{"added_sugar_g":{"max":36,"min":10}}')).toThrow(/exactly one of/);
    expect(() => parseDailyTargets('{"added_sugar_g":{}}')).toThrow(/exactly one of/);
    expect(() => parseDailyTargets('{"added_sugar_g":{"cap":36}}')).toThrow(/unknown bound key/);
  });

  it('throws on a non-positive or non-numeric bound value', () => {
    expect(() => parseDailyTargets('{"added_sugar_g":{"max":-5}}')).toThrow(/positive finite number/);
    expect(() => parseDailyTargets('{"added_sugar_g":{"max":0}}')).toThrow(/positive finite number/);
    expect(() => parseDailyTargets('{"added_sugar_g":{"max":"36"}}')).toThrow(/positive finite number/);
  });

  it('throws when a bound is not an object at all', () => {
    expect(() => parseDailyTargets('{"added_sugar_g":36}')).toThrow(/must be \{"max": N\} or \{"min": N\}/);
    expect(() => parseDailyTargets('{"added_sugar_g":null}')).toThrow(DailyTargetsConfigError);
    expect(() => parseDailyTargets('{"added_sugar_g":[{"max":36}]}')).toThrow(DailyTargetsConfigError);
  });
});
