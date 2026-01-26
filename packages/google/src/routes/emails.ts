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
  EmailDomain,
  DigestSection,
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
        domain?: EmailDomain;
        digest_section?: DigestSection;
        search?: string;
        days?: string;
        interesting?: string;
        limit?: string;
        offset?: string;
      };
    }>('/google/emails', async (request) => {
      const {
        account,
        workflow_status,
        domain,
        digest_section,
        search,
        days = '30',
        interesting,
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
          e.email_type, e.domain, e.overview,
          e.potential_action_items, e.potential_extractions,
          e.digest_section, e.interesting, e.analysis_notes,
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
          ${domain ? fastify.sql`AND e.domain = ${domain}` : fastify.sql``}
          ${digest_section ? fastify.sql`AND e.digest_section = ${digest_section}` : fastify.sql``}
          ${interesting === 'true' ? fastify.sql`AND e.interesting = true` : fastify.sql``}
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

      // Get counts by domain
      const domainStats = await fastify.sql<
        { domain: string; count: string }[]
      >`
        SELECT domain, COUNT(*) as count
        FROM google.emails e
        JOIN google.accounts a ON e.account_id = a.id
        WHERE e.date > NOW() - INTERVAL '1 day' * ${daysNum}
          AND e.domain IS NOT NULL
          ${account ? fastify.sql`AND a.identifier = ${account}` : fastify.sql``}
        GROUP BY domain
        ORDER BY count DESC
      `;

      // Get counts by digest section
      const digestStats = await fastify.sql<
        { digest_section: string; count: string }[]
      >`
        SELECT digest_section, COUNT(*) as count
        FROM google.emails e
        JOIN google.accounts a ON e.account_id = a.id
        WHERE e.date > NOW() - INTERVAL '1 day' * ${daysNum}
          AND e.digest_section IS NOT NULL
          ${account ? fastify.sql`AND a.identifier = ${account}` : fastify.sql``}
        GROUP BY digest_section
        ORDER BY count DESC
      `;

      // Get interesting count
      const [interestingStats] = await fastify.sql<{ count: string }[]>`
        SELECT COUNT(*) as count
        FROM google.emails e
        JOIN google.accounts a ON e.account_id = a.id
        WHERE e.date > NOW() - INTERVAL '1 day' * ${daysNum}
          AND e.interesting = true
          ${account ? fastify.sql`AND a.identifier = ${account}` : fastify.sql``}
      `;

      return {
        days: daysNum,
        byStatus: Object.fromEntries(
          statusStats.map((s) => [s.workflow_status, parseInt(s.count, 10)])
        ),
        byDomain: Object.fromEntries(
          domainStats.map((s) => [s.domain, parseInt(s.count, 10)])
        ),
        byDigestSection: Object.fromEntries(
          digestStats.map((s) => [s.digest_section, parseInt(s.count, 10)])
        ),
        interesting: parseInt(interestingStats?.count || '0', 10),
      };
    });

    // ==========================================
    // Sync and Triage
    // ==========================================

    // POST /google/sync - Trigger email sync
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

      const results: Record<string, unknown> = {};

      for (const acc of accounts) {
        try {
          const result = full
            ? await syncService.syncFull(acc.id)
            : await syncService.syncIncremental(acc.id);
          results[acc.identifier] = result;

          // Trigger triage if new emails
          if (triageService && result.messagesIngested > 0) {
            fastify.log.info(
              { account: acc.identifier, newEmails: result.messagesIngested },
              'Queuing triage for new emails'
            );
          }
        } catch (error) {
          results[acc.identifier] = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      return results;
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

      // POST /google/triage - Triage pending emails
      fastify.post<{
        Body?: { account?: string; limit?: number };
      }>('/google/triage', async (request) => {
        const { account, limit = 50 } = request.body || {};

        // Get pending emails
        const pending = await fastify.sql<{ id: number }[]>`
          SELECT e.id FROM google.emails e
          JOIN google.accounts a ON e.account_id = a.id
          WHERE e.workflow_status = 'new'
            ${account ? fastify.sql`AND a.identifier = ${account}` : fastify.sql``}
          ORDER BY e.date DESC
          LIMIT ${limit}
        `;

        if (pending.length === 0) {
          return { message: 'No pending emails to triage', count: 0 };
        }

        const results = await triageService.triageBatch(
          pending.map((e) => e.id)
        );

        const success = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;

        return {
          message: `Triaged ${success} emails, ${failed} failed`,
          count: pending.length,
          success,
          failed,
          results,
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
