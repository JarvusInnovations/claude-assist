/**
 * Gmail Sync Service
 *
 * Syncs emails from Gmail API to the database:
 * - Full sync: Fetches all emails from the last N days
 * - Incremental sync: Uses historyId for delta updates
 * - Always fetches full body content for AI triage
 */

import type { gmail_v1 } from 'googleapis';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { GmailAuthService } from './gmail-auth.js';
import type { GoogleAccount, SyncResult } from '../types.js';

// Settings fields from GoogleAccount used for sync
type AccountSettings = Pick<
  GoogleAccount,
  'label_prefix_tracking' | 'sync_start_date'
>;

interface ParsedEmail {
  messageId: string;
  threadId: string | null;
  date: Date | null;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string | null;
  snippet: string | null;
  gmailLabels: string[];
  bodyText: string | null;
  bodyHtml: string | null;
  hasAttachments: boolean;
}

export interface SyncStatus {
  syncing: boolean;
  startedAt: Date | null;
  type: 'full' | 'incremental' | null;
  phase: 'discovering' | 'fetching' | null;
  discovered: number | null;  // Messages found in phase 1
  fetched: number | null;     // Messages fetched in phase 2
}

interface ActiveSyncState {
  startedAt: Date;
  type: 'full' | 'incremental';
  phase: 'discovering' | 'fetching';
  discovered: number;
  fetched: number;
}

export class GmailSyncService {
  private sql: postgres.Sql;
  private log: FastifyBaseLogger;
  private authService: GmailAuthService;
  private activeSyncs = new Map<number, ActiveSyncState>();

  constructor(
    sql: postgres.Sql,
    log: FastifyBaseLogger,
    authService: GmailAuthService
  ) {
    this.sql = sql;
    this.log = log;
    this.authService = authService;
  }

  /**
   * Get sync status for an account
   */
  getSyncStatus(accountId: number): SyncStatus {
    const active = this.activeSyncs.get(accountId);
    return active
      ? {
          syncing: true,
          startedAt: active.startedAt,
          type: active.type,
          phase: active.phase,
          discovered: active.discovered,
          fetched: active.fetched,
        }
      : { syncing: false, startedAt: null, type: null, phase: null, discovered: null, fetched: null };
  }

  /**
   * Get sync status for all accounts
   */
  getAllSyncStatuses(): Map<number, SyncStatus> {
    const result = new Map<number, SyncStatus>();
    for (const [accountId, status] of this.activeSyncs) {
      result.set(accountId, {
        syncing: true,
        startedAt: status.startedAt,
        type: status.type,
        phase: status.phase,
        discovered: status.discovered,
        fetched: status.fetched,
      });
    }
    return result;
  }

  /**
   * Full sync: Fetch untriaged inbox emails
   */
  async syncFull(accountId: number): Promise<SyncResult> {
    this.activeSyncs.set(accountId, {
      startedAt: new Date(),
      type: 'full',
      phase: 'discovering',
      discovered: 0,
      fetched: 0,
    });

    try {
      return await this.doSyncFull(accountId);
    } finally {
      this.activeSyncs.delete(accountId);
    }
  }

  private async doSyncFull(accountId: number): Promise<SyncResult> {
    const gmail = await this.authService.getGmailClient(accountId);
    const settings = await this.getAccountSettings(accountId);
    const labelPrefix = settings?.label_prefix_tracking ?? 'AI';

    const result: SyncResult = {
      messagesScanned: 0,
      messagesIngested: 0,
      messagesUpdated: 0,
      messagesSkipped: 0,
      errors: [],
    };

    try {
      // Build query: inbox emails not yet triaged
      let query = `in:inbox -label:${labelPrefix}/Triaged`;

      // Add start date filter if configured
      if (settings?.sync_start_date) {
        // Gmail uses YYYY/MM/DD format for after:
        // Handle both Date objects (from postgres.js) and strings
        const date = new Date(settings.sync_start_date as unknown as string | Date);
        const dateStr = date.toISOString().split('T')[0]!.replace(/-/g, '/');
        query += ` after:${dateStr}`;
      }

      // PHASE 1: Discover all message IDs (batch insert as 'discovered')
      const { discovered, skipped } = await this.discoverMessages(
        accountId,
        gmail,
        query
      );
      result.messagesScanned = discovered + skipped;
      result.messagesSkipped = skipped;

      // Update status with discovered count and transition to fetching phase
      const status = this.activeSyncs.get(accountId);
      if (status) {
        status.discovered = discovered;
        status.phase = 'fetching';
      }

      this.log.info(
        { accountId, discovered, skipped, query },
        'Phase 1 complete: Messages discovered'
      );

      // PHASE 2: Fetch full content for discovered messages
      const { fetched, errors } = await this.fetchDiscoveredMessages(
        accountId,
        gmail
      );
      result.messagesIngested = fetched;
      result.errors = errors;

      // Update status with fetched count
      if (status) {
        status.fetched = fetched;
      }

      this.log.info(
        { accountId, fetched, errors: errors.length },
        'Phase 2 complete: Messages fetched'
      );

      // Update last sync timestamp and get latest historyId
      const profile = await gmail.users.getProfile({ userId: 'me' });
      const historyId = profile.data.historyId;

      await this.sql`
        UPDATE google.accounts
        SET last_sync_at = NOW(), history_id = ${historyId ?? null}
        WHERE id = ${accountId}
      `;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      result.errors.push(`Sync failed: ${errorMessage}`);
      this.log.error({ accountId, error }, 'Full sync failed');
    }

    return result;
  }

