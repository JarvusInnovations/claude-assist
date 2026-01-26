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

  // Workflow State
  workflow_status: WorkflowStatus;
  triaged_at: Date | null;

  // Error Tracking
  last_error: string | null;
  last_error_at: Date | null;

  // Metadata
  synced_at: Date;
  updated_at: Date;
}

// WorkflowStatus enum - must stay in sync with google.workflow_status PostgreSQL enum
// Note: Errors are tracked separately via last_error/last_error_at fields
export type WorkflowStatus =
  | 'discovered' // Listed from Gmail but not yet fetched
  | 'new' // Fetched and ready for triage
  | 'triaged';

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
