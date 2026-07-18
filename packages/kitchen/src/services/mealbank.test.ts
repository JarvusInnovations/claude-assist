import { describe, expect, it } from 'bun:test';
import type { FastifyBaseLogger } from 'fastify';
import { readMealBankRecipes } from './mealbank.js';

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => log,
  level: 'silent',
} as unknown as FastifyBaseLogger;

describe('readMealBankRecipes', () => {
  it('degrades to an empty list when repoPath is unset', async () => {
    expect(await readMealBankRecipes({}, log)).toEqual([]);
  });

  it('degrades to an empty list when only repoPath is set', async () => {
    expect(await readMealBankRecipes({ repoPath: '/tmp/does-not-matter' }, log)).toEqual([]);
  });

  it('degrades to an empty list (never throws) when the repo/sheet does not exist', async () => {
    const result = await readMealBankRecipes(
      { repoPath: '/tmp/kitchen-mealbank-nonexistent-repo', sheetName: 'meals' },
      log
    );
    expect(result).toEqual([]);
  });
});