  /**
   * Incremental sync: Use historyId for delta updates
   */
  async syncIncremental(accountId: number): Promise<SyncResult> {
    const [account] = await this.sql<{ history_id: string | null }[]>`
      SELECT history_id FROM google.accounts WHERE id = ${accountId}
    `;

    // Fall back to full sync if no history_id
    if (!account?.history_id) {
      this.log.info({ accountId }, 'No history_id, falling back to full sync');
      return this.syncFull(accountId);
    }

    this.activeSyncs.set(accountId, {
      startedAt: new Date(),
      type: 'incremental',
      phase: 'discovering',
      discovered: 0,
      fetched: 0,
    });

    try {
      return await this.doSyncIncremental(accountId, account.history_id);
    } finally {
      this.activeSyncs.delete(accountId);
    }
  }

  private async doSyncIncremental(accountId: number, historyId: string): Promise<SyncResult> {
    const gmail = await this.authService.getGmailClient(accountId);

    const result: SyncResult = {
      messagesScanned: 0,
      messagesIngested: 0,
      messagesUpdated: 0,
      messagesSkipped: 0,
      errors: [],
    };

    try {
      // Get history since last sync
      const changedMessageIds = await this.getHistoryChanges(gmail, historyId);
      result.messagesScanned = changedMessageIds.length;

      this.log.info(
        { accountId, count: changedMessageIds.length },
        'Found changed messages'
      );

      // Update status with discovered count
      const status = this.activeSyncs.get(accountId);
      if (status) {
        status.discovered = changedMessageIds.length;
      }

      if (changedMessageIds.length > 0) {
        // Process changes - handles both new messages and label updates
        const changes = await this.processIncrementalChanges(
          accountId,
          gmail,
          changedMessageIds
        );

        result.messagesIngested = changes.ingested;
        result.messagesUpdated = changes.updated;
        result.messagesSkipped = changes.skipped;
        result.errors = changes.errors;

        // Transition to fetching phase
        if (status) {
          status.phase = 'fetching';
        }

        // Fetch full content for any newly discovered messages
        const { fetched, errors } = await this.fetchDiscoveredMessages(
          accountId,
          gmail
        );
        result.messagesIngested += fetched;
        result.errors.push(...errors);

        // Update status with fetched count
        if (status) {
          status.fetched = fetched;
        }
      }

      // Update history_id
      const profile = await gmail.users.getProfile({ userId: 'me' });
      const newHistoryId = profile.data.historyId;

      await this.sql`
        UPDATE google.accounts
        SET last_sync_at = NOW(), history_id = ${newHistoryId ?? null}
        WHERE id = ${accountId}
      `;
    } catch (error) {
      // History might be expired, fall back to full sync
      if (
        error instanceof Error &&
        (error.message.includes('historyId') ||
          error.message.includes('Start historyId'))
      ) {
        this.log.info({ accountId }, 'History expired, falling back to full sync');
        return this.syncFull(accountId);
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      result.errors.push(`Incremental sync failed: ${errorMessage}`);
      this.log.error({ accountId, error }, 'Incremental sync failed');
    }

    return result;
  }

  /**
   * Phase 1: Discover all message IDs and batch-insert as 'discovered'
   * Pages through Gmail list results and writes to DB immediately
   */
  private async discoverMessages(
    accountId: number,
    gmail: gmail_v1.Gmail,
    query: string
  ): Promise<{ discovered: number; skipped: number }> {
    let discovered = 0;
    let skipped = 0;
    let pageToken: string | undefined;

    do {
      const response = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        pageToken,
        maxResults: 500,
      });

      const messages = response.data.messages || [];
      if (messages.length > 0) {
        // Batch upsert - ON CONFLICT DO NOTHING for idempotency
        const result = await this.batchUpsertDiscovered(accountId, messages);
        discovered += result.inserted;
        skipped += result.skipped;
      }

      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return { discovered, skipped };
  }

