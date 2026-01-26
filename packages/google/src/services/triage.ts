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
  AccountSettings,
  UserAlias,
  TriageResult,
  EmailAnalysis,
  EmailType,
  EmailDomain,
  GmailAction,
  DigestSection,
  ActionItem,
  Extraction,
} from '../types.js';

export interface TriageServiceConfig {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  concurrency?: number;
}

export class TriageService {
  private sql: postgres.Sql;
  private log: FastifyBaseLogger;
  private client: Anthropic;
  private limit: ReturnType<typeof pLimit>;
  private model: string;
  private maxTokens: number;

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
   * Triage a batch of emails concurrently
   */
  async triageBatch(emailIds: number[]): Promise<TriageResult[]> {
    const results = await Promise.all(
      emailIds.map((id) => this.limit(() => this.triageEmail(id)))
    );
    return results;
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

      // Step 4: Multi-turn Haiku analysis with dynamic prompt
      const analysis = await this.runHaikuAnalysis(email, {
        ruleMatch,
        threadContext,
        settings,
        aliases,
      });

      // Step 5: Topics of Interest scoring (for RFPs/newsletters)
      if (ruleMatch?.assess_against_topics) {
        const topics = await this.getTopicsOfInterest(email.account_id);
        analysis.interesting = this.scoreAgainstTopics(email, analysis, topics);
      }

      // Step 6: Apply analysis to database
      return this.applyTriageResult(emailId, analysis, ruleMatch?.id);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.log.error({ emailId, error }, 'Triage failed');

      // Mark as failed
      await this.sql`
        UPDATE google.emails
        SET workflow_status = 'failed', execution_notes = ${errorMessage}
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
        triaged_at = NOW()
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
   * Get account settings
   */
  private async getAccountSettings(
    accountId: number
  ): Promise<AccountSettings | null> {
    const [settings] = await this.sql<AccountSettings[]>`
      SELECT * FROM google.account_settings WHERE account_id = ${accountId}
    `;
    return settings ?? null;
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
      parentSummary: parent.overview ?? undefined,
    };
  }

  /**
   * Run multi-turn Haiku analysis
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
    const systemPrompt = this.buildSystemPrompt(context.settings, context.aliases);
    const userMessage = this.buildEmailPrompt(email, context);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userMessage,
        },
      ],
    });

    // Extract text response
    const textContent = response.content.find((c) => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from AI');
    }

    // Parse JSON from response
    const analysis = this.parseAnalysisResponse(textContent.text);
    return analysis;
  }

  /**
   * Build dynamic system prompt from database config
   */
  private buildSystemPrompt(
    settings: AccountSettings | null,
    aliases: UserAlias[]
  ): string {
    const ownerAliases = aliases.filter((a) => a.is_owner).map((a) => a.alias);
    const otherAliases = aliases.filter((a) => !a.is_owner);

    let aliasRules = '';
    if (ownerAliases.length > 0) {
      aliasRules = `
NAME DISAMBIGUATION (from account configuration):
- These names refer to the account owner: ${ownerAliases.map((a) => `"${a}"`).join(', ')}`;

      if (otherAliases.length > 0) {
        aliasRules += `
- These names refer to OTHER people (NOT the account owner):`;
        for (const alias of otherAliases) {
          aliasRules += `\n  - "${alias.alias}" = ${alias.refers_to}`;
        }
      }
    }

    return `You are an email triage assistant. Analyze emails and produce structured JSON analysis.

COMMITMENT EXTRACTION RULES (CRITICAL):
- Only extract commitments FOR the account owner (the email recipient)
- Check TO field: TO=owner's commitments, CC=FYI only, TO others=not theirs
${aliasRules}
- Must include quoted_text from the email showing the commitment
- When uncertain, don't extract - better to mark for review

${settings?.triage_system_instructions || ''}

ANALYSIS STRUCTURE (respond with ONLY valid JSON):
{
  "email_type": "personal" | "automated",
  "domain": "client" | "finance" | "transit" | "infrastructure" | "opportunity" | "project" | "internal" | "marketing",
  "overview": "2-4 sentence summary",
  "potential_action_items": [{"type": "commitment" | "backlog" | "follow-up", "description": "..."}],
  "potential_extractions": ["commitment", "backlog", "contact_update"],
  "digest_section": "calendar" | "financial" | "opportunities" | "newsletters" | null,
  "planned_labels": ["d/Domain", "s/Type", "p/Priority", "TODO/Action"],
  "gmail_action": "leave" | "archive" | "spam",
  "extractions": [{
    "type": "commitment",
    "description": "...",
    "due_date": "YYYY-MM-DD or null",
    "due_date_note": "...",
    "priority": "high" | "medium" | "low",
    "quoted_text": "exact text from email",
    "sender": "who assigned this"
  }]
}

LABEL CONVENTIONS:
- d/ = domain (Client, Finance, Transit, Infrastructure, Opportunity, Project, Internal, Marketing)
- s/ = source (Personal, Automated)
- p/ = priority (High, Normal, Low)
- TODO/ = action needed (Respond, Review, Follow-up, Pay)

GMAIL ACTION GUIDE:
- "leave": Requires attention or response from owner
- "archive": Routine, informational, or handled
- "spam": Unwanted, unsubscribe-worthy`;
  }

  /**
   * Build the email content prompt
   */
  private buildEmailPrompt(
    email: EmailRecord,
    context: {
      ruleMatch: TriageRule | null;
      threadContext: { parentLabels?: string[]; parentSummary?: string } | null;
    }
  ): string {
    let prompt = `Analyze this email and provide JSON analysis:

FROM: ${email.from_name ? `${email.from_name} <${email.from_address}>` : email.from_address}
TO: ${email.to_addresses?.join(', ') || 'unknown'}
CC: ${email.cc_addresses?.join(', ') || 'none'}
DATE: ${email.date?.toISOString() || 'unknown'}
SUBJECT: ${email.subject || '(no subject)'}

BODY:
${email.body_text || email.snippet || '(empty)'}`;

    if (context.threadContext) {
      prompt += `

THREAD CONTEXT:
- Previous labels: ${context.threadContext.parentLabels?.join(', ') || 'none'}
- Previous summary: ${context.threadContext.parentSummary || 'none'}`;
    }

    if (context.ruleMatch) {
      prompt += `

RULE HINT: This email matched rule "${context.ruleMatch.name}"
- Suggested digest section: ${context.ruleMatch.digest_section || 'none'}
- Suggested domain: ${context.ruleMatch.assigned_domain || 'analyze'}`;
    }

    return prompt;
  }

  /**
   * Parse analysis JSON from AI response
   */
  private parseAnalysisResponse(text: string): EmailAnalysis {
    // Extract JSON from markdown code block if present
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1]! : text;

    try {
      const parsed = JSON.parse(jsonStr.trim());

      return {
        email_type: parsed.email_type || 'personal',
        domain: parsed.domain || 'internal',
        overview: parsed.overview || '',
        potential_action_items: parsed.potential_action_items || [],
        potential_extractions: parsed.potential_extractions || [],
        digest_section: parsed.digest_section || undefined,
        interesting: parsed.interesting,
        planned_labels: parsed.planned_labels || [],
        gmail_action: parsed.gmail_action || 'leave',
        extractions: parsed.extractions || [],
      };
    } catch (error) {
      this.log.warn({ text, error }, 'Failed to parse AI response as JSON');

      // Return safe defaults
      return {
        email_type: 'personal',
        domain: 'internal',
        overview: 'Failed to parse AI analysis',
        potential_action_items: [],
        potential_extractions: [],
        planned_labels: ['p/Normal'],
        gmail_action: 'leave',
        extractions: [],
      };
    }
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
   * Apply triage analysis to database
   */
  private async applyTriageResult(
    emailId: number,
    analysis: EmailAnalysis,
    ruleMatchedId?: number
  ): Promise<TriageResult> {
    await this.sql`
      UPDATE google.emails SET
        email_type = ${analysis.email_type},
        domain = ${analysis.domain},
        overview = ${analysis.overview},
        potential_action_items = ${JSON.stringify(analysis.potential_action_items)},
        potential_extractions = ${analysis.potential_extractions},
        digest_section = ${analysis.digest_section ?? null},
        interesting = ${analysis.interesting ?? null},
        planned_labels = ${analysis.planned_labels},
        gmail_action = ${analysis.gmail_action},
        extractions = ${JSON.stringify(analysis.extractions)},
        triage_confidence = 0.8,
        rule_matched_id = ${ruleMatchedId ?? null},
        workflow_status = 'triaged',
        triaged_at = NOW()
      WHERE id = ${emailId}
    `;

    this.log.info({ emailId, analysis: analysis.overview }, 'AI triage complete');

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
