import { describe, expect, it, mock } from 'bun:test';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { gmail_v1 } from 'googleapis';
import { GmailExecutorService, buildLabelMutation } from './gmail-executor.js';
import type { GmailAuthService } from './gmail-auth.js';
import type { WhitelistService } from './whitelist.js';

function makeLogger(): FastifyBaseLogger {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    fatal: mock(() => {}),
    trace: mock(() => {}),
  } as unknown as FastifyBaseLogger;
}

describe('buildLabelMutation (pure)', () => {
  it('leave: adds labels only, removes nothing', () => {
    expect(buildLabelMutation(['L1', 'L2'], 'leave')).toEqual({
      addLabelIds: ['L1', 'L2'],
      removeLabelIds: [],
    });
  });
  it('archive: removes INBOX', () => {
    expect(buildLabelMutation(['L1'], 'archive')).toEqual({
      addLabelIds: ['L1'],
      removeLabelIds: ['INBOX'],
    });
  });
  it('spam: adds SPAM, removes INBOX — never TRASH', () => {
    const m = buildLabelMutation(['L1'], 'spam');
    expect(m.addLabelIds).toContain('SPAM');
    expect(m.removeLabelIds).toEqual(['INBOX']);
    expect(m.removeLabelIds).not.toContain('TRASH');
  });
});

/** A Gmail double that records modify calls and mints label ids as `id:<name>`. */
function makeGmail() {
  const modifyCalls: Array<{ id: string; requestBody: gmail_v1.Schema$ModifyMessageRequest }> = [];
  const createdNames: string[] = [];
  const gmail = {
    users: {
      labels: {
        list: mock(async () => ({ data: { labels: [] } })),
        create: mock(async (args: { requestBody: { name: string } }) => {
          createdNames.push(args.requestBody.name);
          return { data: { id: `id:${args.requestBody.name}`, name: args.requestBody.name } };
        }),
      },
      messages: {
        modify: mock(async (args: { id: string; requestBody: gmail_v1.Schema$ModifyMessageRequest }) => {
          modifyCalls.push({ id: args.id, requestBody: args.requestBody });
          return { data: {} };
        }),
      },
    },
  };
  return { gmail: gmail as unknown as gmail_v1.Gmail, modifyCalls, createdNames };
}

/** sql stub: SELECT returns the provided rows; UPDATE resolves empty. */
function mockSql(selectRows: unknown[]): { sql: postgres.Sql; updates: string[] } {
  const updates: string[] = [];
  const sql = ((strings: TemplateStringsArray, ..._p: unknown[]) => {
    const text = strings.join(' ');
    if (text.includes('SELECT') && text.includes('FROM google.emails')) {
      return Promise.resolve(selectRows);
    }
    if (text.includes('UPDATE google.emails')) {
      updates.push(text);
      return Promise.resolve([]);
    }
    throw new Error(`unexpected sql: ${text}`);
  }) as unknown as postgres.Sql;
  return { sql, updates };
}

function makeService(
  sql: postgres.Sql,
  gmail: gmail_v1.Gmail,
  whitelist: Set<string>,
  ledger?: { record: ReturnType<typeof mock> }
) {
  const authService = {
    getGmailClient: mock(async () => gmail),
  } as unknown as GmailAuthService;
  const whitelistService = {
    deriveWhitelist: mock(async () => whitelist),
  } as unknown as WhitelistService;
  return new GmailExecutorService(
    sql,
    makeLogger(),
    authService,
    whitelistService,
    {},
    undefined,
    ledger as never
  );
}