  /**
   * Batch insert discovered message IDs with ON CONFLICT DO NOTHING
   * This is idempotent - re-running won't duplicate or overwrite existing data
   */
  private async batchUpsertDiscovered(
    accountId: number,
    messages: Array<{ id?: string | null; threadId?: string | null }>
  ): Promise<{ inserted: number; skipped: number }> {
    if (messages.length === 0) {
      return { inserted: 0, skipped: 0 };
    }

    // Filter out any messages without IDs
    const validMessages = messages.filter(
      (m): m is { id: string; threadId?: string | null } => !!m.id
    );

    if (validMessages.length === 0) {
      return { inserted: 0, skipped: 0 };
    }

    const result = await this.sql`
      INSERT INTO google.emails (account_id, message_id, thread_id, workflow_status)
      SELECT * FROM UNNEST(
        ${this.sql.array(validMessages.map(() => accountId))}::integer[],
        ${this.sql.array(validMessages.map((m) => m.id))}::text[],
        ${this.sql.array(validMessages.map((m) => m.threadId ?? null))}::text[],
        ${this.sql.array(validMessages.map(() => 'discovered'))}::google.workflow_status[]
      )
      ON CONFLICT (account_id, message_id) DO NOTHING
      RETURNING id
    `;

    const inserted = result.length;
    const skipped = validMessages.length - inserted;

    return { inserted, skipped };
  }

