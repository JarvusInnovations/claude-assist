/**
 * Account Routes
 *
 * Endpoints for Google account management:
 * - OAuth flow (create account → auth URL → callback)
 * - Account CRUD with settings fields included
 * - User aliases for name disambiguation
 */

import type { FastifyPluginAsync } from 'fastify';
import type postgres from 'postgres';
import type { Scheduler } from '@jarvus/claude-assist-core';
import type { GmailAuthService } from '../services/gmail-auth.js';
import type { GmailSyncService } from '../services/gmail-sync.js';
import type { TriageService } from '../services/triage.js';
import type {
  GoogleAccount,
  UserAlias,
  CreateAccountPayload,
  UpdateAccountPayload,
  CreateAliasPayload,
} from '../types.js';

// Ensure module augmentation is applied
declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
  }
}

export interface AccountRoutesConfig {
  authService: GmailAuthService;
  syncService: GmailSyncService;
  triageService: TriageService | null;
}

export const registerAccountRoutes: FastifyPluginAsync<AccountRoutesConfig> =
  async (fastify, { authService, syncService, triageService }) => {
    // ==========================================
    // Account Management
    // ==========================================

    // GET /google/accounts - List all accounts
    fastify.get('/google/accounts', async () => {
      const accounts = await fastify.sql<GoogleAccount[]>`
        SELECT id, identifier, email, display_name, is_primary,
               history_id IS NOT NULL as has_credentials,
               created_at, last_sync_at
        FROM google.accounts
        ORDER BY is_primary DESC, created_at ASC
      `;

      // Add sync and triage status to each account
      const defaultTriageStatus = { triaging: false, startedAt: null, emailCount: null, processedCount: null };
      return accounts.map((account) => ({
        ...account,
        email_sync_status: syncService.getSyncStatus(account.id),
        email_triage_status: triageService?.getTriageStatus(account.id) ?? defaultTriageStatus,
      }));
    });

    // POST /google/accounts - Create account and get auth URL
    fastify.post<{ Body: CreateAccountPayload }>(
      '/google/accounts',
      async (request, reply) => {
        const { identifier, email, display_name } = request.body;

        // Create account record
        const [account] = await fastify.sql<GoogleAccount[]>`
          INSERT INTO google.accounts (identifier, email, display_name)
          VALUES (${identifier}, ${email}, ${display_name ?? null})
          RETURNING *
        `;

        if (!account) {
          return reply.status(500).send({ error: 'Failed to create account' });
        }

        // Generate auth URL
        const authUrl = authService.generateAuthUrl(account.id);

        return {
          id: account.id,
          identifier: account.identifier,
          email: account.email,
          authUrl,
        };
      }
    );

    // GET /google/auth/callback - OAuth callback
    fastify.get<{
      Querystring: { code: string; state: string };
    }>('/google/auth/callback', async (request, reply) => {
      const { code, state } = request.query;
      const accountId = parseInt(state, 10);

      if (isNaN(accountId)) {
        return reply.status(400).send({ error: 'Invalid state parameter' });
      }

      try {
        const account = await authService.handleCallback(code, accountId);
        return {
          success: true,
          account: {
            id: account.id,
            identifier: account.identifier,
            email: account.email,
          },
        };
      } catch (error) {
        fastify.log.error({ accountId, error }, 'OAuth callback failed');
        return reply.status(400).send({
          error: 'OAuth callback failed',
          details: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // GET /google/accounts/:id - Get account details including settings
    fastify.get<{ Params: { id: string } }>(
      '/google/accounts/:id',
      async (request, reply) => {
        const accountId = parseInt(request.params.id, 10);

        const [account] = await fastify.sql<GoogleAccount[]>`
          SELECT id, identifier, email, display_name, is_primary,
                 oauth_credentials IS NOT NULL as has_credentials,
                 history_id, created_at, last_sync_at,
                 triage_system_instructions, label_prefix_tracking,
                 label_prefix_todo, sync_start_date, settings_updated_at
          FROM google.accounts
          WHERE id = ${accountId}
        `;

        if (!account) {
          return reply.status(404).send({ error: 'Account not found' });
        }

        const defaultTriageStatus = { triaging: false, startedAt: null, emailCount: null, processedCount: null };
        return {
          ...account,
          email_sync_status: syncService.getSyncStatus(accountId),
          email_triage_status: triageService?.getTriageStatus(accountId) ?? defaultTriageStatus,
        };
      }
    );

    // PATCH /google/accounts/:id - Update account including settings
    fastify.patch<{ Params: { id: string }; Body: UpdateAccountPayload }>(
      '/google/accounts/:id',
      async (request, reply) => {
        const accountId = parseInt(request.params.id, 10);
        const updates = request.body;

        // Handle fields that can be explicitly set to null
        const triageInstructionsClause =
          'triage_system_instructions' in updates
            ? fastify.sql`triage_system_instructions = ${updates.triage_system_instructions ?? null}`
            : fastify.sql`triage_system_instructions = triage_system_instructions`;

        const syncStartDateClause =
          'sync_start_date' in updates
            ? fastify.sql`sync_start_date = ${updates.sync_start_date ?? null}`
            : fastify.sql`sync_start_date = sync_start_date`;

        const [account] = await fastify.sql<GoogleAccount[]>`
          UPDATE google.accounts SET
            display_name = COALESCE(${updates.display_name ?? null}, display_name),
            is_primary = COALESCE(${updates.is_primary ?? null}, is_primary),
            ${triageInstructionsClause},
            label_prefix_tracking = COALESCE(${updates.label_prefix_tracking ?? null}, label_prefix_tracking),
            label_prefix_todo = COALESCE(${updates.label_prefix_todo ?? null}, label_prefix_todo),
            ${syncStartDateClause},
            settings_updated_at = NOW()
          WHERE id = ${accountId}
          RETURNING *
        `;

        if (!account) {
          return reply.status(404).send({ error: 'Account not found' });
        }

        return account;
      }
    );

    // DELETE /google/accounts/:id - Remove account
    fastify.delete<{ Params: { id: string } }>(
      '/google/accounts/:id',
      async (request, reply) => {
        const accountId = parseInt(request.params.id, 10);

        // Revoke OAuth tokens first
        await authService.revokeTokens(accountId);

        // Delete account (cascades to settings, aliases, emails, etc.)
        const result = await fastify.sql`
          DELETE FROM google.accounts WHERE id = ${accountId}
        `;

        if (result.count === 0) {
          return reply.status(404).send({ error: 'Account not found' });
        }

        return { success: true };
      }
    );

    // POST /google/accounts/:id/reauth - Get new auth URL for existing account
    fastify.post<{ Params: { id: string } }>(
      '/google/accounts/:id/reauth',
      async (request, reply) => {
        const accountId = parseInt(request.params.id, 10);

        const [account] = await fastify.sql<{ id: number }[]>`
          SELECT id FROM google.accounts WHERE id = ${accountId}
        `;

        if (!account) {
          return reply.status(404).send({ error: 'Account not found' });
        }

        const authUrl = authService.generateAuthUrl(accountId);
        return { authUrl };
      }
    );

    // ==========================================
    // User Aliases
    // ==========================================

    // GET /google/accounts/:id/aliases - List user aliases
    fastify.get<{ Params: { id: string } }>(
      '/google/accounts/:id/aliases',
      async (request) => {
        const accountId = parseInt(request.params.id, 10);

        const aliases = await fastify.sql<UserAlias[]>`
          SELECT * FROM google.user_aliases
          WHERE account_id = ${accountId}
          ORDER BY is_owner DESC, alias ASC
        `;

        return aliases;
      }
    );

    // POST /google/accounts/:id/aliases - Create alias
    fastify.post<{ Params: { id: string }; Body: CreateAliasPayload }>(
      '/google/accounts/:id/aliases',
      async (request, reply) => {
        const accountId = parseInt(request.params.id, 10);
        const { alias, is_owner = true, refers_to, notes } = request.body;

        try {
          const [created] = await fastify.sql<UserAlias[]>`
            INSERT INTO google.user_aliases (account_id, alias, is_owner, refers_to, notes)
            VALUES (${accountId}, ${alias}, ${is_owner}, ${refers_to ?? null}, ${notes ?? null})
            RETURNING *
          `;
          return created;
        } catch (error) {
          // Unique constraint violation
          if (
            error instanceof Error &&
            error.message.includes('unique constraint')
          ) {
            return reply.status(409).send({ error: 'Alias already exists' });
          }
          throw error;
        }
      }
    );

    // DELETE /google/accounts/:id/aliases/:aliasId - Delete alias
    fastify.delete<{ Params: { id: string; aliasId: string } }>(
      '/google/accounts/:id/aliases/:aliasId',
      async (request, reply) => {
        const accountId = parseInt(request.params.id, 10);
        const aliasId = parseInt(request.params.aliasId, 10);

        const result = await fastify.sql`
          DELETE FROM google.user_aliases
          WHERE id = ${aliasId} AND account_id = ${accountId}
        `;

        if (result.count === 0) {
          return reply.status(404).send({ error: 'Alias not found' });
        }

        return { success: true };
      }
    );
  };
