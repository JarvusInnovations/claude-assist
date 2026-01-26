/**
 * Triage Service
 *
 * AI-powered email triage using multi-turn Haiku conversations:
 * - Database-driven rules for pattern matching
 * - Dynamic prompts from account settings and aliases
 * - Topics of Interest scoring for RFPs and newsletters
 */

import Anthropic from '@anthropic-ai/sdk';
import pLimit from 'p-limit';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type {
  EmailRecord,
  TriageRule,
  TopicOfInterest,
  GoogleAccount,
  UserAlias,
  TriageResult,
  EmailAnalysis,
  GmailAction,
} from '../types.js';

/**
 * Error thrown when JSON parsing fails.
 * Includes the raw text for retry feedback.
 */
class JsonParseError extends Error {
  constructor(message: string, public rawText: string) {
    super(message);
    this.name = 'JsonParseError';
  }
}

/**
 * Manages a multi-turn conversation with Claude for email analysis.
 * Handles message history, API calls, and JSON parse retries internally.
 */
class AnalysisConversation {
  private messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private systemPrompt: string;
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private log: FastifyBaseLogger;
  private emailId: number;

  constructor(options: {
    systemPrompt: string;
    client: Anthropic;
    model: string;
    maxTokens: number;
    log: FastifyBaseLogger;
    emailId: number;
  }) {
    this.systemPrompt = options.systemPrompt;
    this.client = options.client;
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.log = options.log;
    this.emailId = options.emailId;
  }

