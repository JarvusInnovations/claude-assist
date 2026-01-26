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
  history_id: string | null;
  is_primary: boolean;
  created_at: Date;
  last_sync_at: Date | null;

  // Settings (merged from account_settings)
  triage_system_instructions: string | null;
  label_prefix_tracking: string;
  label_prefix_todo: string;
  sync_start_date: string | null; // ISO date string (YYYY-MM-DD)
  settings_updated_at: Date;
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

  // Plan
  planned_labels: string[] | null;
  gmail_action: GmailAction | null;
  extractions: Extraction[] | null;

  // Triage Confidence
  triage_confidence: number | null;
  rule_matched_id: number | null;

  // Workflow State
  workflow_status: WorkflowStatus;
  triaged_at: Date | null;
  reviewed_at: Date | null;
  executed_at: Date | null;

  // Execution Results
  applied_labels: string[] | null;
  applied_gmail_action: GmailAction | null;
  applied_extractions: string[] | null;
  execution_notes: string | null;

  // Metadata
  synced_at: Date;
  updated_at: Date;
}

export type EmailType = 'personal' | 'automated';

export type EmailDomain =
  | 'client'
  | 'finance'
  | 'transit'
  | 'infrastructure'
  | 'opportunity'
  | 'project'
  | 'internal'
  | 'marketing';

export type DigestSection =
  | 'calendar'
  | 'financial'
  | 'opportunities'
  | 'newsletters';

export type GmailAction = 'leave' | 'archive' | 'spam';

// WorkflowStatus enum - must stay in sync with google.workflow_status PostgreSQL enum
// Note: Errors are tracked separately via last_error/last_error_at fields
export type WorkflowStatus =
  | 'discovered' // Listed from Gmail but not yet fetched
  | 'new' // Fetched and ready for triage
  | 'triaged'
  | 'reviewed'
  | 'executed';

export interface Extraction {
  type: ExtractionType;
  description: string;
  due_date?: string;
  due_date_note?: string;
  priority?: string;
  quoted_text?: string;
  sender?: string;
  project?: string;
  file?: string;
  notes?: string;
}

export type ExtractionType =
  | 'commitment'
  | 'backlog'
  | 'contact_update'
  | 'calendar_event';

// ============================================
// Rules and Topics
// ============================================

export interface TriageRule {
  id: number;
  account_id: number;
  rule_id: string;
  name: string;
  description: string | null;

  // Pattern matching
  from_patterns: string[] | null;
  subject_contains: string[] | null;
  body_contains: string[] | null;
  body_not_contains: string[] | null;

  // Action
  action: RuleAction;
  gmail_action: GmailAction | null;
  priority_level: 'high' | 'medium' | 'low' | null;

  // Categorization
  digest_section: DigestSection | null;
  assess_against_topics: boolean;
  assigned_domain: EmailDomain | null;
  assigned_type: EmailType | null;

  // Rule behavior
  skip_ai_triage: boolean;

  // Metadata
  enabled: boolean;
  priority: number;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export type RuleAction = 'archive' | 'leave' | 'spam' | 'analyze_relevance';

export interface TopicOfInterest {
  id: number;
  account_id: number;
  topic_type: 'keyword' | 'domain' | 'exclude';
  value: string;
  description: string | null;
  enabled: boolean;
  created_at: Date;
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
  ruleMatched?: string;
  confidence?: number;
  error?: string;
}

// ============================================
// New Email Analysis Schema (Phase 1: Message-only analysis)
// ============================================

export type SenderType = 'automated' | 'human';
export type MessageType = 'spam' | 'newsletter' | 'alert' | 'group' | 'personal';

/**
 * Consolidated AI analysis output.
 * Extracts only what can be reliably determined from message content alone.
 * Domain-specific classification happens in later phases.
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
  triage_system_instructions?: string | null;
  label_prefix_tracking?: string;
  label_prefix_todo?: string;
  sync_start_date?: string | null; // ISO date string (YYYY-MM-DD) or null
}

export interface CreateAliasPayload {
  alias: string;
  is_owner?: boolean;
  refers_to?: string;
  notes?: string;
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
  digest_section?: DigestSection;
  assess_against_topics?: boolean;
  assigned_domain?: EmailDomain;
  assigned_type?: EmailType;
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

export interface EmailQueryParams {
  account?: string;
  workflow_status?: WorkflowStatus;
  message_type?: MessageType;
  search?: string;
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
