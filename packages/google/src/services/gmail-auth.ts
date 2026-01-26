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
  private oauth2Client: InstanceType<typeof google.auth.OAuth2>;

  constructor(
    sql: postgres.Sql,
    log: FastifyBaseLogger,
    config: GmailAuthConfig
  ) {
    this.sql = sql;
    this.log = log;
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
    const { tokens } = await this.oauth2Client.getToken(code);

    const credentials: OAuthCredentials = {
      access_token: tokens.access_token!,
      refresh_token: tokens.refresh_token!,
      token_type: tokens.token_type!,
      expiry_date: tokens.expiry_date!,
      scope: tokens.scope!,
    };

    // Store credentials in database (pass object directly for JSONB)
    const [account] = await this.sql<GoogleAccount[]>`
      UPDATE google.accounts
      SET oauth_credentials = ${this.sql.json(credentials)}
      WHERE id = ${accountId}
      RETURNING *
    `;

    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    this.log.info({ accountId, email: account.email }, 'OAuth tokens stored');
    return account;
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

    // Check if token is expired or will expire in the next minute
    const isExpired =
      credentials.expiry_date &&
      credentials.expiry_date < Date.now() + 60 * 1000;

    if (isExpired) {
      this.log.info({ accountId }, 'Refreshing expired token');
      await this.refreshToken(accountId, credentials);
    }

    // Create authenticated client
    const auth = new google.auth.OAuth2();
    auth.setCredentials(account.oauth_credentials as OAuthCredentials);

    return google.gmail({ version: 'v1', auth });
  }

  /**
   * Refresh an expired access token
   */
  private async refreshToken(
    accountId: number,
    credentials: OAuthCredentials
  ): Promise<void> {
    this.oauth2Client.setCredentials({
      refresh_token: credentials.refresh_token,
    });

    const { credentials: newTokens } =
      await this.oauth2Client.refreshAccessToken();

    const updatedCredentials: OAuthCredentials = {
      access_token: newTokens.access_token!,
      refresh_token: newTokens.refresh_token || credentials.refresh_token,
      token_type: newTokens.token_type!,
      expiry_date: newTokens.expiry_date!,
      scope: credentials.scope,
    };

    await this.sql`
      UPDATE google.accounts
      SET oauth_credentials = ${this.sql.json(updatedCredentials)}
      WHERE id = ${accountId}
    `;

    this.log.info({ accountId }, 'Token refreshed');
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
      SET oauth_credentials = NULL, history_id = NULL
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
