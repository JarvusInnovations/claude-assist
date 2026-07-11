/**
 * Google Module Types
 * Database records and API payloads for Gmail integration
 */

// ============================================
// Account Management
// ============================================

export interface GoogleAccount {
  id: number;
  identifier: string; // 'personal', 'work'
  email: string;
  display_name: string | null;
  oauth_credentials: OAuthCredentials | null;
  is_primary: boolean;
  created_at: Date;
  settings_updated_at: Date;

  // Email sync settings
  email_history_id: string | null;
  email_last_sync_at: Date | null;
  email_sync_start_date: string | null; // ISO date string (YYYY-MM-DD)

  // Email triage settings
  email_triage_instructions: string | null;
  email_label_prefix: string;
  email_label_prefix_todo: string;
}

export interface OAuthCredentials {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
  scope: string;
}

export interface UserAlias {
  id: number;
  account_id: number;
  alias: string;
  is_owner: boolean;
  refers_to: string | null;
  notes: string | null;
  created_at: Date;
}


// ============================================
// Email Records
// ============================================

export interface EmailRecord {
  id: number;
  account_id: number;
  message_id: string;
  thread_id: string | null;

  // Gmail Metadata
  date: Date | null;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string | null;
  snippet: string | null;
  gmail_labels: string[] | null;

  // Content
  body_text: string | null;
  body_html: string | null;
  has_attachments: boolean;

  // Consolidated AI Analysis
  analysis: EmailAnalysis | null;

  // Plan (set at triage, editable during review; consumed by the executor)
  planned_labels: string[] | null;      // Full Gmail label paths, already prefix-namespaced
  gmail_action: GmailAction | null;     // 'leave' | 'archive' | 'spam'
  digest_section: string | null;        // Digest bucket (newsletters, financial, ...)
  triage_confidence: number | null;     // 0-1 (rule matches are 1.0)
  rule_matched_id: number | null;       // FK to google.triage_rules, if a rule matched

  // Workflow State
  workflow_status: WorkflowStatus;
  triaged_at: Date | null;
  reviewed_at: Date | null;
  executed_at: Date | null;
  alerted_at: Date | null;              // When the urgent-alert path fired, if it did

  // Execution Results (written only by the deterministic executor)
  applied_labels: string[] | null;
  applied_gmail_action: GmailAction | null;
  applied_at: Date | null;
  execution_notes: string | null;
  execution_error: string | null;
  execution_error_at: Date | null;

  // Error Tracking
  last_error: string | null;
  last_error_at: Date | null;
  triage_attempts: number; // Failed triage attempts; scheduler stops retrying past TriageService.MAX_TRIAGE_ATTEMPTS

  // Metadata
  synced_at: Date;
  updated_at: Date;
}

// WorkflowStatus enum - must stay in sync with google.workflow_status PostgreSQL enum
// Note: Errors are tracked separately via last_error/last_error_at fields
export type WorkflowStatus =
  | 'discovered' // Listed from Gmail but not yet fetched
  | 'new' // Fetched and ready for triage
  | 'triaged' // AI/rule analysis complete; plan staged
  | 'reviewed' // Human/plan review complete
  | 'executed'; // Deterministic actions applied to Gmail

// Deterministic action the executor takes in Gmail. 'spam' moves the message to
// Gmail's Spam folder — it is NEVER deleted/trashed.
export type GmailAction = 'leave' | 'archive' | 'spam';

// ============================================
// Rules and Topics
// ============================================

// What the rule intends. 'analyze_relevance' hands the email to AI triage but
// pre-assigns a digest section / topic assessment.
export type RuleAction = 'archive' | 'leave' | 'spam' | 'analyze_relevance';

export interface TriageRule {
  id: number;
  account_id: number;
  rule_id: string;
  name: string;
  description: string | null;

  // Pattern matching (all present clauses must match; each is an OR over patterns)
  from_patterns: string[] | null;
  subject_contains: string[] | null;
  body_contains: string[] | null;
  body_not_contains: string[] | null;

  // Action
  action: RuleAction;
  gmail_action: GmailAction | null;
  priority_level: 'high' | 'medium' | 'low' | null;

  // Categorization
  digest_section: string | null;
  assess_against_topics: boolean;
  assigned_domain: string | null;
  assigned_type: string | null;

  // Behavior
  skip_ai_triage: boolean;

