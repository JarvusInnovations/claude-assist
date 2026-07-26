import { describe, expect, it } from 'bun:test';
import { DailyTargetsConfigError, parseDailyTargets } from './daily-targets.js';

describe('parseDailyTargets (§ Daily targets)', () => {
  it('parses a valid config verbatim — any subset of panel fields, either bound', () => {
    const raw = '{"sugar_g":{"max":100},"fiber_g":{"min":42},"calories":{"max":1000}}';
    expect(parseDailyTargets(raw)).toEqual({
      sugar_g: { max: 100 },
      fiber_g: { min: 42 },
      calories: { max: 1000 },
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
    expect(() => parseDailyTargets('"sugar_g"')).toThrow(DailyTargetsConfigError);
    expect(() => parseDailyTargets('100')).toThrow(DailyTargetsConfigError);
    expect(() => parseDailyTargets('null')).toThrow(DailyTargetsConfigError);
  });

  it('throws on an unknown field name', () => {
    expect(() => parseDailyTargets('{"caffeine_mg":{"max":100}}')).toThrow(/unknown field "caffeine_mg"/);
  });

  it('throws when a field sets both bounds or neither — a line points one way', () => {
    expect(() => parseDailyTargets('{"sugar_g":{"max":100,"min":42}}')).toThrow(/exactly one of/);
    expect(() => parseDailyTargets('{"sugar_g":{}}')).toThrow(/exactly one of/);
    expect(() => parseDailyTargets('{"sugar_g":{"cap":100}}')).toThrow(/unknown bound key/);
  });

  it('throws on a non-positive or non-numeric bound value', () => {
    expect(() => parseDailyTargets('{"sugar_g":{"max":-5}}')).toThrow(/positive finite number/);
    expect(() => parseDailyTargets('{"sugar_g":{"max":0}}')).toThrow(/positive finite number/);
    expect(() => parseDailyTargets('{"sugar_g":{"max":"100"}}')).toThrow(/positive finite number/);
  });

  it('throws when a bound is not an object at all', () => {
    expect(() => parseDailyTargets('{"sugar_g":100}')).toThrow(/must be \{"max": N\} or \{"min": N\}/);
    expect(() => parseDailyTargets('{"sugar_g":null}')).toThrow(DailyTargetsConfigError);
    expect(() => parseDailyTargets('{"sugar_g":[{"max":100}]}')).toThrow(DailyTargetsConfigError);
  });
});
