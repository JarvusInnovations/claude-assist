/**
 * Gmail Executor — the deterministic execute path.
 *
 * Applies staged triage plans to Gmail: creates + applies the `AI/*` and
 * `TODO/*` label trees, and performs archive / spam moves. There is NO model
 * call anywhere in this file — it only reads `planned_labels` / `gmail_action`
 * off already-triaged rows and writes the `applied_*` columns back.
 *
 * Guardrails (execution acts destructively on a real mailbox):
 *   - `spam` moves the message to Gmail's Spam folder, NEVER trash/delete it.
 *   - A whitelisted human sender's personal mail is never quarantined as spam,
 *     even if a rule/model mislabeled it — the action is downgraded to `leave`.
 *   - Nothing runs unless the caller confirmed it (the execute endpoint / CLI);
 *     there is no autonomous execution in v1.
 */

import type { gmail_v1 } from 'googleapis';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { HeartbeatRegistry } from '@jarvus/claude-assist-core';
import type { GmailAuthService } from './gmail-auth.js';
import type { WhitelistService } from './whitelist.js';
import type { EmailAnalysis, ExecuteResult, GmailAction } from '../types.js';

/** Row the executor reads for each email it's asked to act on. */
interface ExecutableRow {
  id: number;
  account_id: number;
  message_id: string;
  from_address: string | null;
  planned_labels: string[] | null;
  gmail_action: GmailAction | null;
  analysis: EmailAnalysis | null;
  workflow_status: string;
}

export interface ExecuteOptions {
  /** Apply the planned labels (default true). */
  applyLabels?: boolean;
  /** Apply the gmail_action archive/spam move (default true). */
  applyGmailAction?: boolean;
}

export interface GmailExecutorConfig {
  disableEmailActions?: boolean;
}

export interface GmailLabelMutation {
  addLabelIds: string[];
  removeLabelIds: string[];
}

/**
 * Pure: turn resolved label ids + a gmail_action into the Gmail modify request.
 * `archive` drops INBOX; `spam` adds SPAM and drops INBOX (never TRASH).
 */
export function buildLabelMutation(
  labelIds: string[],
  gmailAction: GmailAction
): GmailLabelMutation {
  const add = new Set<string>(labelIds);
  const remove = new Set<string>();

  if (gmailAction === 'archive') {
    remove.add('INBOX');
  } else if (gmailAction === 'spam') {
    add.add('SPAM');
    remove.add('INBOX');
  }

  return { addLabelIds: [...add], removeLabelIds: [...remove] };
}

export class GmailExecutorService {
  private sql: postgres.Sql;
  private log: FastifyBaseLogger;
  private authService: GmailAuthService;
  private whitelistService: WhitelistService;
  private heartbeats: HeartbeatRegistry | undefined;
  private disableEmailActions: boolean;

  /** Per-account label name → id cache, populated lazily from labels.list. */
  private labelCache = new Map<number, Map<string, string>>();

  constructor(
    sql: postgres.Sql,
    log: FastifyBaseLogger,
    authService: GmailAuthService,
    whitelistService: WhitelistService,
    config: GmailExecutorConfig = {},
    heartbeats?: HeartbeatRegistry
  ) {
    this.sql = sql;
    this.log = log;
    this.authService = authService;
    this.whitelistService = whitelistService;
    this.heartbeats = heartbeats;
    this.disableEmailActions = config.disableEmailActions ?? false;
  }