describe('GmailExecutorService.executeEmails — planning', () => {
  it('creates the nested label trees and applies labels + archive move', async () => {
    const row = {
      id: 1,
      account_id: 7,
      message_id: 'msg-1',
      from_address: 'news@substack.com',
      planned_labels: ['AI/Triaged', 'AI/Type/Newsletter'],
      gmail_action: 'archive',
      analysis: { message_type: 'newsletter', sender_type: 'automated' },
      workflow_status: 'triaged',
    };
    const { sql, updates } = mockSql([row]);
    const { gmail, modifyCalls, createdNames } = makeGmail();
    const svc = makeService(sql, gmail, new Set());

    const results = await svc.executeEmails([1]);

    expect(results[0]!.success).toBe(true);
    expect(results[0]!.appliedGmailAction).toBe('archive');
    // Ancestors materialized: AI, AI/Triaged, AI/Type, AI/Type/Newsletter.
    expect(createdNames).toEqual(['AI', 'AI/Triaged', 'AI/Type', 'AI/Type/Newsletter']);
    expect(modifyCalls).toHaveLength(1);
    expect(modifyCalls[0]!.id).toBe('msg-1');
    expect(modifyCalls[0]!.requestBody.addLabelIds).toEqual([
      'id:AI/Triaged',
      'id:AI/Type/Newsletter',
    ]);
    expect(modifyCalls[0]!.requestBody.removeLabelIds).toEqual(['INBOX']);
    expect(updates.some((u) => u.includes('UPDATE google.emails'))).toBe(true);
  });

  it('spam action moves to SPAM (never TRASH) for a non-whitelisted sender', async () => {
    const row = {
      id: 2,
      account_id: 7,
      message_id: 'msg-2',
      from_address: 'cold@outreach.io',
      planned_labels: ['AI/Triaged'],
      gmail_action: 'spam',
      analysis: { message_type: 'spam', sender_type: 'human' },
      workflow_status: 'triaged',
    };
    const { sql } = mockSql([row]);
    const { gmail, modifyCalls } = makeGmail();
    const svc = makeService(sql, gmail, new Set());

    const results = await svc.executeEmails([2]);

    expect(results[0]!.success).toBe(true);
    expect(results[0]!.appliedGmailAction).toBe('spam');
    expect(modifyCalls[0]!.requestBody.addLabelIds).toContain('SPAM');
    expect(modifyCalls[0]!.requestBody.removeLabelIds).toEqual(['INBOX']);
    expect(modifyCalls[0]!.requestBody.removeLabelIds).not.toContain('TRASH');
  });

  it('guardrail: never quarantines a whitelisted sender’s personal mail (spam→leave)', async () => {
    const row = {
      id: 3,
      account_id: 7,
      message_id: 'msg-3',
      from_address: 'nate@client.org',
      planned_labels: ['AI/Triaged'],
      gmail_action: 'spam',
      analysis: { message_type: 'personal', sender_type: 'human' },
      workflow_status: 'triaged',
    };
    const { sql } = mockSql([row]);
    const { gmail, modifyCalls } = makeGmail();
    const svc = makeService(sql, gmail, new Set(['nate@client.org']));

    const results = await svc.executeEmails([3]);

    expect(results[0]!.success).toBe(true);
    expect(results[0]!.appliedGmailAction).toBe('leave');
    expect(results[0]!.skipped).toBe(true);
    // No SPAM add, no INBOX removal — just the label.
    expect(modifyCalls[0]!.requestBody.addLabelIds).not.toContain('SPAM');
    expect(modifyCalls[0]!.requestBody.removeLabelIds ?? []).toEqual([]);
  });

  it('records a direct ledger row for a spam move (destructive action)', async () => {
    const row = {
      id: 9,
      account_id: 7,
      message_id: 'msg-9',
      from_address: 'cold@outreach.io',
      planned_labels: ['AI/Triaged'],
      gmail_action: 'spam',
      analysis: { message_type: 'spam', sender_type: 'human' },
      workflow_status: 'triaged',
    };
    const { sql } = mockSql([row]);
    const { gmail } = makeGmail();
    const record = mock(async (_input: Record<string, unknown>) => ({ id: 1 }));
    const svc = makeService(sql, gmail, new Set(), { record });

    await svc.executeEmails([9]);

    expect(record).toHaveBeenCalledTimes(1);
    const arg = record.mock.calls[0]![0];
    expect(arg.actionType).toBe('email-action');
    expect(arg.targetSystem).toBe('gmail');
    expect(arg.targetId).toBe('msg-9');
    expect((arg.actor as Record<string, unknown>).kind).toBe('service');
  });

  it('does NOT record a ledger row when the action is label-only (leave)', async () => {
    const row = {
      id: 10,
      account_id: 7,
      message_id: 'msg-10',
      from_address: 'colleague@example.com',
      planned_labels: ['AI/Triaged'],
      gmail_action: 'leave',
      analysis: { message_type: 'personal', sender_type: 'human' },
      workflow_status: 'triaged',
    };
    const { sql } = mockSql([row]);
    const { gmail } = makeGmail();
    const record = mock(async (_input: Record<string, unknown>) => ({ id: 1 }));
    const svc = makeService(sql, gmail, new Set(), { record });

    await svc.executeEmails([10]);

    expect(record).not.toHaveBeenCalled();
  });

  it('apply_gmail_action=false stages labels but leaves the message in place', async () => {
    const row = {
      id: 4,
      account_id: 7,
      message_id: 'msg-4',
      from_address: 'news@substack.com',
      planned_labels: ['AI/Triaged'],
      gmail_action: 'archive',
      analysis: { message_type: 'newsletter', sender_type: 'automated' },
      workflow_status: 'triaged',
    };
    const { sql } = mockSql([row]);
    const { gmail, modifyCalls } = makeGmail();
    const svc = makeService(sql, gmail, new Set());

    const results = await svc.executeEmails([4], { applyGmailAction: false });

    expect(results[0]!.appliedGmailAction).toBe('leave');
    expect(modifyCalls[0]!.requestBody.removeLabelIds ?? []).toEqual([]);
  });
});
