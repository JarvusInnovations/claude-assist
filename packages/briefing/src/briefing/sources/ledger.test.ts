import { describe, expect, it } from 'bun:test';
import { groupLedgerActions, type LedgerActionRow } from './ledger.js';

function mkRow(over: Partial<LedgerActionRow>): LedgerActionRow {
  return {
    actionType: 'repo-write',
    targetSystem: 'github',
    summary: 'did a thing',
    ts: '2026-07-10T12:00:00Z',
    ...over,
  };
}

describe('groupLedgerActions', () => {
  it('omits entirely on an empty day', () => {
    const n = groupLedgerActions([]);
    expect(n.totalCount).toBe(0);
    expect(n.groups).toHaveLength(0);
    expect(n.error).toBeNull();
  });

  it('groups by action_type + target_system and counts each', () => {
    const rows = [
      mkRow({ ts: '2026-07-10T09:00:00Z', summary: 'merged PR #67' }),
      mkRow({ ts: '2026-07-10T10:00:00Z', summary: 'opened PR #70' }),
      mkRow({ ts: '2026-07-10T11:00:00Z', summary: 'closed PR #71' }),
      mkRow({ actionType: 'team-record-write', targetSystem: 'hq', ts: '2026-07-10T12:00:00Z', summary: 'logged meeting' }),
    ];
    const n = groupLedgerActions(rows);
    expect(n.totalCount).toBe(4);
    expect(n.groups).toHaveLength(2);
    const repoGroup = n.groups.find((g) => g.actionType === 'repo-write')!;
    expect(repoGroup.targetSystem).toBe('github');
    expect(repoGroup.count).toBe(3);
  });

  it('sorts groups by count desc, then action_type/target_system asc', () => {
    const rows = [
      mkRow({ actionType: 'email-action', targetSystem: 'gmail', ts: '2026-07-10T09:00:00Z' }),
      mkRow({ actionType: 'repo-write', targetSystem: 'github', ts: '2026-07-10T09:01:00Z' }),
      mkRow({ actionType: 'repo-write', targetSystem: 'github', ts: '2026-07-10T09:02:00Z' }),
    ];
    const n = groupLedgerActions(rows);
    expect(n.groups.map((g) => g.actionType)).toEqual(['repo-write', 'email-action']);
  });

  it('picks the earliest summaries in the window as representatives, capped per group', () => {
    const rows = [
      mkRow({ ts: '2026-07-10T09:00:00Z', summary: 'merged PR #67' }),
      mkRow({ ts: '2026-07-10T10:00:00Z', summary: 'opened PR #70' }),
      mkRow({ ts: '2026-07-10T11:00:00Z', summary: 'closed PR #71' }),
    ];
    const n = groupLedgerActions(rows, 2);
    expect(n.groups[0]!.summaries).toEqual(['merged PR #67', 'opened PR #70']);
  });

  it('respects a custom summariesPerGroup count', () => {
    const rows = [
      mkRow({ ts: '2026-07-10T09:00:00Z', summary: 'a' }),
      mkRow({ ts: '2026-07-10T10:00:00Z', summary: 'b' }),
      mkRow({ ts: '2026-07-10T11:00:00Z', summary: 'c' }),
    ];
    const n = groupLedgerActions(rows, 1);
    expect(n.groups[0]!.summaries).toEqual(['a']);
  });

  it('caps the number of displayed groups while totalCount reflects everything', () => {
    const rows = [
      mkRow({ actionType: 'a', targetSystem: 'x', ts: '2026-07-10T09:00:00Z' }),
      mkRow({ actionType: 'b', targetSystem: 'x', ts: '2026-07-10T09:00:00Z' }),
      mkRow({ actionType: 'c', targetSystem: 'x', ts: '2026-07-10T09:00:00Z' }),
    ];
    const n = groupLedgerActions(rows, 2, 2);
    expect(n.totalCount).toBe(3);
    expect(n.groups).toHaveLength(2);
  });
});
