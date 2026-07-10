/**
 * Triage Service
 *
 * AI-powered email triage using multi-turn Haiku conversations:
 * - Dynamic prompts from account settings and aliases
 * - Newsletter refinement for unsubscribe link extraction
 */

import Anthropic from '@anthropic-ai/sdk';
import pLimit from 'p-limit';
import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { NotifyDispatcher, HeartbeatRegistry } from '@jarvus/claude-assist-core';
import type {
  EmailRecord,
  GoogleAccount,
  UserAlias,
  TriageResult,
  EmailAnalysis,
  TriageRule,
  GmailAction,
} from '../types.js';
import type { RulesService } from './rules.js';
import type { WhitelistService } from './whitelist.js';
import {
  derivePlanFromAnalysis,
  derivePlanFromRule,
  analysisFromRule,
  type DerivedPlan,
  type LabelPrefixes,
} from './plan.js';
import { classifyUrgency } from './urgency.js';

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
  'email_triage_instructions' | 'email_label_prefix' | 'email_label_prefix_todo' | 'email_sync_start_date'
>;

export interface TriageServiceConfig {
  /** Anthropic API key (required) */
  apiKey: string;
  /** Model to use (default: 'claude-haiku-4-5') */
  model?: string;
  /** Max tokens for response (default: 2048) */
  maxTokens?: number;
  /** Concurrency for triage operations (default: 5) */
  concurrency?: number;
  /** Disable email triage */
  disableEmailTriage?: boolean;
}

/**
 * Optional collaborators wired in by the plugin. Kept separate from the API-key
 * config so the service still works (rules/alerts simply no-op) when they're
 * absent — e.g. in a unit test or before the notify module is loaded.
 */
export interface TriageServiceDeps {
  rulesService?: RulesService;
  whitelistService?: WhitelistService;
  notify?: NotifyDispatcher;
  heartbeats?: HeartbeatRegistry;
  /** Team domains for the urgent-alert bar (default []; set via GOOGLE_TEAM_DOMAINS). */
  teamDomains?: string[];
  /** Disable the urgent-alert dispatch at triage completion. */
  disableEmailAlerts?: boolean;
}

export interface TriageStatus {
  triaging: boolean;
  startedAt: Date | null;
  emailCount: number | null;     // How many emails in this batch
  processedCount: number | null; // How many completed so far
}

export class TriageService {
  /**
   * Max characters of *cleaned* HTML text allowed into a prompt. Turn 2
   * (unsubscribe-link refinement) sends the raw HTML body verbatim, and some
   * newsletter markup is bloated enough to blow past the model's context
   * window entirely (one real case: a 440KB HTML body produced a 207K-token
   * prompt against a 200K-token limit). 100KB of cleaned text is generous
   * for finding an unsubscribe href while staying well under budget.
   */
  private static readonly HTML_PROMPT_CHAR_BUDGET = 100_000;

  /**
   * Emails that fail triage this many times stop being picked up by the
   * scheduler's every-5-minute sweep - a genuinely broken email (e.g. one
   * that always blows the context window) would otherwise retry forever,
   * burning a paid turn-1 call each cycle. `triage_attempts` is only reset
   * by a successful triage.
   */
  static readonly MAX_TRIAGE_ATTEMPTS = 5;

  /** How long a derived per-account whitelist is reused within triage batches. */
  private static readonly WHITELIST_TTL_MS = 5 * 60 * 1000;
  private whitelistCache = new Map<number, { set: Set<string>; at: number }>();

  private sql: postgres.Sql;
  private log: FastifyBaseLogger;
  private client: Anthropic;
  private limit: ReturnType<typeof pLimit>;
  private model: string;
  private maxTokens: number;
  private disableEmailTriage: boolean;
  private activeTriages = new Map<number, { startedAt: Date; total: number; processed: number }>();

