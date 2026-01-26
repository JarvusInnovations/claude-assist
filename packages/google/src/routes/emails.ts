/**
 * Email Routes
 *
 * Endpoints for email queries, triage, and execution:
 * - Search and filter emails
 * - Trigger sync and triage
 * - Execute planned actions
 */

import type { FastifyPluginAsync } from 'fastify';
import type postgres from 'postgres';
import type { Scheduler } from '@jarvus/claude-assist-core';
import type { GmailSyncService } from '../services/gmail-sync.js';
import type { TriageService } from '../services/triage.js';
import type {
  EmailRecord,
  WorkflowStatus,
  MessageType,
} from '../types.js';

// Ensure module augmentation is applied
declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
  }
}

export interface EmailRoutesConfig {
  syncService: GmailSyncService;
  triageService: TriageService | null;
}

export const registerEmailRoutes: FastifyPluginAsync<EmailRoutesConfig> =
  async (fastify, { syncService, triageService }) => {
    // ==========================================
    // Email Queries
    // ==========================================

    // GET /google/emails - Search emails with filters
    fastify.get<{
      Querystring: {
        account?: string;
        workflow_status?: WorkflowStatus;
        message_type?: MessageType;
        search?: string;
        days?: string;
        limit?: string;
        offset?: string;
      };
    }>('/google/emails', async (request) => {
      const {
        account,
        workflow_status,
        message_type,
        search,
        days = '30',
        limit = '50',
        offset = '0',
      } = request.query;

      const limitNum = Math.min(parseInt(limit, 10) || 50, 100);
      const offsetNum = parseInt(offset, 10) || 0;
      const daysNum = parseInt(days, 10) || 30;

      // Use tagged template literals with conditional fragments
      const emails = await fastify.sql<EmailRecord[]>`
        SELECT
          e.id, e.account_id, e.message_id, e.thread_id,
          e.date, e.from_address, e.from_name, e.to_addresses, e.cc_addresses,
          e.subject, e.snippet, e.gmail_labels,
          e.analysis,
          e.planned_labels, e.gmail_action, e.extractions,
          e.triage_confidence, e.workflow_status,
          e.triaged_at, e.reviewed_at, e.executed_at,
          a.identifier as account_identifier,
          a.email as account_email
        FROM google.emails e
        JOIN google.accounts a ON e.account_id = a.id
        WHERE e.date > NOW() - INTERVAL '1 day' * ${daysNum}
          ${account ? fastify.sql`AND a.identifier = ${account}` : fastify.sql``}
          ${workflow_status ? fastify.sql`AND e.workflow_status = ${workflow_status}` : fastify.sql``}
          ${message_type ? fastify.sql`AND e.analysis->>'message_type' = ${message_type}` : fastify.sql``}
          ${search ? fastify.sql`AND e.search_vector @@ plainto_tsquery('english', ${search})` : fastify.sql``}
        ORDER BY e.date DESC
        LIMIT ${limitNum} OFFSET ${offsetNum}
      `;

      return emails;
    });

    // GET /google/emails/:id - Get single email with full details
    fastify.get<{ Params: { id: string } }>(
      '/google/emails/:id',
      async (request, reply) => {
        const emailId = parseInt(request.params.id, 10);

        const [email] = await fastify.sql<EmailRecord[]>`
          SELECT e.*, a.identifier as account_identifier, a.email as account_email
          FROM google.emails e
          JOIN google.accounts a ON e.account_id = a.id
          WHERE e.id = ${emailId}
        `;

        if (!email) {
          return reply.status(404).send({ error: 'Email not found' });
        }

        return email;
      }
    );

    // GET /google/emails/stats - Email statistics
    fastify.get<{
      Querystring: { account?: string; days?: string };
    }>('/google/emails/stats', async (request) => {
      const { account, days = '7' } = request.query;
      const daysNum = parseInt(days, 10) || 7;

      // Get counts by workflow status
      const statusStats = await fastify.sql<
        { workflow_status: string; count: string }[]
      >`
        SELECT workflow_status, COUNT(*) as count
        FROM google.emails e
        JOIN google.accounts a ON e.account_id = a.id
        WHERE e.date > NOW() - INTERVAL '1 day' * ${daysNum}
          ${account ? fastify.sql`AND a.identifier = ${account}` : fastify.sql``}
        GROUP BY workflow_status
      `;

      // Get counts by message_type
      const messageTypeStats = await fastify.sql<
        { message_type: string; count: string }[]
      >`
        SELECT analysis->>'message_type' as message_type, COUNT(*) as count
        FROM google.emails e
        JOIN google.accounts a ON e.account_id = a.id
        WHERE e.date > NOW() - INTERVAL '1 day' * ${daysNum}
          AND e.analysis->>'message_type' IS NOT NULL
          ${account ? fastify.sql`AND a.identifier = ${account}` : fastify.sql``}
        GROUP BY analysis->>'message_type'
        ORDER BY count DESC
      `;

      // Get counts by sender_type
      const senderTypeStats = await fastify.sql<
        { sender_type: string; count: string }[]
      >`
        SELECT analysis->>'sender_type' as sender_type, COUNT(*) as count
        FROM google.emails e
        JOIN google.accounts a ON e.account_id = a.id
        WHERE e.date > NOW() - INTERVAL '1 day' * ${daysNum}
          AND e.analysis->>'sender_type' IS NOT NULL
          ${account ? fastify.sql`AND a.identifier = ${account}` : fastify.sql``}
        GROUP BY analysis->>'sender_type'
        ORDER BY count DESC
      `;

      return {
        days: daysNum,
        byStatus: Object.fromEntries(
          statusStats.map((s) => [s.workflow_status, parseInt(s.count, 10)])
        ),
        byMessageType: Object.fromEntries(
          messageTypeStats.map((s) => [s.message_type, parseInt(s.count, 10)])
        ),
        bySenderType: Object.fromEntries(
          senderTypeStats.map((s) => [s.sender_type, parseInt(s.count, 10)])
        ),
      };
    });

    // ==========================================
    // Sync and Triage
    // ==========================================

    // POST /google/sync - Trigger email sync (async, returns immediately)
    fastify.post<{
      Body?: { account?: string; full?: boolean };
    }>('/google/sync', async (request) => {
      const { account, full = false } = request.body || {};

      // Get accounts to sync
      const accounts = await fastify.sql<{ id: number; identifier: string }[]>`
        SELECT id, identifier FROM google.accounts
        WHERE oauth_credentials IS NOT NULL
          ${account ? fastify.sql`AND identifier = ${account}` : fastify.sql``}
      `;

      if (accounts.length === 0) {
        return { message: 'No accounts found to sync', started: [] };
      }

      // Check which accounts are already syncing
      const alreadySyncing: string[] = [];
      const starting: string[] = [];

      for (const acc of accounts) {
        const status = syncService.getSyncStatus(acc.id);
        if (status.syncing) {
          alreadySyncing.push(acc.identifier);
        } else {
          starting.push(acc.identifier);
          // Fire and forget - don't await
          const syncPromise = full
            ? syncService.syncFull(acc.id)
            : syncService.syncIncremental(acc.id);

          syncPromise
            .then((result) => {
              fastify.log.info(
                { account: acc.identifier, result },
                'Sync complete'
              );
            })
            .catch((error) => {
              fastify.log.error(
                { account: acc.identifier, error },
                'Sync failed'
              );
            });
        }
      }

      return {
        message: `Sync started for ${starting.length} account(s). Check GET /google/accounts for progress.`,
        started: starting,
        alreadySyncing,
        type: full ? 'full' : 'incremental',
      };
    });

    // Triage endpoints (only if triageService available)
    if (triageService) {
      // POST /google/emails/:id/triage - Triage single email
      fastify.post<{ Params: { id: string } }>(
        '/google/emails/:id/triage',
        async (request, reply) => {
          const emailId = parseInt(request.params.id, 10);

          const result = await triageService.triageEmail(emailId);

          if (!result.success) {
            return reply.status(400).send({ error: result.error });
          }

          return result;
        }
      );

      // POST /google/triage - Triage pending emails (async, returns immediately)
      fastify.post<{
        Body?: { account?: string; limit?: number };
      }>('/google/triage', async (request) => {
        const { account, limit = 50 } = request.body || {};

        // Get pending emails
        const pending = await fastify.sql<{ id: number; account_id: number }[]>`
          SELECT e.id, e.account_id FROM google.emails e
          JOIN google.accounts a ON e.account_id = a.id
          WHERE e.workflow_status = 'new'
            ${account ? fastify.sql`AND a.identifier = ${account}` : fastify.sql``}
          ORDER BY e.date DESC
          LIMIT ${limit}
        `;

        if (pending.length === 0) {
          return { message: 'No pending emails to triage', count: 0 };
        }

        // Check if any accounts are already triaging
        const accountIds = [...new Set(pending.map((e) => e.account_id))];
        const alreadyTriaging = accountIds.filter(
          (id) => triageService.getTriageStatus(id).triaging
        );

        if (alreadyTriaging.length === accountIds.length) {
          return {
            message: 'Triage already in progress for all accounts',
            count: 0,
            alreadyTriaging: alreadyTriaging.length,
          };
        }

        // Fire and forget - don't await
        triageService
          .triageBatch(pending.map((e) => e.id))
          .then((results) => {
            const success = results.filter((r) => r.success).length;
            const failed = results.filter((r) => !r.success).length;
            fastify.log.info(
              { count: pending.length, success, failed },
              'Triage batch complete'
            );
          })
          .catch((error) => {
            fastify.log.error({ error }, 'Triage batch failed');
          });

        return {
          message: `Triage started for ${pending.length} email(s). Check GET /google/accounts for progress.`,
          count: pending.length,
          accountIds,
        };
      });

      // GET /google/triage/progress - Triage progress
      fastify.get('/google/triage/progress', async () => {
        const [stats] = await fastify.sql<{
          new: string;
          triaged: string;
          reviewed: string;
          executed: string;
          with_errors: string;
        }[]>`
          SELECT
            COUNT(*) FILTER (WHERE workflow_status = 'new') as new,
            COUNT(*) FILTER (WHERE workflow_status = 'triaged') as triaged,
            COUNT(*) FILTER (WHERE workflow_status = 'reviewed') as reviewed,
            COUNT(*) FILTER (WHERE workflow_status = 'executed') as executed,
            COUNT(*) FILTER (WHERE last_error IS NOT NULL) as with_errors
          FROM google.emails
          WHERE date > NOW() - INTERVAL '7 days'
        `;

        return {
          new: parseInt(stats?.new || '0', 10),
          triaged: parseInt(stats?.triaged || '0', 10),
          reviewed: parseInt(stats?.reviewed || '0', 10),
          executed: parseInt(stats?.executed || '0', 10),
          with_errors: parseInt(stats?.with_errors || '0', 10),
        };
      });
    }

    // ==========================================
    // Review and Execute
    // ==========================================

    // PATCH /google/emails/:id - Update email plan (during review)
    fastify.patch<{
      Params: { id: string };
      Body: {
        planned_labels?: string[];
        gmail_action?: string;
        extractions?: unknown[];
      };
    }>('/google/emails/:id', async (request, reply) => {
      const emailId = parseInt(request.params.id, 10);
      const { planned_labels, gmail_action, extractions } = request.body;

      const [email] = await fastify.sql<EmailRecord[]>`
        UPDATE google.emails SET
          planned_labels = COALESCE(${planned_labels ?? null}, planned_labels),
          gmail_action = COALESCE(${gmail_action ?? null}, gmail_action),
          extractions = COALESCE(${extractions ? JSON.stringify(extractions) : null}, extractions),
          workflow_status = 'reviewed',
          reviewed_at = NOW()
        WHERE id = ${emailId}
        RETURNING *
      `;

      if (!email) {
        return reply.status(404).send({ error: 'Email not found' });
      }

      return email;
    });

    // POST /google/emails/:id/execute - Execute planned actions
    fastify.post<{
      Params: { id: string };
      Body?: {
        apply_labels?: boolean;
        apply_gmail_action?: boolean;
        extraction_notes?: string[];
      };
    }>('/google/emails/:id/execute', async (request, reply) => {
      const emailId = parseInt(request.params.id, 10);
      const {
        apply_labels = true,
        apply_gmail_action = true,
        extraction_notes,
      } = request.body || {};

      const [email] = await fastify.sql<EmailRecord[]>`
        SELECT * FROM google.emails WHERE id = ${emailId}
      `;

      if (!email) {
        return reply.status(404).send({ error: 'Email not found' });
      }

      // For now, just mark as executed and record what was planned
      // Actual Gmail API calls would go here
      const appliedLabels = apply_labels ? email.planned_labels : null;
      const appliedAction = apply_gmail_action ? email.gmail_action : null;

      await fastify.sql`
        UPDATE google.emails SET
          applied_labels = ${appliedLabels ?? null},
          applied_gmail_action = ${appliedAction ?? null},
          applied_extractions = ${extraction_notes ?? null},
          workflow_status = 'executed',
          executed_at = NOW()
        WHERE id = ${emailId}
      `;

      // TODO: Actually apply labels and actions via Gmail API

      return {
        success: true,
        applied: {
          labels: appliedLabels,
          gmail_action: appliedAction,
          extractions: extraction_notes,
        },
      };
    });

    // POST /google/emails/batch-execute - Execute multiple emails
    fastify.post<{
      Body: {
        email_ids: number[];
        apply_labels?: boolean;
        apply_gmail_action?: boolean;
      };
    }>('/google/emails/batch-execute', async (request) => {
      const { email_ids, apply_labels = true, apply_gmail_action = true } =
        request.body;

      let success = 0;
      let failed = 0;

      for (const emailId of email_ids) {
        try {
          const [email] = await fastify.sql<EmailRecord[]>`
            SELECT * FROM google.emails WHERE id = ${emailId}
          `;

          if (!email) {
            failed++;
            continue;
          }

          const appliedLabels = apply_labels ? email.planned_labels : null;
          const appliedAction = apply_gmail_action ? email.gmail_action : null;

          await fastify.sql`
            UPDATE google.emails SET
              applied_labels = ${appliedLabels ?? null},
              applied_gmail_action = ${appliedAction ?? null},
              workflow_status = 'executed',
              executed_at = NOW()
            WHERE id = ${emailId}
          `;

          success++;
        } catch (error) {
          fastify.log.error({ emailId, error }, 'Batch execute failed');
          failed++;
        }
      }

      return { success, failed };
    });
  };
