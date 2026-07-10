/**
 * Gmail Auth Service
 *
 * Handles OAuth 2.0 flow for Google accounts:
 * - Generate authorization URLs
 * - Exchange authorization codes for tokens
 * - Refresh expired tokens
 * - Get authenticated Gmail API client
 */

import { google, gmail_v1 } from 'googleapis';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { GoogleAccount, OAuthCredentials } from '../types.js';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
];

export interface GmailAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class GmailAuthService {
  private sql: postgres.Sql;
  private log: FastifyBaseLogger;
  private config: GmailAuthConfig;
  private oauth2Client: InstanceType<typeof google.auth.OAuth2>;

  constructor(
    sql: postgres.Sql,
    log: FastifyBaseLogger,
    config: GmailAuthConfig
  ) {
    this.sql = sql;
    this.log = log;
    this.config = config;
    this.oauth2Client = new google.auth.OAuth2(
      config.clientId,
      config.clientSecret,
      config.redirectUri
    );
  }

  /**
   * Generate OAuth authorization URL for a new account
   */
  generateAuthUrl(accountId: number): string {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // Force consent to get refresh token
      scope: GMAIL_SCOPES,
      state: String(accountId),
    });
  }

  /**
   * Exchange authorization code for tokens and store them
   */
  async handleCallback(
    code: string,
    accountId: number
  ): Promise<GoogleAccount> {
    const [account] = await this.sql<GoogleAccount[]>`
      SELECT * FROM google.accounts WHERE id = ${accountId}
    `;

    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    const { tokens } = await this.oauth2Client.getToken(code);

    const credentials: OAuthCredentials = {
      access_token: tokens.access_token!,
      refresh_token: tokens.refresh_token!,
      token_type: tokens.token_type!,
      expiry_date: tokens.expiry_date!,
      scope: tokens.scope!,
    };

    // Identity guard: determine who actually authorized this consent grant
    // before storing anything. It's easy to open account 3's consent link
    // while signed into account 1's Google identity in the browser - the
    // callback used to store whatever tokens came back against the account
    // row named in `state` with no check, so it silently attached account
    // 1's credentials to account 3's row (see the July mailbox-mismatch
    // incident this guard was written for).
    const authClient = new google.auth.OAuth2(
      this.config.clientId,
      this.config.clientSecret,
      this.config.redirectUri
    );
    authClient.setCredentials(credentials);
    const profile = await google
      .gmail({ version: 'v1', auth: authClient })
      .users.getProfile({ userId: 'me' });
    const authorizedEmail = profile.data.emailAddress;

    if (!authorizedEmail || authorizedEmail.toLowerCase() !== account.email.toLowerCase()) {
      this.log.error(
        { accountId, expectedEmail: account.email, authorizedEmail },
        'OAuth callback identity mismatch - refusing to store tokens for the wrong account'
      );
      throw new Error(
        `You authorized as ${authorizedEmail ?? 'an unknown Google account'}, but this connection link is for ${account.email} (account ${accountId}). Sign out of ${authorizedEmail ?? 'that account'} in this browser (or use an incognito window), then reopen the connection link and sign in as ${account.email}.`
      );
    }

    // Store credentials in database (pass object directly for JSONB)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [updated] = await this.sql<GoogleAccount[]>`
      UPDATE google.accounts
      SET oauth_credentials = ${this.sql.json(credentials as any)}
      WHERE id = ${accountId}
      RETURNING *
    `;

    if (!updated) {
      throw new Error(`Account ${accountId} not found`);
    }

    this.log.info({ accountId, email: updated.email }, 'OAuth tokens stored');
    return updated;
  }

  /**
   * Get authenticated Gmail API client for an account
   */
  async getGmailClient(accountId: number): Promise<gmail_v1.Gmail> {
    const [account] = await this.sql<GoogleAccount[]>`
      SELECT * FROM google.accounts WHERE id = ${accountId}
    `;

    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    if (!account.oauth_credentials) {
      throw new Error(`Account ${accountId} has no OAuth credentials`);
    }

    const credentials = account.oauth_credentials as OAuthCredentials;

    // Build a per-account OAuth2 client that carries the client id/secret so the
    // google-auth-library can refresh the access token itself when it expires.
    //
    // Previously this returned a client backed by a bare `new google.auth.OAuth2()`
    // (no client id/secret) seeded with a stale credentials copy, so the automatic
    // token refresh POSTed to oauth2.googleapis.com/token without a client id and
    // failed with `invalid_request: "Could not determine client ID from request."`
    const auth = new google.auth.OAuth2(
      this.config.clientId,
      this.config.clientSecret,
      this.config.redirectUri
    );
    auth.setCredentials(credentials);

    // Persist tokens whenever the library refreshes the access token so the DB
    // stays current and we don't refresh on every request.
    auth.on('tokens', (tokens) => {
      void this.persistRefreshedTokens(accountId, credentials, tokens);
    });

    return google.gmail({ version: 'v1', auth });
  }

  /**
   * Persist tokens emitted by google-auth-library when it refreshes the access
   * token. Refresh responses often omit the refresh_token/scope, so fall back to
   * the previously stored values.
   */
  private async persistRefreshedTokens(
    accountId: number,
    previous: OAuthCredentials,
    tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      token_type?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }
  ): Promise<void> {
    const updatedCredentials: OAuthCredentials = {
      access_token: tokens.access_token ?? previous.access_token,
      refresh_token: tokens.refresh_token ?? previous.refresh_token,
      token_type: tokens.token_type ?? previous.token_type,
      expiry_date: tokens.expiry_date ?? previous.expiry_date,
      scope: tokens.scope ?? previous.scope,
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.sql`
        UPDATE google.accounts
        SET oauth_credentials = ${this.sql.json(updatedCredentials as any)}
        WHERE id = ${accountId}
      `;
      this.log.info({ accountId }, 'Token refreshed');
    } catch (error) {
      this.log.error(
        { accountId, error },
        'Failed to persist refreshed OAuth token'
      );
    }
  }

  /**
   * Revoke OAuth tokens for an account
   */
  async revokeTokens(accountId: number): Promise<void> {
    const [account] = await this.sql<GoogleAccount[]>`
      SELECT * FROM google.accounts WHERE id = ${accountId}
    `;

    if (!account?.oauth_credentials) {
      return;
    }

    const credentials = account.oauth_credentials as OAuthCredentials;

    try {
      await this.oauth2Client.revokeToken(credentials.access_token);
    } catch (error) {
      this.log.warn({ accountId, error }, 'Failed to revoke token');
    }

    await this.sql`
      UPDATE google.accounts
      SET oauth_credentials = NULL, email_history_id = NULL
      WHERE id = ${accountId}
    `;

    this.log.info({ accountId }, 'OAuth tokens revoked');
  }

  /**
   * Check if an account has valid OAuth credentials
   */
  async hasValidCredentials(accountId: number): Promise<boolean> {
    const [account] = await this.sql<{ oauth_credentials: unknown }[]>`
      SELECT oauth_credentials FROM google.accounts WHERE id = ${accountId}
    `;

    return !!account?.oauth_credentials;
  }
}