  // Optional collaborators (rules matching + urgent-alert path).
  private rulesService: RulesService | undefined;
  private whitelistService: WhitelistService | undefined;
  private notify: NotifyDispatcher | undefined;
  private heartbeats: HeartbeatRegistry | undefined;
  private teamDomains: string[];
  private disableEmailAlerts: boolean;

  constructor(
    sql: postgres.Sql,
    log: FastifyBaseLogger,
    config: TriageServiceConfig,
    deps: TriageServiceDeps = {}
  ) {
    this.sql = sql;
    this.log = log;
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.limit = pLimit(config.concurrency ?? 5);
    this.model = config.model ?? 'claude-haiku-4-5';
    this.maxTokens = config.maxTokens ?? 2048;
    this.disableEmailTriage = config.disableEmailTriage ?? false;
    this.rulesService = deps.rulesService;
    this.whitelistService = deps.whitelistService;
    this.notify = deps.notify;
    this.heartbeats = deps.heartbeats;
    this.teamDomains = deps.teamDomains ?? [];
    this.disableEmailAlerts = deps.disableEmailAlerts ?? false;
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
    if (this.disableEmailTriage) {
      this.log.info('Email triage disabled via disableEmailTriage config');
      return [];
    }

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
    if (this.disableEmailTriage) {
      this.log.info('Email triage disabled via disableEmailTriage config');
      return { emailId, success: false, error: 'Triage disabled' };
    }

    try {
      const email = await this.getEmailWithMetadata(emailId);
      if (!email) {
        return { emailId, success: false, error: 'Email not found' };
      }

      // Load account settings for dynamic prompt + label prefixes.
      const settings = await this.getAccountSettings(email.account_id);
      const prefixes = this.labelPrefixesFromSettings(settings);

      // Step 1: deterministic pre-AI rules. A skip_ai_triage match applies a
      // deterministic plan and spends no Haiku turn.
      const rule = this.rulesService
        ? await this.rulesService.matchRule(email)
        : null;

      if (rule?.skip_ai_triage) {
        return this.applyRuleResult(emailId, rule, prefixes);
      }

      // Step 2: AI analysis (rule, if any, only pre-assigns hints).
      const aliases = await this.getUserAliases(email.account_id);
      const threadContext = await this.getThreadContext(email);
      const analysis = await this.runHaikuAnalysis(email, {
        threadContext,
        settings,
        aliases,
      });

      // Step 3: derive the deterministic plan, guarded by the whitelist.
      const whitelist = await this.getWhitelist(email.account_id);
      const plan = this.guardPlan(
        derivePlanFromAnalysis(analysis, rule, prefixes),
        email,
        analysis,
        whitelist
      );

      // Step 4: persist analysis + plan (workflow_status -> 'triaged').
      const result = await this.applyTriageResult(emailId, analysis, plan, rule);

      // Step 5: urgent-alert path — earns an interrupt only if it clears the bar.
      result.alerted = await this.maybeAlert(email, analysis, whitelist);

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.log.error({ emailId, error }, 'Triage failed');

      // Record error and bump the attempt counter, but preserve
      // workflow_status so a future manual/forced retry can still pick it
      // up - the scheduler just stops selecting it once attempts hit the cap.
      const [updated] = await this.sql<{ triage_attempts: number }[]>`
        UPDATE google.emails
        SET last_error = ${errorMessage}, last_error_at = NOW(),
            triage_attempts = triage_attempts + 1
        WHERE id = ${emailId}
        RETURNING triage_attempts
      `;

      if (updated && updated.triage_attempts >= TriageService.MAX_TRIAGE_ATTEMPTS) {
        this.log.error(
          { emailId, attempts: updated.triage_attempts, maxAttempts: TriageService.MAX_TRIAGE_ATTEMPTS },
          'Triage failed max attempts - scheduler will stop retrying this email'
        );
      }

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
   * Get account settings from accounts table
   */
  private async getAccountSettings(
    accountId: number
  ): Promise<AccountSettings | null> {
    const [account] = await this.sql<AccountSettings[]>`
      SELECT email_triage_instructions, email_label_prefix,
             email_label_prefix_todo, email_sync_start_date
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
  ): Promise<{ parentSummary?: string } | null> {
    if (!email.thread_id) return null;

    // Get the most recent parent email in the thread
    const [parent] = await this.sql<{ overview: string | null }[]>`
      SELECT analysis->>'overview' as overview FROM google.emails
      WHERE account_id = ${email.account_id}
        AND thread_id = ${email.thread_id}
        AND id != ${email.id}
        AND workflow_status = 'triaged'
      ORDER BY date DESC
      LIMIT 1
    `;

    if (!parent) return null;

    return {
      parentSummary: parent.overview ?? undefined,
    };
  }

  /**
   * Run Haiku analysis with multi-turn conversation support.
   * Uses AnalysisConversation for message history management and JSON retry.
   */
  private async runHaikuAnalysis(
    email: EmailRecord,
    context: {
      threadContext: { parentSummary?: string } | null;
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
      this.buildEmailPrompt(email)
    );

    // Turn 2: Unsubscribe link extraction from HTML (newsletters and alerts)
    if (
      (analysis.message_type === 'newsletter' ||
        analysis.message_type === 'alert') &&
      !analysis.unsubscribe_link?.startsWith('http://') &&
      !analysis.unsubscribe_link?.startsWith('https://') &&
      email.body_html
    ) {
      const cleanedHtml = this.cleanHtmlForPrompt(email.body_html);

      this.log.info(
        { emailId: email.id, htmlTruncated: cleanedHtml.truncated, originalLength: email.body_html.length },
        'Missing unsubscribe link, checking HTML'
      );
      analysis = await conversation.sendMessage(
        `<refinement>
No valid unsubscribe URL was found in the text body.
Please examine the cleaned HTML body below (tags stripped, but href URLs preserved in the links list) and extract the actual unsubscribe URL if present (starting with http:// or https://).
Set unsubscribe_link to the full URL string, or null if no unsubscribe link exists.
Return your updated complete analysis.

<html_body${cleanedHtml.truncated ? ' truncated="true"' : ''}>
${cleanedHtml.text}
</html_body>
</refinement>`
      );

      if (cleanedHtml.truncated) {
        analysis = { ...analysis, html_truncated: true };
      }
    }

    // Future conditional turns can be added here as simple if-statements

    return analysis;
  }

  /**
   * Strip HTML markup down to plain text plus a links list, and cap the
   * result at HTML_PROMPT_CHAR_BUDGET before it enters a prompt.
   *
   * Tags/scripts/styles are stripped rather than kept verbatim because raw
   * marketing HTML can be enormous relative to its actual text content
   * (seen in production: 440KB of HTML for one newsletter). But turn 2
   * exists specifically to find an unsubscribe href, so hrefs are pulled
   * out into a separate list *before* stripping tags, and that links list
   * is always kept in full (capped independently) rather than getting cut
   * off by the text truncation.
   */
  private cleanHtmlForPrompt(html: string): { text: string; truncated: boolean } {
    const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!);
    const uniqueLinks = [...new Set(hrefs)]
      .filter((url) => /^https?:\/\//i.test(url))
      .slice(0, 300);

    const strippedText = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();

    const linksBlock =
      uniqueLinks.length > 0
        ? `\n\nLinks found in HTML (href values, in document order):\n${uniqueLinks.map((u) => `- ${u}`).join('\n')}`
        : '';

    // Reserve room for the links block (what turn 2 actually needs) and
    // truncate the surrounding text to whatever budget remains.
    const textBudget = Math.max(0, TriageService.HTML_PROMPT_CHAR_BUDGET - linksBlock.length);
    const textTruncated = strippedText.length > textBudget;
    const text = (textTruncated ? strippedText.slice(0, textBudget) : strippedText) + linksBlock;

    return { text, truncated: textTruncated };
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
- spam: Unsolicited email confidently recognized as spam. Includes:
  * Phishing attempts and scams
  * Cold B2B service solicitations (offshore/nearshore staffing, software development outsourcing, lead generation, business financing/loans, SEO/marketing services, business acquisition inquiries)
  * Unsolicited podcast invitations (commonly used for lead generation disguised as "thought leadership")
  * Content production offers (video production, book writing, ghostwriting services)
  * Emails with fake "Re:" prefixes that aren't actual replies (check is_new_thread field)
  * Fabricated "forwarded" messages showing fake internal recommendations (e.g., "Ray, I found this prospect...")
  * Mass-mailed pitches with opt-out language ("reply No thanks to opt out")
  * Sender domain that doesn't match the claimed company
  * Display name spoofing: generic notification names ("Audio Alert", "Voicemail Service") from personal email domains
  * Fake notification wrappers: claims of audio messages or voicemails that link to unrelated content
  * Vague references to non-existent past conversations ("following up from our chat", "digging through old notes") combined with a service pitch
  NOT newsletters (those have periodic content the recipient opted into).
- newsletter: Periodic content updates, marketing emails, or announcements. Usually sent on a schedule (daily/weekly digests, promotional campaigns). Legitimacy determined later.
- alert: System notifications triggered by specific events or user activity (social media notifications, match alerts, receipts, confirmations, monitoring alerts, calendar reminders). Usually one-off rather than periodic.
NOTE: Both newsletters and alerts commonly have unsubscribe links. The presence of an unsubscribe link does NOT determine the classification - use the content nature instead.
- group: Sent to mailing list or large recipient list, not individually addressed. Check TO/CC fields.
- personal: Direct person-to-person, individually addressed in TO with small/relevant CC. Must have prior relationship or legitimate business context.
</message_type>

<action_items>
Your job is to EXTRACT action items, not IMAGINE them.

An action item is something the email directly asks or requires the recipient to do. Ask: "Is the sender expecting me to do something?" For most emails, the answer is no.

Include action items that are:
- Explicitly requested by the sender ("Please review and approve by Friday")
- Required by a deadline or obligation ("Submit application by Jan 30")
- Necessary responses to direct questions ("Can you make the 2pm meeting?")
- Required follow-up to problems/failures ("Backup failed - investigate")

Do NOT include:
- Things the recipient COULD do (offers, opportunities, CTAs)
- Generic "review X" or "view details" for routine notifications
- Marketing calls-to-action ("Buy now", "Subscribe", "Download our app")
- Suggestions you're inventing based on the email topic

When in doubt, leave it empty. An empty action_items array is the correct answer for most emails.
</action_items>
</definitions>

<instructions>
1. Read the email metadata and body carefully
2. Classify sender_type based on whether a human composed the message
3. Classify message_type based on content and sender patterns
   - If gmail_labels includes "SPAM", apply extra scrutiny - Gmail's filter has already flagged this as suspicious
   - If subject starts with "Re:" or "RE:" but is_new_thread is true, this is likely a fake reply designed to create false familiarity
4. Extract mentioned people and organizations by name
5. Extract action items based on message_type (see <action_items> definition):
   - spam: ALWAYS empty []. Spam is unsolicited - any "questions" or "requests" are manipulative tactics, not legitimate action items requiring response.
   - newsletter: Empty unless it's a reminder for something the recipient already committed to (registered event, scheduled webinar). Marketing CTAs are not action items.
   - alert: Empty for routine notifications (receipts, confirmations, analytics). Only include for failures/problems requiring investigation or decisions requiring action.
   - group: Include only if the email explicitly requests participation or response.
   - personal: Include explicit requests and implied tasks from the sender.
6. Extract unsubscribe link ONLY if you find an actual URL (must start with http:// or https://). If you see mention of unsubscribing but cannot find the URL in the text body, leave unsubscribe_link as null - a second analysis turn with full HTML content will be attempted.
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
  private buildEmailPrompt(email: EmailRecord): string {
    // Build from field with name if available
    const fromField = email.from_name
      ? `${email.from_name} <${email.from_address}>`
      : email.from_address || 'unknown';

    // Contextual signals for spam detection
    const gmailLabels = email.gmail_labels?.join(', ') || '';
    const isNewThread = !email.thread_id;

    return `<email>
<from>${fromField}</from>
<to>${email.to_addresses?.join(', ') || 'unknown'}</to>
<cc>${email.cc_addresses?.join(', ') || ''}</cc>
<bcc></bcc>
<date>${email.date?.toISOString() || 'unknown'}</date>
<gmail_labels>${gmailLabels}</gmail_labels>
<is_new_thread>${isNewThread}</is_new_thread>
<subject>${email.subject || '(no subject)'}</subject>
<body>
${email.body_text || email.snippet || '(empty)'}
</body>
</email>`;
  }

  /**
   * Apply AI analysis + derived plan to the database (workflow -> 'triaged').
   * The plan columns (planned_labels / gmail_action / digest_section) are what
   * the deterministic executor later consumes on confirm-to-execute.
   */
  private async applyTriageResult(
    emailId: number,
    analysis: EmailAnalysis,
    plan: DerivedPlan,
    rule: TriageRule | null
  ): Promise<TriageResult> {
    await this.sql`
      UPDATE google.emails SET
        analysis = ${analysis as any},
        planned_labels = ${plan.plannedLabels},
        gmail_action = ${plan.gmailAction},
        digest_section = ${plan.digestSection},
        triage_confidence = ${rule ? 0.9 : 0.75},
        rule_matched_id = ${rule?.id ?? null},
        workflow_status = 'triaged',
        triaged_at = NOW(),
        last_error = NULL,
        last_error_at = NULL,
        triage_attempts = 0
      WHERE id = ${emailId}
    `;

    this.log.info(
      {
        emailId,
        overview: analysis.overview,
        messageType: analysis.message_type,
        gmailAction: plan.gmailAction,
        digestSection: plan.digestSection,
        ruleMatched: rule?.rule_id,
      },
      'AI triage complete'
    );

    return {
      emailId,
      success: true,
      analysis,
      ...(rule ? { ruleMatched: rule.rule_id } : {}),
      confidence: rule ? 0.9 : 0.75,
    };
  }

  /**
   * Apply a skip_ai_triage rule deterministically — no model call. Stages a
   * plan derived purely from the rule (mirrors the deleted `applyRuleResult`,
   * modernized onto the AI/* + TODO/* label tree).
   *
   * Also synthesizes a minimal `analysis` (via analysisFromRule) so the row
   * still carries a `message_type`. Every per-type view — the admin UI's
   * /inbox stats badges and its message_type-filtered table, plus the daily
   * digest — reads message_type from `analysis`, not from the plan columns;
   * without this a rule match becomes invisible everywhere except the raw
   * unfiltered email list even though it was fully triaged and actioned.
   */
  private async applyRuleResult(
    emailId: number,
    rule: TriageRule,
    prefixes: LabelPrefixes
  ): Promise<TriageResult> {
    const plan = derivePlanFromRule(rule, prefixes);
    const analysis = analysisFromRule(rule);

    await this.sql`
      UPDATE google.emails SET
        analysis = ${analysis as any},
        planned_labels = ${plan.plannedLabels},
        gmail_action = ${plan.gmailAction},
        digest_section = ${plan.digestSection},
        triage_confidence = 1.0,
        rule_matched_id = ${rule.id},
        workflow_status = 'triaged',
        triaged_at = NOW(),
        last_error = NULL,
        last_error_at = NULL,
        triage_attempts = 0
      WHERE id = ${emailId}
    `;

    this.log.info(
      { emailId, ruleId: rule.rule_id, gmailAction: plan.gmailAction, messageType: analysis.message_type },
      'Applied rule-based triage (skip_ai_triage)'
    );

    return {
      emailId,
      success: true,
      analysis,
      ruleMatched: rule.rule_id,
      confidence: 1.0,
    };
  }

  /** Read the AI/* and TODO/* label prefixes from account settings. */
  private labelPrefixesFromSettings(
    settings: AccountSettings | null
  ): LabelPrefixes {
    return {
      ai: settings?.email_label_prefix || 'AI',
      todo: settings?.email_label_prefix_todo || 'TODO',
    };
  }

  /**
   * Whitelist guardrail applied at plan time: never stage a `spam` move for a
   * whitelisted sender's personal mail (the executor enforces the same rule at
   * execute time as a backstop).
   */
  private guardPlan(
    plan: DerivedPlan,
    email: EmailRecord,
    analysis: EmailAnalysis,
    whitelist: Set<string>
  ): DerivedPlan {
    if (
      plan.gmailAction === 'spam' &&
      analysis.message_type === 'personal' &&
      email.from_address &&
      whitelist.has(email.from_address.toLowerCase())
    ) {
      const action: GmailAction = 'leave';
      this.log.warn(
        { emailId: email.id, from: email.from_address },
        'Plan guardrail: downgrading spam->leave for whitelisted personal sender'
      );
      return { ...plan, gmailAction: action };
    }
    return plan;
  }

  /**
   * Per-account whitelist with a short TTL cache so a triage batch doesn't
   * re-derive it for every email. Empty set when no whitelist service is wired.
   */
  private async getWhitelist(accountId: number): Promise<Set<string>> {
    if (!this.whitelistService) return new Set();
    const cached = this.whitelistCache.get(accountId);
    if (cached && Date.now() - cached.at < TriageService.WHITELIST_TTL_MS) {
      return cached.set;
    }
    const set = await this.whitelistService.deriveWhitelist(accountId);
    this.whitelistCache.set(accountId, { set, at: Date.now() });
    return set;
  }

  /**
   * The urgent-alert path. Fires a priority `interrupt` through the dispatcher
   * only when the email clears the "interrupts are earned" bar (human + known
   * sender + genuine time-sensitivity). Everything else stays digest material.
   * Returns whether an alert was dispatched.
   */
  private async maybeAlert(
    email: EmailRecord,
    analysis: EmailAnalysis,
    whitelist: Set<string>
  ): Promise<boolean> {
    if (this.disableEmailAlerts || !this.notify) return false;

    const verdict = classifyUrgency({
      senderAddress: email.from_address,
      senderType: analysis.sender_type,
      subject: email.subject,
      bodyText: email.body_text,
      snippet: email.snippet,
      actionItems: analysis.potential_action_items,
      whitelist,
      teamDomains: this.teamDomains,
    });

    if (!verdict.urgent) return false;

    const from = email.from_name
      ? `${email.from_name} <${email.from_address ?? ''}>`
      : email.from_address ?? 'unknown sender';
    const actionLine = analysis.potential_action_items[0]
      ? `\nAction: ${analysis.potential_action_items[0]}`
      : '';

    try {
      await this.notify.notify({
        priority: 'interrupt',
        title: `Urgent email: ${email.from_name ?? email.from_address ?? 'sender'}`,
        body: `From ${from}\nSubject: ${email.subject ?? '(no subject)'}\n${analysis.overview}${actionLine}`,
      });
      await this.sql`
        UPDATE google.emails SET alerted_at = NOW() WHERE id = ${email.id}
      `;
      this.log.info(
        { emailId: email.id, reason: verdict.reason },
        'Urgent-alert dispatched (interrupt)'
      );
      return true;
    } catch (error) {
      this.log.error({ emailId: email.id, error }, 'Urgent-alert dispatch failed');
      return false;
    }
  }
}