  /**
   * Send a message and get the parsed analysis.
   * Handles JSON parse errors internally with one retry.
   * All responses (including failed parses) are added to history.
   */
  async sendMessage(content: string): Promise<EmailAnalysis> {
    this.messages.push({ role: 'user', content });

    const maxRetries = 1;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: this.systemPrompt,
        messages: this.messages,
      });

      const textContent = response.content.find((c) => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        throw new Error('No text response from AI');
      }

      // Add raw response to history before parsing
      this.messages.push({ role: 'assistant', content: textContent.text });

      try {
        return this.parseAnalysisFromXml(textContent.text);
      } catch (error) {
        if (attempt < maxRetries && error instanceof JsonParseError) {
          this.log.warn(
            { emailId: this.emailId, attempt, error: error.message },
            'JSON parse failed, requesting correction'
          );
          // Add correction request for next iteration
          this.messages.push({
            role: 'user',
            content: `<error>JSON parse failed: ${error.message}</error>

Please fix the JSON syntax and return the corrected analysis inside <analysis> tags.`,
          });
        } else {
          throw error;
        }
      }
    }

    // TypeScript: unreachable, but satisfies return type
    throw new Error('Unexpected: retry loop exited without return or throw');
  }

  /** Get message history for debugging/logging */
  getHistory(): ReadonlyArray<{ role: string; content: string }> {
    return this.messages;
  }

  /**
   * Parse analysis JSON from XML-tagged AI response
   */
  private parseAnalysisFromXml(text: string): EmailAnalysis {
    // Extract content between <analysis> tags
    const match = text.match(/<analysis>\s*([\s\S]*?)\s*<\/analysis>/);

    if (!match) {
      throw new JsonParseError('No <analysis> tags found in response', text);
    }

    const jsonStr = match[1]!.trim();

    try {
      const parsed = JSON.parse(jsonStr);
      return this.validateAnalysis(parsed);
    } catch (error) {
      throw new JsonParseError(
        `JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
        text
      );
    }
  }

  /**
   * Validate and normalize the parsed analysis object
   */
  private validateAnalysis(parsed: Record<string, unknown>): EmailAnalysis {
    // Validate sender_type
    const senderType = parsed.sender_type;
    if (senderType !== 'automated' && senderType !== 'human') {
      throw new JsonParseError(
        `Invalid sender_type: ${senderType}. Must be 'automated' or 'human'.`,
        JSON.stringify(parsed)
      );
    }

    // Validate message_type
    const messageType = parsed.message_type;
    const validMessageTypes = ['spam', 'newsletter', 'alert', 'group', 'personal'];
    if (!validMessageTypes.includes(messageType as string)) {
      throw new JsonParseError(
        `Invalid message_type: ${messageType}. Must be one of: ${validMessageTypes.join(', ')}`,
        JSON.stringify(parsed)
      );
    }

    return {
      overview: typeof parsed.overview === 'string' ? parsed.overview : '',
      mentioned_people: Array.isArray(parsed.mentioned_people)
        ? parsed.mentioned_people.filter((p): p is string => typeof p === 'string')
        : [],
      mentioned_organizations: Array.isArray(parsed.mentioned_organizations)
        ? parsed.mentioned_organizations.filter((o): o is string => typeof o === 'string')
        : [],
      potential_action_items: Array.isArray(parsed.potential_action_items)
        ? parsed.potential_action_items.filter((a): a is string => typeof a === 'string')
        : [],
      sender_type: senderType as 'automated' | 'human',
      message_type: messageType as 'spam' | 'newsletter' | 'alert' | 'group' | 'personal',
      unsubscribe_link:
        typeof parsed.unsubscribe_link === 'string' ? parsed.unsubscribe_link : null,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    };
  }
}

// Settings fields from GoogleAccount used for triage
type AccountSettings = Pick<
  GoogleAccount,
  'triage_system_instructions' | 'label_prefix_tracking' | 'label_prefix_todo' | 'sync_start_date'
>;

export interface TriageServiceConfig {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  concurrency?: number;
}

export interface TriageStatus {
  triaging: boolean;
  startedAt: Date | null;
  emailCount: number | null;     // How many emails in this batch
  processedCount: number | null; // How many completed so far
}

export class TriageService {
  private sql: postgres.Sql;
  private log: FastifyBaseLogger;
  private client: Anthropic;
  private limit: ReturnType<typeof pLimit>;
  private model: string;
  private maxTokens: number;
  private activeTriages = new Map<number, { startedAt: Date; total: number; processed: number }>();

  constructor(
    sql: postgres.Sql,
    log: FastifyBaseLogger,
    config: TriageServiceConfig = {}
  ) {
    this.sql = sql;
    this.log = log;
    this.client = new Anthropic({
      apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
    this.limit = pLimit(config.concurrency ?? 5);
    this.model = config.model ?? 'claude-3-5-haiku-latest';
    this.maxTokens = config.maxTokens ?? 2048;
  }

  /**
   * Get triage status for an account
   */
  getTriageStatus(accountId: number): TriageStatus {
    const active = this.activeTriages.get(accountId);
    return active
      ? { triaging: true, startedAt: active.startedAt, emailCount: active.total, processedCount: active.processed }
      : { triaging: false, startedAt: null, emailCount: null, processedCount: null };
  }

  /**
   * Get triage status for all accounts
   */
  getAllTriageStatuses(): Map<number, TriageStatus> {
    const result = new Map<number, TriageStatus>();
    for (const [accountId, status] of this.activeTriages) {
      result.set(accountId, {
        triaging: true,
        startedAt: status.startedAt,
        emailCount: status.total,
        processedCount: status.processed,
      });
    }
    return result;
  }

  /**
   * Triage a batch of emails concurrently
   * Skips accounts that are already triaging
   */
  async triageBatch(emailIds: number[]): Promise<TriageResult[]> {
    if (emailIds.length === 0) {
      return [];
    }

    // Get account IDs for the emails
    const emails = await this.sql<{ id: number; account_id: number }[]>`
      SELECT id, account_id FROM google.emails WHERE id = ANY(${emailIds})
    `;

    // Group by account
    const byAccount = new Map<number, number[]>();
    for (const email of emails) {
      const ids = byAccount.get(email.account_id) || [];
      ids.push(email.id);
      byAccount.set(email.account_id, ids);
    }

    // Skip accounts that are already triaging
    const accountsToProcess: number[] = [];
    for (const accountId of byAccount.keys()) {
      if (this.activeTriages.has(accountId)) {
        this.log.info({ accountId }, 'Skipping account - triage already in progress');
      } else {
        accountsToProcess.push(accountId);
      }
    }

    if (accountsToProcess.length === 0) {
      this.log.info('All accounts already triaging - skipping batch');
      return [];
    }

    // Filter to only emails from accounts we're processing
    const emailsToProcess = emails.filter((e) => accountsToProcess.includes(e.account_id));
    const emailIdsToProcess = emailsToProcess.map((e) => e.id);

    // Initialize status for accounts we're processing
    for (const accountId of accountsToProcess) {
      const ids = byAccount.get(accountId)!;
      this.activeTriages.set(accountId, {
        startedAt: new Date(),
        total: ids.length,
        processed: 0,
      });
    }

    try {
      const results = await Promise.all(
        emailIdsToProcess.map((id) =>
          this.limit(async () => {
            const result = await this.triageEmail(id);
            // Increment processed count
            const email = emailsToProcess.find((e) => e.id === id);
            if (email) {
              const status = this.activeTriages.get(email.account_id);
              if (status) status.processed++;
            }
            return result;
          })
        )
      );
      return results;
    } finally {
      // Clean up tracking for accounts we processed
      for (const accountId of accountsToProcess) {
        this.activeTriages.delete(accountId);
      }
    }
  }

  /**
   * Triage a single email
   */
  async triageEmail(emailId: number): Promise<TriageResult> {
    try {
      const email = await this.getEmailWithMetadata(emailId);
      if (!email) {
        return { emailId, success: false, error: 'Email not found' };
      }

      // Step 1: Check database rules
      const ruleMatch = await this.matchRules(email);
      if (ruleMatch?.skip_ai_triage) {
        return this.applyRuleResult(emailId, ruleMatch);
      }

      // Step 2: Load account settings for dynamic prompt
      const settings = await this.getAccountSettings(email.account_id);
      const aliases = await this.getUserAliases(email.account_id);

      // Step 3: Check thread context
      const threadContext = await this.getThreadContext(email);

      // Step 4: Haiku analysis with XML-structured prompts and retry
      const analysis = await this.runHaikuAnalysis(email, {
        ruleMatch,
        threadContext,
        settings,
        aliases,
      });

      // Step 5: Apply analysis to database
      return this.applyTriageResult(emailId, analysis, ruleMatch?.id);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.log.error({ emailId, error }, 'Triage failed');

      // Record error but preserve workflow_status for retry
      await this.sql`
        UPDATE google.emails
        SET last_error = ${errorMessage}, last_error_at = NOW()
        WHERE id = ${emailId}
      `;

      return { emailId, success: false, error: errorMessage };
    }
  }

  /**
   * Get email with account metadata
   */
  private async getEmailWithMetadata(
    emailId: number
  ): Promise<EmailRecord | null> {
    const [email] = await this.sql<EmailRecord[]>`
      SELECT * FROM google.emails WHERE id = ${emailId}
    `;
    return email ?? null;
  }

  /**
   * Match email against triage rules
   */
  private async matchRules(email: EmailRecord): Promise<TriageRule | null> {
    const rules = await this.sql<TriageRule[]>`
      SELECT * FROM google.triage_rules
      WHERE account_id = ${email.account_id} AND enabled = true
      ORDER BY priority DESC
    `;

    for (const rule of rules) {
      if (this.ruleMatches(email, rule)) {
        return rule;
      }
    }

    return null;
  }

  /**
   * Check if a rule matches an email
   */
  private ruleMatches(email: EmailRecord, rule: TriageRule): boolean {
    // Check from patterns
    if (rule.from_patterns && rule.from_patterns.length > 0) {
      const fromAddress = email.from_address?.toLowerCase() ?? '';
      const matches = rule.from_patterns.some((pattern) =>
        this.matchPattern(fromAddress, pattern.toLowerCase())
      );
      if (!matches) return false;
    }

    // Check subject contains
    if (rule.subject_contains && rule.subject_contains.length > 0) {
      const subject = email.subject?.toLowerCase() ?? '';
      const matches = rule.subject_contains.some((keyword) =>
        subject.includes(keyword.toLowerCase())
      );
      if (!matches) return false;
    }

    // Check body contains
    if (rule.body_contains && rule.body_contains.length > 0) {
      const body = email.body_text?.toLowerCase() ?? '';
      const matches = rule.body_contains.some((keyword) =>
        body.includes(keyword.toLowerCase())
      );
      if (!matches) return false;
    }

    // Check body NOT contains
    if (rule.body_not_contains && rule.body_not_contains.length > 0) {
      const body = email.body_text?.toLowerCase() ?? '';
      const hasExcluded = rule.body_not_contains.some((keyword) =>
        body.includes(keyword.toLowerCase())
      );
      if (hasExcluded) return false;
    }

    return true;
  }

  /**
   * Match a value against a pattern with wildcards
   */
  private matchPattern(value: string, pattern: string): boolean {
    // Convert glob pattern to regex
    const regex = new RegExp(
      '^' +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$'
    );
    return regex.test(value);
  }

  /**
   * Apply a rule-based result (skip AI triage)
   */
  private async applyRuleResult(
    emailId: number,
    rule: TriageRule
  ): Promise<TriageResult> {
    const plannedLabels: string[] = [];

    if (rule.assigned_domain) {
      plannedLabels.push(`d/${this.capitalizeFirst(rule.assigned_domain)}`);
    }
    if (rule.assigned_type) {
      plannedLabels.push(
        `s/${rule.assigned_type === 'personal' ? 'Personal' : 'Automated'}`
      );
    }
    if (rule.priority_level) {
      plannedLabels.push(`p/${this.capitalizeFirst(rule.priority_level)}`);
    }

    const gmailAction: GmailAction =
      rule.gmail_action ?? (rule.action === 'spam' ? 'spam' : 'archive');

    await this.sql`
      UPDATE google.emails SET
        email_type = ${rule.assigned_type ?? null},
        domain = ${rule.assigned_domain ?? null},
        digest_section = ${rule.digest_section ?? null},
        planned_labels = ${plannedLabels},
        gmail_action = ${gmailAction},
        triage_confidence = 1.0,
        rule_matched_id = ${rule.id},
        workflow_status = 'triaged',
        triaged_at = NOW(),
        last_error = NULL,
        last_error_at = NULL
      WHERE id = ${emailId}
    `;

    this.log.info(
      { emailId, ruleId: rule.rule_id },
      'Applied rule-based triage'
    );

    return {
      emailId,
      success: true,
      ruleMatched: rule.rule_id,
      confidence: 1.0,
    };
  }

  /**
   * Get account settings from accounts table
   */
  private async getAccountSettings(
    accountId: number
  ): Promise<AccountSettings | null> {
    const [account] = await this.sql<AccountSettings[]>`
      SELECT triage_system_instructions, label_prefix_tracking,
             label_prefix_todo, sync_start_date
      FROM google.accounts WHERE id = ${accountId}
    `;
    return account ?? null;
  }

  /**
   * Get user aliases for name disambiguation
   */
  private async getUserAliases(accountId: number): Promise<UserAlias[]> {
    return this.sql<UserAlias[]>`
      SELECT * FROM google.user_aliases WHERE account_id = ${accountId}
    `;
  }

  /**
   * Get thread context from parent emails
   */
  private async getThreadContext(
    email: EmailRecord
  ): Promise<{ parentLabels?: string[]; parentSummary?: string } | null> {
    if (!email.thread_id) return null;

    // Get the most recent parent email in the thread
    const [parent] = await this.sql<EmailRecord[]>`
      SELECT planned_labels, overview FROM google.emails
      WHERE account_id = ${email.account_id}
        AND thread_id = ${email.thread_id}
        AND id != ${email.id}
        AND workflow_status IN ('triaged', 'reviewed', 'executed')
      ORDER BY date DESC
      LIMIT 1
    `;

    if (!parent) return null;

    return {
      parentLabels: parent.planned_labels ?? undefined,
      parentSummary: parent.analysis?.overview ?? undefined,
    };
  }

  /**
   * Run Haiku analysis with multi-turn conversation support.
   * Uses AnalysisConversation for message history management and JSON retry.
   */
  private async runHaikuAnalysis(
    email: EmailRecord,
    context: {
      ruleMatch: TriageRule | null;
      threadContext: { parentLabels?: string[]; parentSummary?: string } | null;
      settings: AccountSettings | null;
      aliases: UserAlias[];
    }
  ): Promise<EmailAnalysis> {
    const conversation = new AnalysisConversation({
      systemPrompt: this.buildSystemPrompt(context.settings, context.aliases),
      client: this.client,
      model: this.model,
      maxTokens: this.maxTokens,
      log: this.log,
      emailId: email.id,
    });

    // Turn 1: Initial analysis (JSON retry handled internally)
    let analysis = await conversation.sendMessage(
      this.buildEmailPrompt(email, context)
    );

    // Turn 2: Newsletter unsubscribe link refinement
    if (
      analysis.message_type === 'newsletter' &&
      !analysis.unsubscribe_link &&
      email.body_html
    ) {
      this.log.info(
        { emailId: email.id },
        'Newsletter missing unsubscribe link, checking HTML'
      );
      analysis = await conversation.sendMessage(
        `<refinement>
The email was classified as a newsletter but no unsubscribe link was found in the text body.
Please examine the HTML body below and extract the unsubscribe URL if present.
Return your updated complete analysis.

<html_body>
${email.body_html}
</html_body>
</refinement>`
      );
    }

    // Future conditional turns can be added here as simple if-statements

    return analysis;
  }

  /**
   * Build dynamic system prompt with XML tags for structured output
   */
  private buildSystemPrompt(
    _settings: AccountSettings | null,
    _aliases: UserAlias[]
  ): string {
    return `<role>
You are an email analysis assistant. Analyze emails and return structured JSON.
</role>

<definitions>
<sender_type>
- automated: System-generated, no human composed (receipts, alerts, notifications, auto-responders)
- human: Human composed, regardless of sending tool (CRM, ticketing system, etc.)
</sender_type>

<message_type>
- spam: Unsolicited email confidently recognized as spam (phishing, scams, suspicious cold outreach). NOT newsletters.
- newsletter: Any email with an unsubscribe link (periodic updates, marketing, announcements). Legitimacy determined later.
- alert: System notifications, transactional (receipts, confirmations, calendar). No unsubscribe link typical.
- group: Sent to mailing list or large recipient list, not individually addressed. Check TO/CC fields.
- personal: Direct person-to-person, individually addressed in TO with small/relevant CC.
</message_type>
</definitions>

<instructions>
1. Read the email metadata and body carefully
2. Extract mentioned people and organizations by name
3. Identify any action items implied or explicitly requested of the recipient
4. Classify sender_type based on whether a human composed the message
5. Classify message_type based on content and sender patterns
6. Extract unsubscribe link if present (look for "unsubscribe" URLs in body/headers) - presence indicates newsletter
7. Write a brief rationale explaining your classification
</instructions>

<response_format>
Return ONLY a JSON object inside <analysis> tags. No markdown, no explanation outside the tags.

<analysis>
{
  "overview": "1-2 sentence overview of message contents",
  "mentioned_people": ["Name 1", "Name 2"],
  "mentioned_organizations": ["Org 1"],
  "potential_action_items": ["Action 1", "Action 2"],
  "sender_type": "automated|human",
  "message_type": "spam|newsletter|alert|group|personal",
  "unsubscribe_link": "https://..." or null,
  "rationale": "Brief explanation of classification"
}
</analysis>
</response_format>`;
  }

  /**
   * Build the email content prompt with XML structure
   */
  private buildEmailPrompt(
    email: EmailRecord,
    _context: {
      ruleMatch: TriageRule | null;
      threadContext: { parentLabels?: string[]; parentSummary?: string } | null;
    }
  ): string {
    // Build from field with name if available
    const fromField = email.from_name
      ? `${email.from_name} <${email.from_address}>`
      : email.from_address || 'unknown';

    return `<email>
<from>${fromField}</from>
<to>${email.to_addresses?.join(', ') || 'unknown'}</to>
<cc>${email.cc_addresses?.join(', ') || ''}</cc>
<bcc></bcc>
<date>${email.date?.toISOString() || 'unknown'}</date>
<subject>${email.subject || '(no subject)'}</subject>
<body>
${email.body_text || email.snippet || '(empty)'}
</body>
</email>`;
  }


  /**
   * Get topics of interest for an account
   */
  private async getTopicsOfInterest(
    accountId: number
  ): Promise<TopicOfInterest[]> {
    return this.sql<TopicOfInterest[]>`
      SELECT * FROM google.topics_of_interest
      WHERE account_id = ${accountId} AND enabled = true
    `;
  }

  /**
   * Score email against topics of interest
   */
  private scoreAgainstTopics(
    email: EmailRecord,
    analysis: EmailAnalysis,
    topics: TopicOfInterest[]
  ): boolean {
    const content = [
      email.subject || '',
      email.body_text || '',
      analysis.overview || '',
    ]
      .join(' ')
      .toLowerCase();

    let score = 0;
    let hasExclude = false;

    for (const topic of topics) {
      const value = topic.value.toLowerCase();

      if (topic.topic_type === 'exclude') {
        if (content.includes(value)) {
          hasExclude = true;
        }
      } else if (topic.topic_type === 'keyword') {
        if (content.includes(value)) {
          score++;
        }
      } else if (topic.topic_type === 'domain') {
        if (content.includes(value)) {
          score += 2; // Domain matches are weighted higher
        }
      }
    }

    // Exclude keywords trump positive matches
    if (hasExclude) return false;

    // Require at least 2 keyword matches or 1 domain match
    return score >= 2;
  }

  /**
   * Apply triage analysis to database (single JSONB column)
   */
  private async applyTriageResult(
    emailId: number,
    analysis: EmailAnalysis,
    ruleMatchedId?: number
  ): Promise<TriageResult> {
    await this.sql`
      UPDATE google.emails SET
        analysis = ${analysis as any},
        triage_confidence = 0.8,
        rule_matched_id = ${ruleMatchedId ?? null},
        workflow_status = 'triaged',
        triaged_at = NOW(),
        last_error = NULL,
        last_error_at = NULL
      WHERE id = ${emailId}
    `;

    this.log.info(
      { emailId, overview: analysis.overview, messageType: analysis.message_type },
      'AI triage complete'
    );

    return {
      emailId,
      success: true,
      analysis,
      confidence: 0.8,
    };
  }

  /**
   * Capitalize first letter
   */
  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}