  /**
   * Execute the staged plans for a set of email ids. Groups by account so the
   * Gmail client, label cache, and whitelist are resolved once per account.
   */
  async executeEmails(
    emailIds: number[],
    options: ExecuteOptions = {}
  ): Promise<ExecuteResult[]> {
    if (this.disableEmailActions) {
      this.log.info('Email actions disabled via disableEmailActions config');
      return emailIds.map((id) => ({
        emailId: id,
        success: false,
        reason: 'email actions disabled',
      }));
    }
    if (emailIds.length === 0) return [];

    const rows = await this.sql<ExecutableRow[]>`
      SELECT id, account_id, message_id, from_address,
             planned_labels, gmail_action, analysis, workflow_status
      FROM google.emails
      WHERE id = ANY(${emailIds})
    `;

    const byAccount = new Map<number, ExecutableRow[]>();
    for (const row of rows) {
      const list = byAccount.get(row.account_id) ?? [];
      list.push(row);
      byAccount.set(row.account_id, list);
    }

    const results: ExecuteResult[] = [];
    let anySuccess = false;

    for (const [accountId, accountRows] of byAccount) {
      let gmail: gmail_v1.Gmail;
      let whitelist: Set<string>;
      try {
        gmail = await this.authService.getGmailClient(accountId);
        whitelist = await this.whitelistService.deriveWhitelist(accountId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error({ accountId, error }, 'Executor: account setup failed');
        for (const row of accountRows) {
          results.push({ emailId: row.id, success: false, error: message });
        }
        continue;
      }

      for (const row of accountRows) {
        results.push(
          await this.executeRow(gmail, accountId, row, whitelist, options)
        );
        if (results[results.length - 1]!.success) anySuccess = true;
      }
    }

    // Coverage heartbeat: the executor ran to completion this invocation.
    if (anySuccess) {
      await this.heartbeats?.beat('email-actions', { threshold: '48 hours' });
    }

    return results;
  }

  private async executeRow(
    gmail: gmail_v1.Gmail,
    accountId: number,
    row: ExecutableRow,
    whitelist: Set<string>,
    options: ExecuteOptions
  ): Promise<ExecuteResult> {
    const applyLabels = options.applyLabels ?? true;
    const applyGmailAction = options.applyGmailAction ?? true;

    try {
      const plannedLabels = row.planned_labels ?? [];
      let gmailAction: GmailAction = row.gmail_action ?? 'leave';
      let guardNote: string | null = null;

      // Guardrail: never quarantine a whitelisted human's personal mail.
      if (
        gmailAction === 'spam' &&
        row.from_address &&
        whitelist.has(row.from_address.toLowerCase()) &&
        row.analysis?.message_type === 'personal'
      ) {
        gmailAction = 'leave';
        guardNote =
          'spam downgraded to leave: whitelisted sender, personal message';
        this.log.warn(
          { emailId: row.id, from: row.from_address },
          'Executor guardrail: refusing to spam whitelisted personal sender'
        );
      }

      // Resolve label names → ids (creating the AI/* + TODO/* trees as needed).
      const labelIds = applyLabels
        ? await this.ensureLabels(gmail, accountId, plannedLabels)
        : [];

      const effectiveAction: GmailAction = applyGmailAction ? gmailAction : 'leave';
      const mutation = buildLabelMutation(labelIds, effectiveAction);

      if (mutation.addLabelIds.length > 0 || mutation.removeLabelIds.length > 0) {
        await gmail.users.messages.modify({
          userId: 'me',
          id: row.message_id,
          requestBody: {
            addLabelIds: mutation.addLabelIds,
            removeLabelIds: mutation.removeLabelIds,
          },
        });
      }

      const appliedLabels = applyLabels ? plannedLabels : [];
      await this.sql`
        UPDATE google.emails SET
          applied_labels = ${appliedLabels},
          applied_gmail_action = ${effectiveAction},
          workflow_status = 'executed',
          executed_at = NOW(),
          applied_at = NOW(),
          execution_notes = ${guardNote},
          execution_error = NULL,
          execution_error_at = NULL
        WHERE id = ${row.id}
      `;

      this.log.info(
        { emailId: row.id, appliedLabels, gmailAction: effectiveAction },
        'Executor applied plan'
      );

      return {
        emailId: row.id,
        success: true,
        appliedLabels,
        appliedGmailAction: effectiveAction,
        ...(guardNote ? { skipped: true, reason: guardNote } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error({ emailId: row.id, error }, 'Executor failed for email');
      await this.sql`
        UPDATE google.emails SET
          execution_error = ${message}, execution_error_at = NOW()
        WHERE id = ${row.id}
      `;
      return { emailId: row.id, success: false, error: message };
    }
  }

  /**
   * Resolve a set of full nested label paths to Gmail label ids, creating any
   * that don't exist (ancestors first, so `AI/Type/Newsletter` also
   * materializes `AI` and `AI/Type` as real labels). Idempotent.
   */
  async ensureLabels(
    gmail: gmail_v1.Gmail,
    accountId: number,
    names: string[]
  ): Promise<string[]> {
    if (names.length === 0) return [];

    let cache = this.labelCache.get(accountId);
    if (!cache) {
      cache = new Map<string, string>();
      const resp = await gmail.users.labels.list({ userId: 'me' });
      for (const label of resp.data.labels ?? []) {
        if (label.name && label.id) cache.set(label.name, label.id);
      }
      this.labelCache.set(accountId, cache);
    }

    const ids: string[] = [];
    for (const name of names) {
      // Ensure every ancestor path exists, then the leaf.
      const segments = name.split('/');
      let path = '';
      let leafId = '';
      for (let i = 0; i < segments.length; i++) {
        path = i === 0 ? segments[i]! : `${path}/${segments[i]}`;
        leafId = await this.ensureLabel(gmail, cache, path);
      }
      ids.push(leafId);
    }
    return ids;
  }

  private async ensureLabel(
    gmail: gmail_v1.Gmail,
    cache: Map<string, string>,
    name: string
  ): Promise<string> {
    const existing = cache.get(name);
    if (existing) return existing;

    try {
      const created = await gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
        },
      });
      const id = created.data.id!;
      cache.set(name, id);
      return id;
    } catch (error) {
      // A concurrent run may have created it (409). Re-list to recover the id.
      const resp = await gmail.users.labels.list({ userId: 'me' });
      for (const label of resp.data.labels ?? []) {
        if (label.name && label.id) cache.set(label.name, label.id);
      }
      const recovered = cache.get(name);
      if (recovered) return recovered;
      throw error;
    }
  }
}
