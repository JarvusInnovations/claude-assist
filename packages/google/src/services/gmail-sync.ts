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

export class GmailSyncService {
  private sql: postgres.Sql;
  private log: FastifyBaseLogger;
  private authService: GmailAuthService;

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
   * Full sync: Fetch untriaged inbox emails
   */
  async syncFull(accountId: number): Promise<SyncResult> {
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

      // List all messages
      const messageIds = await this.listAllMessages(gmail, query);
      result.messagesScanned = messageIds.length;

      this.log.info(
        { accountId, count: messageIds.length, query },
        'Found messages to sync'
      );

      // Fetch and store each message
      for (const messageId of messageIds) {
        try {
          const email = await this.fetchMessage(gmail, messageId);
          const stored = await this.storeEmail(accountId, email);

          if (stored === 'new') {
            result.messagesIngested++;
          } else if (stored === 'updated') {
            result.messagesUpdated++;
          } else {
            result.messagesSkipped++;
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          result.errors.push(`Message ${messageId}: ${errorMessage}`);
          this.log.error({ messageId, error }, 'Failed to sync message');
        }
      }

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
      const changedMessageIds = await this.getHistoryChanges(
        gmail,
        account.history_id
      );

      result.messagesScanned = changedMessageIds.length;

      this.log.info(
        { accountId, count: changedMessageIds.length },
        'Found changed messages'
      );

      // Fetch and store each changed message
      for (const messageId of changedMessageIds) {
        try {
          const email = await this.fetchMessage(gmail, messageId);
          const stored = await this.storeEmail(accountId, email);

          if (stored === 'new') {
            result.messagesIngested++;
          } else if (stored === 'updated') {
            result.messagesUpdated++;
          } else {
            result.messagesSkipped++;
          }
        } catch (error) {
          // Message might have been deleted
          if (
            error instanceof Error &&
            error.message.includes('Requested entity was not found')
          ) {
            result.messagesSkipped++;
            continue;
          }
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          result.errors.push(`Message ${messageId}: ${errorMessage}`);
        }
      }

      // Update history_id
      const profile = await gmail.users.getProfile({ userId: 'me' });
      const historyId = profile.data.historyId;

      await this.sql`
        UPDATE google.accounts
        SET last_sync_at = NOW(), history_id = ${historyId ?? null}
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
   * List all message IDs matching a query
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