  // Metadata
  enabled: boolean;
  priority: number;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TopicOfInterest {
  id: number;
  account_id: number;
  topic_type: 'keyword' | 'domain' | 'exclude';
  value: string;
  description: string | null;
  enabled: boolean;
  created_at: Date;
}

export interface CreateRulePayload {
  rule_id: string;
  name: string;
  description?: string;
  from_patterns?: string[];
  subject_contains?: string[];
  body_contains?: string[];
  body_not_contains?: string[];
  action: RuleAction;
  gmail_action?: GmailAction;
  priority_level?: 'high' | 'medium' | 'low';
  digest_section?: string;
  assess_against_topics?: boolean;
  assigned_domain?: string;
  assigned_type?: string;
  skip_ai_triage?: boolean;
  enabled?: boolean;
  priority?: number;
  notes?: string;
}

export interface CreateTopicPayload {
  topic_type: 'keyword' | 'domain' | 'exclude';
  value: string;
  description?: string;
  enabled?: boolean;
}

// ============================================
// Service Interfaces
// ============================================

export interface SyncResult {
  messagesScanned: number;
  messagesIngested: number;
  messagesUpdated: number;
  messagesSkipped: number;
  errors: string[];
}

export interface TriageResult {
  emailId: number;
  success: boolean;
  analysis?: EmailAnalysis;
  ruleMatched?: string;   // rule_id of a deterministic rule, if one applied
  confidence?: number;
  alerted?: boolean;      // whether the urgent-alert path fired
  error?: string;
}

// ============================================
// Executor
// ============================================

export interface ExecuteResult {
  emailId: number;
  success: boolean;
  appliedLabels?: string[];
  appliedGmailAction?: GmailAction | null;
  skipped?: boolean;      // true when a guardrail (e.g. whitelist) blocked the action
  reason?: string;        // why it was skipped / errored
  error?: string;
}

// ============================================
// Email Analysis Schema (Message-only analysis)
// ============================================

export type SenderType = 'automated' | 'human';
export type MessageType = 'spam' | 'newsletter' | 'alert' | 'group' | 'personal';

/**
 * Consolidated AI analysis output.
 * Extracts only what can be reliably determined from message content alone.
 */
export interface EmailAnalysis {
  overview: string;                   // 1-2 sentence summary
  mentioned_people: string[];         // Names of people mentioned
  mentioned_organizations: string[];  // Names of organizations mentioned
  potential_action_items: string[];   // Plain text action items
  sender_type: SenderType;            // automated or human
  message_type: MessageType;          // spam, newsletter, alert, group, personal
  unsubscribe_link: string | null;    // Extracted unsubscribe URL if present
  rationale: string;                  // Explanation of classification

  // Set by the triage pipeline itself (not the model) when the turn-2 HTML
  // refinement had to truncate an oversized body before it entered the
  // prompt, so a best-effort unsubscribe-link lookup is visible from the
  // stored analysis alone.
  html_truncated?: boolean;

  // Set by the email urgency pipeline (not the turn-1 model): the result of the
  // owner-interest opportunity evaluation, when this was a solicitation-class
  // email. Lets the briefing's attention entry show the one-line reasoning.
  opportunity?: {
    match: boolean;
    high: boolean;
    reasoning: string;
  };

  // Set by the email urgency pipeline: the tier this email earned + why, so the
  // decision is visible from the stored analysis alone (mirrors html_truncated).
  urgency?: {
    tier: 'interrupt' | 'attention' | 'neither';
    reason: string;
    quiet_held?: boolean;
  };
}

// ============================================
// API Payloads
// ============================================

export interface CreateAccountPayload {
  identifier: string;
  email: string;
  display_name?: string;
}

export interface UpdateAccountPayload {
  display_name?: string;
  is_primary?: boolean;
  email_triage_instructions?: string | null;
  email_label_prefix?: string;
  email_label_prefix_todo?: string;
  email_sync_start_date?: string | null; // ISO date string (YYYY-MM-DD) or null
}

export interface CreateAliasPayload {
  alias: string;
  is_owner?: boolean;
  refers_to?: string;
  notes?: string;
}

export interface EmailQueryParams {
  account?: string;
  workflow_status?: WorkflowStatus;
  message_type?: MessageType;
  search?: string;
  with?: string;
  days?: number;
  limit?: number;
  offset?: number;
}

// ============================================
// Plugin Configuration
// ============================================

export interface GooglePluginOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  triageConcurrency?: number;
}
