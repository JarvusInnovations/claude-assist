import { describe, expect, it, mock } from 'bun:test';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import { GmailSyncService } from './gmail-sync.js';
import type { GmailAuthService } from './gmail-auth.js';

/**
 * Tests for the two write-time guards added to the sync service:
 *
 * 1. Stale sync-lock expiry (commit 2cf5e77) - `hasActiveSync()` clears an
 *    in-memory lock once it exceeds `STALE_SYNC_TIMEOUT_MS` instead of
 *    skipping the account's sync forever.
 * 2. Mailbox identity assertion (commit 9371e3a) - a sync run aborts before
 *    persisting anything if the Gmail profile it fetches doesn't match the
 *    account row it's syncing for.
 *
 * Both are exercised through the public `syncFull()` entry point rather than
 * by reaching into private members, so the tests prove real, observable
 * behavior rather than just the internals.
 */

interface FakeActiveSyncState {
  startedAt: Date;
  type: 'full' | 'incremental';
  phase: 'discovering' | 'fetching';
  discovered: number;
  fetched: number;
}

/** Access to the private `activeSyncs` map, for injecting lock state directly. */
function activeSyncsOf(
  service: GmailSyncService
): Map<number, FakeActiveSyncState> {
  return (service as unknown as { activeSyncs: Map<number, FakeActiveSyncState> })
    .activeSyncs;
}

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

/** An `sql` stub that fails the test loudly if it's ever invoked. */
function unusedSql(): postgres.Sql {
  return ((..._args: unknown[]) => {
    throw new Error('sql should not have been called on this code path');
  }) as unknown as postgres.Sql;
}

describe('GmailSyncService stale sync-lock expiry', () => {
  const ACCOUNT_ID = 42;
  const STALE_MS = 30 * 60 * 1000;

  it('blocks a new sync as "already in progress" while the lock is still fresh', async () => {
    const log = makeLogger();
    const getGmailClient = mock(async () => {
      throw new Error('should not be reached - a fresh lock must block first');
    });
    const authService = { getGmailClient } as unknown as GmailAuthService;
    const service = new GmailSyncService(unusedSql(), log, authService);

    // 5 minutes old - well under the 30 minute staleness timeout.
    activeSyncsOf(service).set(ACCOUNT_ID, {
      startedAt: new Date(Date.now() - 5 * 60 * 1000),
      type: 'full',
      phase: 'discovering',
      discovered: 0,
      fetched: 0,
    });

    const result = await service.syncFull(ACCOUNT_ID);

    expect(result.errors).toEqual(['Sync already in progress']);
    expect(getGmailClient).not.toHaveBeenCalled();
    expect((log.warn as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  it('clears a lock older than STALE_SYNC_TIMEOUT_MS, logs loudly, and lets the next sync attempt proceed', async () => {
    const log = makeLogger();
    const attemptError = new Error(
      'boom: getGmailClient reached - proves the sync proceeded past the lock check'
    );
    const getGmailClient = mock(async () => {
      throw attemptError;
    });
    const authService = { getGmailClient } as unknown as GmailAuthService;
    const service = new GmailSyncService(unusedSql(), log, authService);

    // 31 minutes old - just past the 30 minute staleness timeout.
    activeSyncsOf(service).set(ACCOUNT_ID, {
      startedAt: new Date(Date.now() - STALE_MS - 60 * 1000),
      type: 'incremental',
      phase: 'fetching',
      discovered: 3,
      fetched: 1,
    });

    await expect(service.syncFull(ACCOUNT_ID)).rejects.toThrow(attemptError.message);

    // Loud log proving the stale-clearing branch (not the skip branch) ran.
    const warnCalls = (log.warn as ReturnType<typeof mock>).mock.calls;
    expect(warnCalls.length).toBe(1);
    const [warnPayload, warnMessage] = warnCalls[0] as [
      { accountId: number; ageMs: number },
      string,
    ];
    expect(warnMessage).toContain('Clearing stale sync lock');
    expect(warnPayload.accountId).toBe(ACCOUNT_ID);
    expect(warnPayload.ageMs).toBeGreaterThan(STALE_MS);

    // The sync actually attempted to run rather than short-circuiting with
    // "already in progress".
    expect(getGmailClient).toHaveBeenCalledTimes(1);

    // The cleared lock doesn't leave the account stuck.
    expect(service.getSyncStatus(ACCOUNT_ID).syncing).toBe(false);
  });
});

describe('GmailSyncService mailbox identity assertion', () => {
  const ACCOUNT_ID = 7;
  const EXPECTED_EMAIL = 'correct.owner@example.com';
  const WRONG_EMAIL = 'someone.else@example.com';

  it('aborts before persisting anything when getProfile returns a different mailbox than the account row', async () => {
    const log = makeLogger();

    const accountRow = {
      email: EXPECTED_EMAIL,
      email_label_prefix: 'AI',
      email_sync_start_date: null,
    };

    const sqlCalls: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      sqlCalls.push(text);
      if (text.includes('FROM google.accounts')) {
        return Promise.resolve([accountRow]);
      }
      throw new Error(`unexpected sql call during identity-mismatch abort: ${text}`);
    }) as unknown as postgres.Sql;

    const getProfile = mock(async () => ({
      data: { emailAddress: WRONG_EMAIL, historyId: 'should-be-unused' },
    }));
    const messagesList = mock(async () => {
      throw new Error('discoverMessages must not run once the identity check fails');
    });
    const gmailClient = {
      users: {
        getProfile,
        messages: { list: messagesList },
      },
    };
    const authService = {
      getGmailClient: mock(async () => gmailClient),
    } as unknown as GmailAuthService;

    const service = new GmailSyncService(sql, log, authService);

    const result = await service.syncFull(ACCOUNT_ID);

    // Surfaces through the existing errors path rather than throwing out of
    // syncFull.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(EXPECTED_EMAIL);
    expect(result.errors[0]).toContain(WRONG_EMAIL);
    expect(result.messagesIngested).toBe(0);
    expect(result.messagesScanned).toBe(0);

    // No message discovery/writes were attempted, and the only DB call made
    // was the initial settings lookup.
    expect(messagesList).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]).toContain('FROM google.accounts');

    const errorCalls = (log.error as ReturnType<typeof mock>).mock.calls;
    expect(
      errorCalls.some(
        (call) =>
          typeof call[1] === 'string' &&
          call[1].includes('Mailbox identity mismatch')
      )
    ).toBe(true);
  });
});
