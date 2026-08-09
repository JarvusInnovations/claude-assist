import { describe, expect, it } from 'bun:test';
import {
  runIncrementalDerivation,
  reDerive,
  ensureRulesVersion,
} from './derivation.js';
import { RULES, type ToolCallRow, type DerivedActionRecord } from './rules.js';
import type { DerivationStore } from './store.js';

const VERSION = 'test-v1';

// An in-memory DerivationStore that mirrors the real Postgres semantics we care
// about: the unique (tool_call_id, rules_version) constraint on derived rows,
// a monotonically-advanced cursor, and — crucially — a separate bucket of
// DIRECT rows that re-derivation must never touch.
function makeFakeStore(toolCalls: ToolCallRow[]) {
  const derived: (DerivedActionRecord & { key: string })[] = [];
  const direct: { id: number; note: string }[] = [];
  let state: { rulesVersion: string; lastToolCallId: number } | null = null;

  const store: DerivationStore = {
    async getState() {
      return state ? { ...state } : null;
    },
    async setState(rulesVersion, lastToolCallId) {
      state = { rulesVersion, lastToolCallId };
    },
    async fetchToolCallsAfter(afterId, limit) {
      return toolCalls
        .filter((tc) => Number(tc.id) > afterId)
        .sort((a, b) => Number(a.id) - Number(b.id))
        .slice(0, limit);
    },
    async insertDerived(records) {
      let inserted = 0;
      for (const r of records) {
        const key = `${r.context.tool_call_id}::${r.rulesVersion}`;
        if (derived.some((d) => d.key === key)) continue; // ON CONFLICT DO NOTHING
        derived.push({ ...r, key });
        inserted++;
      }
      return inserted;
    },
    async deleteDerived() {
      const n = derived.length;
      derived.length = 0;
      return n;
    },
  };

  return { store, derived, direct, getState: () => state };
}

function bashCall(id: number, command: string, overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    id,
    session_id: '00000000-0000-0000-0000-000000000009',
    msg_uuid: `u-${id}`,
    msg_index: id,
    ts: '2026-07-12T10:00:00Z',
    tool_name: 'Bash',
    target: command,
    is_sidechain: false,
    ...overrides,
  };
}

// Invented fixture corpus: 3 ledger-worthy calls interleaved with routine ones.
function fixtureCorpus(): ToolCallRow[] {
  return [
    bashCall(1, 'ls -la'), // routine
    bashCall(2, 'slack-axi post --channel general --text note'), // ledger-worthy
    bashCall(3, 'git status'), // routine
    bashCall(4, 'gh pr merge 5 --method merge'), // ledger-worthy
    bashCall(5, 'git push origin main'), // ledger-worthy
    bashCall(6, 'cat file.txt'), // routine
  ];
}

const opts = { rules: RULES, rulesVersion: VERSION, batchSize: 2 };

describe('runIncrementalDerivation', () => {
  it('derives only ledger-worthy calls and advances the cursor', async () => {
    const { store, derived, getState } = makeFakeStore(fixtureCorpus());
    const result = await runIncrementalDerivation(store, opts);

    expect(result.scanned).toBe(6);
    expect(result.inserted).toBe(3);
    expect(derived.map((d) => d.actionType).sort()).toEqual([
      'outbound',
      'repo-write',
      'repo-write',
    ]);
    // Cursor advanced to the last tool-call id.
    expect(getState()?.lastToolCallId).toBe(6);
  });

  it('is idempotent: a second run over the same corpus inserts nothing', async () => {
    const { store } = makeFakeStore(fixtureCorpus());
    const first = await runIncrementalDerivation(store, opts);
    const second = await runIncrementalDerivation(store, opts);

    expect(first.inserted).toBe(3);
    expect(second.scanned).toBe(0); // cursor is past the end
    expect(second.inserted).toBe(0);
  });

  it('picks up only newly-appended tool calls on a later run', async () => {
    const corpus = fixtureCorpus();
    const { store, derived } = makeFakeStore(corpus);
    await runIncrementalDerivation(store, opts);

    corpus.push(bashCall(7, 'slack-axi post --channel eng --text hi'));
    const result = await runIncrementalDerivation(store, opts);

    expect(result.scanned).toBe(1);
    expect(result.inserted).toBe(1);
    expect(derived.some((d) => d.targetSystem === 'slack')).toBe(true);
  });

  it('re-running with a stalled cursor dedups via the unique key', async () => {
    const { store, derived } = makeFakeStore(fixtureCorpus());
    await runIncrementalDerivation(store, opts);
    // Force a full re-scan without clearing rows (cursor reset only).
    await store.setState(VERSION, 0);
    const result = await runIncrementalDerivation(store, opts);
    expect(result.scanned).toBe(6);
    expect(result.inserted).toBe(0); // all conflict
    expect(derived.length).toBe(3);
  });
});

describe('reDerive', () => {
  it('replaces derived rows and never touches direct rows', async () => {
    const { store, derived, direct } = makeFakeStore(fixtureCorpus());
    await runIncrementalDerivation(store, opts);
    // A service wrote a direct row in the meantime.
    direct.push({ id: 1, note: 'an email was archived' });

    const result = await reDerive(store, opts);

    expect(result.deleted).toBe(3);
    expect(result.inserted).toBe(3); // replayed
    expect(derived.length).toBe(3);
    // Direct rows are wholly untouched.
    expect(direct).toEqual([{ id: 1, note: 'an email was archived' }]);
  });

  it('a version bump re-derives under the new version', async () => {
    const { store, derived } = makeFakeStore(fixtureCorpus());
    await runIncrementalDerivation(store, opts);
    expect(derived.every((d) => d.rulesVersion === VERSION)).toBe(true);

    await reDerive(store, { ...opts, rulesVersion: 'test-v2' });
    expect(derived.every((d) => d.rulesVersion === 'test-v2')).toBe(true);
    expect(derived.length).toBe(3);
  });
});

describe('ensureRulesVersion', () => {
  it('fresh: initializes the cursor, defers backfill to the scheduled pass', async () => {
    const { store, derived, getState } = makeFakeStore(fixtureCorpus());
    const outcome = await ensureRulesVersion(store, opts);
    expect(outcome).toBe('fresh');
    expect(derived.length).toBe(0); // no backfill here
    expect(getState()).toEqual({ rulesVersion: VERSION, lastToolCallId: 0 });
  });

  it('current: matching version is a no-op', async () => {
    const { store } = makeFakeStore(fixtureCorpus());
    await store.setState(VERSION, 6);
    const outcome = await ensureRulesVersion(store, opts);
    expect(outcome).toBe('current');
  });

  it('rederived: a stored older version triggers a full re-derivation', async () => {
    const { store, derived } = makeFakeStore(fixtureCorpus());
    // Simulate rows derived under an older ruleset version.
    await store.setState('old-version', 6);
    await store.insertDerived([
      {
        ts: null,
        actor: { kind: 'session', session_id: 's', sidechain: false },
        actionType: 'stale',
        targetSystem: 'x',
        targetId: null,
        summary: 'stale row',
        context: { tool_call_id: '2', session_id: 's', msg_uuid: 'u' },
        rulesVersion: 'old-version',
      },
    ]);

    const outcome = await ensureRulesVersion(store, opts);

    expect(outcome).toBe('rederived');
    expect(derived.every((d) => d.rulesVersion === VERSION)).toBe(true);
    expect(derived.some((d) => d.actionType === 'stale')).toBe(false);
    expect(derived.length).toBe(3);
  });
});
