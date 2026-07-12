/**
 * Email Routes
 *
 * Endpoints for email queries and triage:
 * - Search and filter emails
 * - Trigger sync and triage
 */

import type { FastifyPluginAsync } from 'fastify';
import type postgres from 'postgres';
import type { Scheduler } from '@jarvus/claude-assist-core';
import type { GmailSyncService } from '../services/gmail-sync.js';
import { TriageService } from '../services/triage.js';
import type { GmailExecutorService } from '../services/gmail-executor.js';
import type { DigestService } from '../services/digest.js';
import { digestHeadline } from '../services/digest.js';
import type {
  SenderStandingStore,
  RefinementStore,
  SenderStanding,
} from '../services/standing.js';
import type {
  EmailRecord,
  WorkflowStatus,
} from '../types.js';

/**
 * Parse a JSONB field that may come back as a string from postgres.js
 */
function parseJsonField<T>(value: T | string | null): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

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
  executorService: GmailExecutorService | null;
  digestService: DigestService | null;
  senderStandingStore: SenderStandingStore | null;
  refinementStore: RefinementStore | null;
}

export const registerEmailRoutes: FastifyPluginAsync<EmailRoutesConfig> =
  async (
    fastify,
    {
      syncService,
      triageService,
      executorService,
      digestService,
      senderStandingStore,
      refinementStore,
    }
  ) => {
    // ==========================================
    // Email Queries
    // ==========================================

    // GET /google/emails - Search emails with filters
    fastify.get<{
      Querystring: {
        account?: string;
        workflow_status?: WorkflowStatus;
        message_type?: string;
        search?: string;
        with?: string | string[];
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
      const withParam = request.query.with;

      const limitNum = Math.min(parseInt(limit, 10) || 50, 500);
      const offsetNum = parseInt(offset, 10) || 0;
      const daysNum = parseInt(days, 10) || 30;

      // Parse "message_type" param: supports comma-separated values for OR matching
      const messageTypes = message_type
        ? message_type.split(',').map((t) => t.trim()).filter(Boolean)
        : [];

      // Parse "with" param: supports repeated ?with=a&with=b or comma-separated ?with=a,b
      const withTerms = withParam
        ? (Array.isArray(withParam) ? withParam : [withParam])
            .flatMap((t) => t.split(','))
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean)
        : [];

      // Build OR conditions for each "with" term matching from/to fields
      const withFragment =
        withTerms.length > 0
          ? fastify.sql`AND (${withTerms
              .map(
                (term) =>
                  fastify.sql`LOWER(e.from_address) LIKE ${'%' + term + '%'}
                    OR LOWER(e.from_name) LIKE ${'%' + term + '%'}
                    OR EXISTS (SELECT 1 FROM unnest(e.to_addresses) addr WHERE LOWER(addr) LIKE ${'%' + term + '%'})`
              )
              .reduce((a, b) => fastify.sql`${a} OR ${b}`)})`
          : fastify.sql``;

      // Use tagged template literals with conditional fragments
      const emails = await fastify.sql<EmailRecord[]>`
        SELECT
          e.id, e.account_id, e.message_id, e.thread_id,
          e.date, e.from_address, e.from_name, e.to_addresses, e.cc_addresses,
          e.subject, e.snippet, e.gmail_labels,
          e.analysis,
          e.planned_labels, e.gmail_action, e.digest_section,
          e.applied_labels, e.applied_gmail_action,
          e.workflow_status, e.triaged_at, e.reviewed_at, e.executed_at, e.alerted_at,
          a.identifier as account_identifier,
          a.email as account_email
        FROM google.emails e
        JOIN google.accounts a ON e.account_id = a.id
        WHERE e.date > NOW() - INTERVAL '1 day' * ${daysNum}
          ${account ? fastify.sql`AND a.identifier = ${account}` : fastify.sql``}
          ${workflow_status ? fastify.sql`AND e.workflow_status = ${workflow_status}` : fastify.sql``}
          ${messageTypes.length > 0 ? fastify.sql`AND e.analysis->>'message_type' IN ${fastify.sql(messageTypes)}` : fastify.sql``}
          ${search ? fastify.sql`AND e.search_vector @@ plainto_tsquery('english', ${search})` : fastify.sql``}
          ${withFragment}
        ORDER BY e.date DESC
        LIMIT ${limitNum} OFFSET ${offsetNum}
      `;

      // Parse JSONB fields that come back as strings
      return emails.map((email) => ({
        ...email,
        analysis: parseJsonField(email.analysis),
      }));
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

        // Parse JSONB fields
        return {
          ...email,
          analysis: parseJsonField(email.analysis),
        };
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

    // POST /google/emails/sync - Trigger email sync (async, returns immediately)
    fastify.post<{
      Body?: { account?: string; full?: boolean };
    }>('/google/emails/sync', async (request) => {
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

      // Fire and forget for all accounts (service handles duplicate prevention)
      for (const acc of accounts) {
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

      return {
        message: `Sync requested for ${accounts.length} account(s). Check GET /google/accounts for progress.`,
        accounts: accounts.map((a) => a.identifier),
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

      // POST /google/emails/triage - Triage pending emails (async, returns immediately)
      fastify.post<{
        Body?: { account?: string; limit?: number; force?: boolean };
      }>('/google/emails/triage', async (request) => {
        const { account, limit, force } = request.body || {};

        // Get pending emails (or all triageable emails if force=true).
        // force=true also bypasses the retry cap (TriageService.MAX_TRIAGE_ATTEMPTS)
        // since a manually-forced retry is a deliberate override; the
        // unforced path skips emails that have already hit the cap so a
        // manual trigger can't accidentally re-burn tokens on a
        // permanently-failing email either.
        const pending = await fastify.sql<{ id: number; account_id: number }[]>`
          SELECT e.id, e.account_id FROM google.emails e
          JOIN google.accounts a ON e.account_id = a.id
          WHERE ${force ? fastify.sql`e.workflow_status IN ('new', 'triaged')` : fastify.sql`e.workflow_status = 'new' AND e.triage_attempts < ${TriageService.MAX_TRIAGE_ATTEMPTS}`}
            ${account ? fastify.sql`AND a.identifier = ${account}` : fastify.sql``}
          ORDER BY e.date DESC
          ${limit ? fastify.sql`LIMIT ${limit}` : fastify.sql``}
        `;

        if (pending.length === 0) {
          return { message: 'No pending emails to triage', count: 0 };
        }

        const accountIds = [...new Set(pending.map((e) => e.account_id))];

        // Fire and forget - don't await (service handles duplicate prevention)
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

      // GET /google/emails/triage/progress - Triage progress
      fastify.get('/google/emails/triage/progress', async () => {
        const [stats] = await fastify.sql<{
          discovered: string;
          new: string;
          triaged: string;
          with_errors: string;
          retry_capped: string;
        }[]>`
          SELECT
            COUNT(*) FILTER (WHERE workflow_status = 'discovered') as discovered,
            COUNT(*) FILTER (WHERE workflow_status = 'new') as new,
            COUNT(*) FILTER (WHERE workflow_status = 'triaged') as triaged,
            COUNT(*) FILTER (WHERE last_error IS NOT NULL) as with_errors,
            COUNT(*) FILTER (WHERE workflow_status = 'new' AND triage_attempts >= ${TriageService.MAX_TRIAGE_ATTEMPTS}) as retry_capped
          FROM google.emails
          WHERE date > NOW() - INTERVAL '7 days'
        `;

        return {
          discovered: parseInt(stats?.discovered || '0', 10),
          new: parseInt(stats?.new || '0', 10),
          triaged: parseInt(stats?.triaged || '0', 10),
          with_errors: parseInt(stats?.with_errors || '0', 10),
          // Emails stuck at workflow_status='new' that hit MAX_TRIAGE_ATTEMPTS -
          // the scheduler has stopped retrying these; they need a code fix or
          // a manual force=true retry via POST /google/emails/triage.
          retry_capped: parseInt(stats?.retry_capped || '0', 10),
        };
      });
    }

    // ==========================================
    // Review + Execute (deterministic action layer)
    // ==========================================

    // PATCH /google/emails/:id - edit the staged plan during review
    fastify.patch<{
      Params: { id: string };
      Body: {
        planned_labels?: string[];
        gmail_action?: string;
        digest_section?: string;
      };
    }>('/google/emails/:id', async (request, reply) => {
      const emailId = parseInt(request.params.id, 10);
      const { planned_labels, gmail_action, digest_section } = request.body;

      const [email] = await fastify.sql<EmailRecord[]>`
        UPDATE google.emails SET
          planned_labels = COALESCE(${planned_labels ?? null}, planned_labels),
          gmail_action = COALESCE(${gmail_action ?? null}, gmail_action),
          digest_section = COALESCE(${digest_section ?? null}, digest_section),
          workflow_status = 'reviewed',
          reviewed_at = NOW()
        WHERE id = ${emailId}
        RETURNING *
      `;
      if (!email) return reply.status(404).send({ error: 'Email not found' });
      return { ...email, analysis: parseJsonField(email.analysis) };
    });

    // POST /google/emails/execute - confirm-to-execute the staged plans
    // Body: { email_ids: number[], apply_labels?, apply_gmail_action? }
    fastify.post<{
      Body: {
        email_ids: number[];
        apply_labels?: boolean;
        apply_gmail_action?: boolean;
      };
    }>('/google/emails/execute', async (request, reply) => {
      if (!executorService) {
        return reply
          .status(503)
          .send({ error: 'Executor not available (email actions disabled)' });
      }
      const { email_ids, apply_labels, apply_gmail_action } = request.body || {};
      if (!Array.isArray(email_ids) || email_ids.length === 0) {
        return reply.status(400).send({ error: 'email_ids array required' });
      }
      const results = await executorService.executeEmails(email_ids, {
        applyLabels: apply_labels,
        applyGmailAction: apply_gmail_action,
      });
      const succeeded = results.filter((r) => r.success).length;
      return {
        requested: email_ids.length,
        succeeded,
        failed: results.length - succeeded,
        results,
      };
    });

    // GET /google/emails/digest - preview the assembled daily digest (the same
    // priority-first sections the page renders + the notification headline).
    fastify.get('/google/emails/digest', async (_request, reply) => {
      if (!digestService) {
        return reply.status(503).send({ error: 'Digest not available (email actions disabled)' });
      }
      const sections = await digestService.assemble();
      const emailIds = sections.flatMap((s) => s.items.map((i) => i.id));
      const { title, needResponse, toConfirm } = digestHeadline(sections);
      return { count: emailIds.length, emailIds, headline: title, needResponse, toConfirm, sections };
    });

    // GET /google/emails/digest/pending - the priority-first assembled sections
    // for the interactive page: actionable (listed) → digest categories
    // (summarized, expandable) → archive → spam. Whitelisted senders are already
    // filtered out by the service (they have standing, so they stop being asked).
    fastify.get('/google/emails/digest/pending', async (_request, reply) => {
      if (!digestService) {
        return reply
          .status(503)
          .send({ error: 'Digest not available (email actions disabled)' });
      }
      const sections = await digestService.assemble();
      const count = sections.reduce((n, s) => n + s.count, 0);
      return { count, sections };
    });

    // GET /google/emails/digest/history - recently executed actions (applied_*
    // columns) for the page's confidence list. ?days=7 by default.
    fastify.get<{ Querystring: { days?: string } }>(
      '/google/emails/digest/history',
      async (request, reply) => {
        if (!digestService) {
          return reply
            .status(503)
            .send({ error: 'Digest not available (email actions disabled)' });
        }
        const days = parseInt(request.query.days ?? '7', 10) || 7;
        const rows = (await digestService.loadRecentExecuted(days)).map((r) => ({
          ...r,
          analysis: parseJsonField(r.analysis),
        }));
        return { count: rows.length, days, emails: rows };
      }
    );

    // ==========================================
    // Sender standing + classification refinements (digest v2 affordances)
    // ==========================================

    // GET /google/senders/standing - list sender standings (?standing=whitelist
    // | unsubscribe_queue). The unsubscribe_queue list is the future
    // unsubscribe automation's only source.
    fastify.get<{ Querystring: { standing?: SenderStanding } }>(
      '/google/senders/standing',
      async (request, reply) => {
        if (!senderStandingStore) {
          return reply.status(503).send({ error: 'Sender standing not available' });
        }
        const rows = await senderStandingStore.list(request.query.standing);
        return { count: rows.length, standings: rows };
      }
    );

    // POST /google/senders/standing - set a sender's standing (whitelist stops
    // asking about them; unsubscribe_queue feeds the unsubscribe automation).
    fastify.post<{
      Body: { sender_email?: string; standing?: SenderStanding; source?: string };
    }>('/google/senders/standing', async (request, reply) => {
      if (!senderStandingStore) {
        return reply.status(503).send({ error: 'Sender standing not available' });
      }
      const { sender_email, standing, source } = request.body ?? {};
      if (!sender_email || (standing !== 'whitelist' && standing !== 'unsubscribe_queue')) {
        return reply
          .status(400)
          .send({ error: 'sender_email and standing (whitelist|unsubscribe_queue) required' });
      }
      const row = await senderStandingStore.set(sender_email, standing, source);
      return row;
    });

    // POST /google/emails/:id/reclassify - reclassify one email + queue the
    // correction. The reclassification takes effect for THIS email immediately
    // (its digest placement / staged action is updated inline), but NO triage
    // rule or prompt is modified — the refinement queue is drained separately in
    // a deliberate interactive revision session.
    fastify.post<{
      Params: { id: string };
      Body: { to_class: string; digest_section?: string; gmail_action?: string; note?: string };
    }>('/google/emails/:id/reclassify', async (request, reply) => {
      if (!refinementStore) {
        return reply.status(503).send({ error: 'Refinements not available' });
      }
      const emailId = parseInt(request.params.id, 10);
      const { to_class, digest_section, gmail_action, note } = request.body ?? {};
      if (!to_class) {
        return reply.status(400).send({ error: 'to_class required' });
      }

      // Capture the current placement for the from_class provenance.
      const [current] = await fastify.sql<
        { digest_section: string | null; gmail_action: string | null }[]
      >`SELECT digest_section, gmail_action FROM google.emails WHERE id = ${emailId}`;
      if (!current) return reply.status(404).send({ error: 'Email not found' });
      const fromClass = current.digest_section ?? current.gmail_action ?? null;

      // Append the correction (append-only; never mutates rules/prompts).
      const refinement = await refinementStore.append({
        emailId,
        fromClass,
        toClass: to_class,
        note,
      });

      // Immediate single-email placement fix (digest_section / staged action).
      const [email] = await fastify.sql<EmailRecord[]>`
        UPDATE google.emails SET
          digest_section = COALESCE(${digest_section ?? null}, digest_section),
          gmail_action = COALESCE(${gmail_action ?? null}, gmail_action),
          workflow_status = 'reviewed',
          reviewed_at = NOW()
        WHERE id = ${emailId}
        RETURNING *
      `;

      return {
        refinement,
        email: email ? { ...email, analysis: parseJsonField(email.analysis) } : null,
      };
    });

    // GET /google/refinements - pending classification refinements as clean
    // JSON for an external interactive revision session. ?status=resolved to
    // inspect drained entries.
    fastify.get<{ Querystring: { status?: string } }>(
      '/google/refinements',
      async (request, reply) => {
        if (!refinementStore) {
          return reply.status(503).send({ error: 'Refinements not available' });
        }
        // Only 'pending' is a first-class list (the queue to drain); anything
        // else returns an empty list rather than leaking the full history here.
        const rows =
          (request.query.status ?? 'pending') === 'pending'
            ? await refinementStore.listPending()
            : [];
        return { count: rows.length, refinements: rows };
      }
    );

    // PATCH /google/refinements/:id - resolve a refinement with what changed
    // (the interactive session marks each entry done, incl. "noted, no change").
    fastify.patch<{
      Params: { id: string };
      Body: { resolution?: string };
    }>('/google/refinements/:id', async (request, reply) => {
      if (!refinementStore) {
        return reply.status(503).send({ error: 'Refinements not available' });
      }
      const id = parseInt(request.params.id, 10);
      const resolution = request.body?.resolution ?? 'noted, no change';
      const row = await refinementStore.resolve(id, resolution);
      if (!row) return reply.status(404).send({ error: 'Refinement not found' });
      return row;
    });

    // ==========================================
    // Bulk Actions
    // ==========================================

    // POST /google/emails/bulk-action - Process bulk email actions
    fastify.post<{
      Body: { emailIds: number[]; action: string };
    }>('/google/emails/bulk-action', async (request) => {
      const { emailIds, action } = request.body;

      if (!Array.isArray(emailIds) || emailIds.length === 0) {
        return {
          success: false,
          action: action || '',
          count: 0,
          message: 'emailIds array required',
          error: 'emailIds array required',
        };
      }

      // Handle force-retriage action
      if (action === 'force-retriage') {
        if (!triageService) {
          return {
            success: false,
            action,
            count: 0,
            message: 'Triage service not available',
            error: 'Triage service not available (missing ANTHROPIC_API_KEY)',
          };
        }

        // Fire and forget - async processing
        triageService
          .triageBatch(emailIds)
          .then((results) => {
            const success = results.filter((r) => r.success).length;
            const failed = results.filter((r) => !r.success).length;
            fastify.log.info(
              { count: emailIds.length, success, failed },
              'Bulk force-retriage complete'
            );
          })
          .catch((error) => {
            fastify.log.error({ error }, 'Bulk force-retriage failed');
          });

        return {
          success: true,
          action,
          count: emailIds.length,
          message: `Re-triage started for ${emailIds.length} email(s)`,
        };
      }

      // Placeholder for other actions
      fastify.log.info({ emailIds, action }, 'Bulk action requested (no-op)');

      return {
        success: true,
        action,
        count: emailIds.length,
        message: `Bulk action "${action}" received for ${emailIds.length} email(s) (no-op placeholder)`,
      };
    });
  };