  /**
   * Process incremental changes - handles both new messages and label updates
   */
  private async processIncrementalChanges(
    accountId: number,
    gmail: gmail_v1.Gmail,
    messageIds: string[]
  ): Promise<{
    ingested: number;
    updated: number;
    skipped: number;
    errors: string[];
  }> {
    let ingested = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const messageId of messageIds) {
      // Check if message exists and its current state
      const [existing] = await this.sql<
        { id: number; workflow_status: string; gmail_labels: string[] }[]
      >`
        SELECT id, workflow_status, gmail_labels FROM google.emails
        WHERE account_id = ${accountId} AND message_id = ${messageId}
      `;

      if (existing && existing.workflow_status !== 'discovered') {
        // Existing message - fetch to check for label changes
        try {
          const email = await this.fetchMessage(gmail, messageId);
          const existingLabels: string[] = Array.isArray(existing.gmail_labels)
            ? existing.gmail_labels
            : [];
          const labelsChanged =
            JSON.stringify([...existingLabels].sort()) !==
            JSON.stringify([...email.gmailLabels].sort());

          if (labelsChanged) {
            await this.sql`
              UPDATE google.emails SET gmail_labels = ${this.sql.json(email.gmailLabels)}
              WHERE id = ${existing.id}
            `;
            updated++;
          } else {
            skipped++;
          }
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes('Requested entity was not found')
          ) {
            skipped++;
          } else {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            errors.push(`Message ${messageId}: ${errorMessage}`);
          }
        }
      } else if (!existing) {
        // New message - insert as discovered, will be fetched in phase 2
        await this.sql`
          INSERT INTO google.emails (account_id, message_id, workflow_status)
          VALUES (${accountId}, ${messageId}, 'discovered')
        `;
        ingested++;
      }
      // If existing with 'discovered' status, it will be picked up in phase 2
    }

    return { ingested, updated, skipped, errors };
  }

  /**
   * Phase 2: Fetch full content for messages in 'discovered' status
   */
  private async fetchDiscoveredMessages(
    accountId: number,
    gmail: gmail_v1.Gmail,
    batchSize: number = 50
  ): Promise<{ fetched: number; errors: string[] }> {
    let fetched = 0;
    const errors: string[] = [];

    while (true) {
      // Get next batch of discovered messages
      const discovered = await this.sql<{ id: number; message_id: string }[]>`
        SELECT id, message_id FROM google.emails
        WHERE account_id = ${accountId} AND workflow_status = 'discovered'
        ORDER BY id
        LIMIT ${batchSize}
      `;

      if (discovered.length === 0) {
        break; // All done
      }

      // Fetch and update each message
      for (const row of discovered) {
        try {
          const email = await this.fetchMessage(gmail, row.message_id);
          await this.updateWithFullContent(row.id, email);
          fetched++;
        } catch (error) {
          // Handle deleted messages gracefully
          if (
            error instanceof Error &&
            error.message.includes('Requested entity was not found')
          ) {
            // Message was deleted - remove the discovered record
            await this.sql`DELETE FROM google.emails WHERE id = ${row.id}`;
            continue;
          }

          const errorMessage =
            error instanceof Error ? error.message : String(error);
          errors.push(`Message ${row.message_id}: ${errorMessage}`);
          this.log.error(
            { messageId: row.message_id, error },
            'Failed to fetch message'
          );
        }
      }
    }

    return { fetched, errors };
  }

  /**
   * Update a discovered message with full content and transition to 'new'
   */
  private async updateWithFullContent(
    emailId: number,
    email: ParsedEmail
  ): Promise<void> {
    await this.sql`
      UPDATE google.emails SET
        date = ${email.date},
        from_address = ${email.fromAddress},
        from_name = ${email.fromName},
        to_addresses = ${email.toAddresses},
        cc_addresses = ${email.ccAddresses},
        subject = ${email.subject},
        snippet = ${email.snippet},
        gmail_labels = ${this.sql.json(email.gmailLabels)},
        body_text = ${email.bodyText},
        body_html = ${email.bodyHtml},
        has_attachments = ${email.hasAttachments},
        workflow_status = 'new',
        synced_at = NOW()
      WHERE id = ${emailId}
    `;
  }

  /**
   * List all message IDs matching a query (legacy method, kept for reference)
   */
  private async listAllMessages(
    gmail: gmail_v1.Gmail,
    query: string
  ): Promise<string[]> {
    const messageIds: string[] = [];
    let pageToken: string | undefined;

    do {
      const response = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        pageToken,
        maxResults: 500,
      });

      const messages = response.data.messages || [];
      messageIds.push(...messages.map((m) => m.id!));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return messageIds;
  }

  /**
   * Get message IDs that changed since a given historyId
   */
  private async getHistoryChanges(
    gmail: gmail_v1.Gmail,
    startHistoryId: string
  ): Promise<string[]> {
    const messageIds = new Set<string>();
    let pageToken: string | undefined;

    do {
      const response = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        pageToken,
        historyTypes: ['messageAdded', 'labelAdded', 'labelRemoved'],
      });

      const history = response.data.history || [];
      for (const item of history) {
        // Collect message IDs from all change types
        const messages = [
          ...(item.messagesAdded?.map((m) => m.message?.id) || []),
          ...(item.labelsAdded?.map((m) => m.message?.id) || []),
          ...(item.labelsRemoved?.map((m) => m.message?.id) || []),
        ].filter((id): id is string => !!id);

        messages.forEach((id) => messageIds.add(id));
      }

      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return Array.from(messageIds);
  }

  /**
   * Fetch a single message with full content
   */
  private async fetchMessage(
    gmail: gmail_v1.Gmail,
    messageId: string
  ): Promise<ParsedEmail> {
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const message = response.data;
    const headers = message.payload?.headers || [];

    // Extract headers
    const getHeader = (name: string): string | null => {
      const header = headers.find(
        (h) => h.name?.toLowerCase() === name.toLowerCase()
      );
      return header?.value ?? null;
    };

    // Parse From header
    const fromHeader = getHeader('From');
    const fromMatch = fromHeader?.match(/^(?:"?([^"<]*)"?\s*)?<?([^>]+)>?$/);
    const fromName = fromMatch?.[1]?.trim() || null;
    const fromAddress = fromMatch?.[2]?.trim() || fromHeader;

    // Parse address lists
    const parseAddresses = (header: string | null): string[] => {
      if (!header) return [];
      return header
        .split(',')
        .map((addr) => {
          const match = addr.match(/<([^>]+)>/);
          return match?.[1]?.trim() || addr.trim();
        })
        .filter(Boolean);
    };

    // Extract body
    const { bodyText, bodyHtml } = this.extractBody(message.payload);

    // Check for attachments
    const hasAttachments = this.hasAttachments(message.payload);

    // Parse date
    const dateHeader = getHeader('Date');
    const internalDate = message.internalDate;
    let date: Date | null = null;
    if (internalDate) {
      date = new Date(parseInt(internalDate, 10));
    } else if (dateHeader) {
      date = new Date(dateHeader);
    }

    return {
      messageId: message.id!,
      threadId: message.threadId ?? null,
      date,
      fromAddress: fromAddress ?? null,
      fromName,
      toAddresses: parseAddresses(getHeader('To')),
      ccAddresses: parseAddresses(getHeader('Cc')),
      subject: getHeader('Subject'),
      snippet: message.snippet ?? null,
      gmailLabels: message.labelIds || [],
      bodyText,
      bodyHtml,
      hasAttachments,
    };
  }

  /**
   * Extract body text and HTML from message payload
   */
  private extractBody(
    payload: gmail_v1.Schema$MessagePart | undefined
  ): { bodyText: string | null; bodyHtml: string | null } {
    let bodyText: string | null = null;
    let bodyHtml: string | null = null;

    if (!payload) {
      return { bodyText, bodyHtml };
    }

    const extractFromPart = (part: gmail_v1.Schema$MessagePart) => {
      const mimeType = part.mimeType || '';
      const body = part.body?.data;

      if (body) {
        const decoded = Buffer.from(body, 'base64').toString('utf-8');

        if (mimeType === 'text/plain' && !bodyText) {
          bodyText = decoded;
        } else if (mimeType === 'text/html' && !bodyHtml) {
          bodyHtml = decoded;
        }
      }

      // Recurse into parts
      if (part.parts) {
        for (const subPart of part.parts) {
          extractFromPart(subPart);
        }
      }
    };

    extractFromPart(payload);

    // If no plain text, try to extract from HTML
    if (!bodyText && bodyHtml) {
      bodyText = this.stripHtml(bodyHtml);
    }

    return { bodyText, bodyHtml };
  }

  /**
   * Check if message has attachments
   */
  private hasAttachments(
    payload: gmail_v1.Schema$MessagePart | undefined
  ): boolean {
    if (!payload) return false;

    const checkPart = (part: gmail_v1.Schema$MessagePart): boolean => {
      if (part.filename && part.filename.length > 0) {
        return true;
      }
      if (part.parts) {
        return part.parts.some(checkPart);
      }
      return false;
    };

    return checkPart(payload);
  }

  /**
   * Simple HTML stripping for fallback plain text
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Store or update an email in the database
   */
  private async storeEmail(
    accountId: number,
    email: ParsedEmail
  ): Promise<'new' | 'updated' | 'skipped'> {
    // Check if email already exists
    const [existing] = await this.sql<{ id: number; gmail_labels: string[] }[]>`
      SELECT id, gmail_labels FROM google.emails
      WHERE account_id = ${accountId} AND message_id = ${email.messageId}
    `;

    if (existing) {
      // Parse existing labels (may be string from older data or array from JSONB)
      const existingLabels: string[] = Array.isArray(existing.gmail_labels)
        ? existing.gmail_labels
        : typeof existing.gmail_labels === 'string'
          ? JSON.parse(existing.gmail_labels)
          : [];

      // Check if labels changed (only update labels, not content)
      const labelsChanged =
        JSON.stringify([...existingLabels].sort()) !==
        JSON.stringify([...email.gmailLabels].sort());

      if (labelsChanged) {
        await this.sql`
          UPDATE google.emails
          SET gmail_labels = ${this.sql.json(email.gmailLabels)}
          WHERE id = ${existing.id}
        `;
        return 'updated';
      }

      return 'skipped';
    }

    // Insert new email
    await this.sql`
      INSERT INTO google.emails (
        account_id, message_id, thread_id, date,
        from_address, from_name, to_addresses, cc_addresses,
        subject, snippet, gmail_labels,
        body_text, body_html, has_attachments,
        workflow_status
      ) VALUES (
        ${accountId}, ${email.messageId}, ${email.threadId}, ${email.date},
        ${email.fromAddress}, ${email.fromName},
        ${email.toAddresses}, ${email.ccAddresses},
        ${email.subject}, ${email.snippet}, ${this.sql.json(email.gmailLabels)},
        ${email.bodyText}, ${email.bodyHtml}, ${email.hasAttachments},
        'new'
      )
    `;

    return 'new';
  }

  /**
   * Get account settings from accounts table
   */
  private async getAccountSettings(
    accountId: number
  ): Promise<AccountSettings | null> {
    const [account] = await this.sql<AccountSettings[]>`
      SELECT label_prefix_tracking, sync_start_date
      FROM google.accounts WHERE id = ${accountId}
    `;
    return account ?? null;
  }
}
