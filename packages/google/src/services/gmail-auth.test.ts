import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { GoogleAccount } from '../types.js';

/**
 * Tests for the OAuth-callback identity guard (commit cfcbd11): a code
 * exchange whose authorizing Google identity doesn't match the target
 * account's email must store nothing and throw an error naming both
 * addresses, rather than silently attaching the wrong account's tokens (the
 * July mailbox-mismatch incident this guard closes).
 *
 * `GmailAuthService.handleCallback` talks to the real `googleapis` package
 * directly (it isn't dependency-injected), so this file mocks the
 * `googleapis` module itself via `mock.module` and dynamically imports the
 * service under test afterward, per Bun's documented pattern for module
 * mocks - a static top-of-file import would run before the mock is
 * registered.
 */

const EXPECTED_EMAIL = 'correct.owner@example.com';
const WRONG_EMAIL = 'someone.else@example.com';

const TOKENS = {
  access_token: 'fresh-access-token',
  refresh_token: 'fresh-refresh-token',
  token_type: 'Bearer',
  expiry_date: 1_999_999_999_000,
  scope: 'https://www.googleapis.com/auth/gmail.readonly',
};

const getTokenMock = mock(async (_code: string) => ({ tokens: TOKENS }));

let profileEmailToReturn: string | null = WRONG_EMAIL;
const getProfileMock = mock(async () => ({
  data: { emailAddress: profileEmailToReturn },
}));
const gmailFactoryMock = mock(() => ({ users: { getProfile: getProfileMock } }));

class FakeOAuth2 {
  getToken = getTokenMock;
  setCredentials = mock(() => {});
  generateAuthUrl = mock(() => 'https://accounts.google.com/o/oauth2/fake');
  on = mock(() => {});
  revokeToken = mock(async () => {});
}

mock.module('googleapis', () => ({
  google: {
    auth: { OAuth2: FakeOAuth2 },
    gmail: gmailFactoryMock,
  },
  gmail_v1: {},
}));

const { GmailAuthService } = await import('./gmail-auth.js');

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

function makeAccountRow(overrides: Partial<GoogleAccount> = {}): GoogleAccount {
  return {
    id: 9,
    identifier: 'work',
    email: EXPECTED_EMAIL,
    display_name: null,
    oauth_credentials: null,
    is_primary: false,
    created_at: new Date('2026-01-01T00:00:00Z'),
    settings_updated_at: new Date('2026-01-01T00:00:00Z'),
    email_history_id: null,
    email_last_sync_at: null,
    email_sync_start_date: null,
    email_triage_instructions: null,
    email_label_prefix: 'AI',
    email_label_prefix_todo: 'AI/Todo',
    ...overrides,
  };
}

/** A minimal `sql` stub covering only the two queries `handleCallback` issues. */
function makeSql(accountRow: GoogleAccount) {
  const calls: string[] = [];
  let storedCredentials: unknown = accountRow.oauth_credentials;

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push(text);

    if (text.includes('SELECT * FROM google.accounts')) {
      return Promise.resolve([{ ...accountRow, oauth_credentials: storedCredentials }]);
    }
    if (text.includes('UPDATE google.accounts') && text.includes('oauth_credentials')) {
      storedCredentials = values[0];
      return Promise.resolve([{ ...accountRow, oauth_credentials: storedCredentials }]);
    }
    throw new Error(`unexpected sql call: ${text}`);
  }) as unknown as postgres.Sql;

  // `handleCallback` calls `this.sql.json(credentials)` to build the UPDATE
  // value before the tagged template runs.
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

  return { sql, calls, getStoredCredentials: () => storedCredentials };
}

beforeEach(() => {
  getTokenMock.mockClear();
  getProfileMock.mockClear();
  gmailFactoryMock.mockClear();
});

describe('GmailAuthService.handleCallback identity guard', () => {
  it('rejects a callback whose authorizing identity differs from the account and leaves stored credentials untouched', async () => {
    profileEmailToReturn = WRONG_EMAIL;

    const accountRow = makeAccountRow({ oauth_credentials: null });
    const { sql, calls, getStoredCredentials } = makeSql(accountRow);
    const log = makeLogger();

    const service = new GmailAuthService(sql, log, {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://example.com/oauth/callback',
    });

    let caught: unknown;
    try {
      await service.handleCallback('auth-code', accountRow.id);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // Names both addresses.
    expect(message).toContain(WRONG_EMAIL);
    expect(message).toContain(EXPECTED_EMAIL);

    // Stores nothing.
    expect(getStoredCredentials()).toBeNull();
    expect(calls.some((c) => c.includes('UPDATE'))).toBe(false);

    // The code exchange and profile lookup did happen (this is a
    // write-time guard, not a guard that skips the exchange).
    expect(getTokenMock).toHaveBeenCalledTimes(1);
    expect(getProfileMock).toHaveBeenCalledTimes(1);

    const errorCalls = (log.error as ReturnType<typeof mock>).mock.calls;
    expect(
      errorCalls.some(
        (call) =>
          typeof call[1] === 'string' && call[1].includes('OAuth callback identity mismatch')
      )
    ).toBe(true);
  });

  it('stores credentials when the authorizing identity matches the account (control case)', async () => {
    profileEmailToReturn = EXPECTED_EMAIL;

    const accountRow = makeAccountRow({ oauth_credentials: null });
    const { sql, calls, getStoredCredentials } = makeSql(accountRow);
    const log = makeLogger();

    const service = new GmailAuthService(sql, log, {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://example.com/oauth/callback',
    });

    const updated = await service.handleCallback('auth-code', accountRow.id);

    expect(updated.email).toBe(EXPECTED_EMAIL);
    expect(calls.some((c) => c.includes('UPDATE'))).toBe(true);
    expect(getStoredCredentials()).toMatchObject({ access_token: TOKENS.access_token });
  });
});
