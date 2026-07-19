import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { MEAL_TEMPLATE_CONTRACT_NAME, readMealBankRecipes } from './mealbank.js';

interface LogCall {
  level: 'info' | 'warn';
  obj: unknown;
  msg: string;
}

function makeLog(): { log: FastifyBaseLogger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const log = {
    info: (obj: unknown, msg: string) => calls.push({ level: 'info', obj, msg }),
    warn: (obj: unknown, msg: string) => calls.push({ level: 'warn', obj, msg }),
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => log,
    level: 'silent',
  } as unknown as FastifyBaseLogger;
  return { log, calls };
}

const CONTRACT_JSON_PATH = join(import.meta.dir, '../../contracts/meal-template.v1.schema.json');
const GITSHEETS_BIN = join(import.meta.dir, '../../node_modules/.bin/gitsheets');

const SHEET_CONFIG_PLAIN = "[gitsheet]\nroot = 'meals'\npath = '${{ slug }}'\n";
const SHEET_CONFIG_DECLARED =
  SHEET_CONFIG_PLAIN + `implements = ['${MEAL_TEMPLATE_CONTRACT_NAME}']\n`;

const CONFORMING_RECORDS = [
  {
    slug: 'example-bowl',
    name: 'Example bowl',
    calories: 420,
    protein_g: 32,
    sat_fat_g: 4,
  },
  {
    slug: 'example-plate',
    name: 'Example plate',
    components: [
      {
        label: 'Example grain',
        default_qty_g: 150,
        per_100g: { calories: 130, protein_g: 3, sat_fat_g: 0.1 },
      },
    ],
  },
];

/** Violates the contract: no `name`, and `calories` is not a number. */
const NON_CONFORMING_RECORDS = [{ slug: 'mystery-item', calories: 'lots' }];

function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
}

/** Init a fixture repo with a committed sheet config, then upsert records via the gitsheets CLI. */
function makeFixtureRepo(dir: string, records: unknown[]): void {
  mkdirSync(join(dir, '.gitsheets'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, '.gitsheets/meals.toml'), SHEET_CONFIG_PLAIN);
  git(dir, 'add', '.gitsheets');
  git(dir, 'commit', '-qm', 'sheet config');
  const recordsPath = join(dir, 'seed-records.json');
  writeFileSync(recordsPath, JSON.stringify(records));
  execFileSync(
    GITSHEETS_BIN,
    ['upsert', 'meals', recordsPath, '--git-dir', join(dir, '.git'), '--message', 'seed records'],
    { stdio: 'pipe' }
  );
  rmSync(recordsPath);
}

/** Vendor the module's contract into the fixture repo and declare it in the sheet config. */
function adoptContract(dir: string): void {
  execFileSync(
    GITSHEETS_BIN,
    [
      'contracts',
      'adopt',
      CONTRACT_JSON_PATH,
      '--sheet',
      'meals',
      '--git-dir',
      join(dir, '.git'),
      '--message',
      'adopt meal-template contract',
    ],
    { stdio: 'pipe' }
  );
  // gitsheets commits to the ref, not the working tree — sync before editing
  // the config so the follow-up commit keeps the vendored contract.
  git(dir, 'reset', '-q', '--hard', 'HEAD');
  writeFileSync(join(dir, '.gitsheets/meals.toml'), SHEET_CONFIG_DECLARED);
  git(dir, 'add', '.gitsheets/meals.toml');
  git(dir, 'commit', '-qm', 'declare meal-template contract');
}

let fixturesRoot: string;
let declaredRepo: string;
let undeclaredRepo: string;
let nonConformingRepo: string;

beforeAll(() => {
  fixturesRoot = mkdtempSync(join(tmpdir(), 'kitchen-mealbank-fixtures-'));
  declaredRepo = join(fixturesRoot, 'declared');
  undeclaredRepo = join(fixturesRoot, 'undeclared');
  nonConformingRepo = join(fixturesRoot, 'non-conforming');
  makeFixtureRepo(declaredRepo, CONFORMING_RECORDS);
  adoptContract(declaredRepo);
  makeFixtureRepo(undeclaredRepo, CONFORMING_RECORDS);
  makeFixtureRepo(nonConformingRepo, NON_CONFORMING_RECORDS);
});

afterAll(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

describe('readMealBankRecipes', () => {
  it('degrades to an empty list when repoPath is unset', async () => {
    const { log } = makeLog();
    expect(await readMealBankRecipes({}, log)).toEqual([]);
  });

  it('degrades to an empty list when only repoPath is set', async () => {
    const { log } = makeLog();
    expect(await readMealBankRecipes({ repoPath: '/tmp/does-not-matter' }, log)).toEqual([]);
  });

  it('degrades to an empty list (never throws) when the repo/sheet does not exist', async () => {
    const { log } = makeLog();
    const result = await readMealBankRecipes(
      { repoPath: '/tmp/kitchen-mealbank-nonexistent-repo', sheetName: 'meals' },
      log
    );
    expect(result).toEqual([]);
  });

  it('reads a sheet that declares the contract (rung-1 identity), with no conformance chatter', async () => {
    const { log, calls } = makeLog();
    const recipes = await readMealBankRecipes({ repoPath: declaredRepo, sheetName: 'meals' }, log);
    expect(recipes.map((r) => r.name).sort()).toEqual(['Example bowl', 'Example plate']);
    expect(recipes.every((r) => r.source === 'sheet')).toBe(true);
    expect(calls).toEqual([]);
  });

  it('reads an undeclared but structurally conforming sheet, logging the undeclared conformance', async () => {
    const { log, calls } = makeLog();
    const recipes = await readMealBankRecipes({ repoPath: undeclaredRepo, sheetName: 'meals' }, log);
    expect(recipes.map((r) => r.name).sort()).toEqual(['Example bowl', 'Example plate']);
    const info = calls.filter((c) => c.level === 'info');
    expect(info).toHaveLength(1);
    expect(info[0]!.msg).toContain('does not declare');
    expect(info[0]!.msg).toContain('conforms structurally');
    expect((info[0]!.obj as { contract?: string }).contract).toBe(MEAL_TEMPLATE_CONTRACT_NAME);
  });

  it('refuses a non-conforming sheet at wiring time and degrades to no sheet recipes', async () => {
    const { log, calls } = makeLog();
    const recipes = await readMealBankRecipes(
      { repoPath: nonConformingRepo, sheetName: 'meals' },
      log
    );
    expect(recipes).toEqual([]);
    const warns = calls.filter((c) => c.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).toContain('refused at wiring time');
    expect(warns[0]!.msg).toContain('recents-only');
    const errObj = (warns[0]!.obj as { err?: { code?: string; issues?: unknown[] } }).err;
    expect(errObj?.code).toBe('contract_unsatisfied');
    expect(errObj?.issues?.length).toBeGreaterThan(0);
  });

  it('projects a flat single-item record as a one-component recipe', async () => {
    const { log } = makeLog();
    const recipes = await readMealBankRecipes({ repoPath: declaredRepo, sheetName: 'meals' }, log);
    const bowl = recipes.find((r) => r.name === 'Example bowl');
    expect(bowl?.components).toEqual([
      {
        label: 'Example bowl',
        default_qty_g: 100,
        per_100g: { calories: 420, protein_g: 32, sat_fat_g: 4 },
      },
    ]);
  });
});
