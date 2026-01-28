// ============================================
// Google Module Types
// ============================================

export interface GoogleAccount {
  id: number;
  identifier: string;
  email: string;
  display_name: string | null;
  has_credentials: boolean;
  is_primary: boolean;
  created_at: string;
  settings_updated_at: string;
  email_history_id: string | null;
  email_last_sync_at: string | null;
  email_sync_start_date: string | null;
  email_triage_instructions: string | null;
  email_label_prefix: string;
  email_label_prefix_todo: string;
}

export interface UserAlias {
  id: number;
  account_id: number;
  alias: string;
  is_owner: boolean;
  refers_to: string | null;
  notes: string | null;
  created_at: string;
}

export type WorkflowStatus = "discovered" | "new" | "triaged";
export type SenderType = "automated" | "human";
export type MessageType = "spam" | "newsletter" | "alert" | "group" | "personal";

export interface EmailAnalysis {
  overview: string;
  mentioned_people: string[];
  mentioned_organizations: string[];
  potential_action_items: string[];
  sender_type: SenderType;
  message_type: MessageType;
  unsubscribe_link: string | null;
  rationale: string;
}

export interface EmailRecord {
  id: number;
  account_id: number;
  message_id: string;
  thread_id: string | null;
  date: string | null;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string | null;
  snippet: string | null;
  gmail_labels: string[] | null;
  body_text: string | null;
  body_html: string | null;
  has_attachments: boolean;
  analysis: EmailAnalysis | null;
  workflow_status: WorkflowStatus;
  triaged_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  synced_at: string;
  updated_at: string;
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

export interface EmailStats {
  total: number;
  byStatus: Record<WorkflowStatus, number>;
  byMessageType: Record<MessageType, number>;
  bySenderType: Record<SenderType, number>;
}

export interface TriageProgress {
  total: number;
  completed: number;
  inProgress: boolean;
}

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
  email_sync_start_date?: string | null;
}

export interface CreateAliasPayload {
  alias: string;
  is_owner?: boolean;
  refers_to?: string;
  notes?: string;
}

// ============================================
// Sessions Module Types
// ============================================

export interface ModelTokens {
  input: number;
  output: number;
  cacheRead: number;
}

export interface MachineRecord {
  id: number;
  machine_id: string;
  hostname: string | null;
  is_localhost: boolean;
  first_seen_at: string;
  last_sync_at: string | null;
  session_count: number;
}

export interface SessionRecord {
  id: string;
  machine: string;
  project_path: string | null;
  git_branch: string | null;
  started_at: string;
  ended_at: string | null;
  user_messages: string[];
  tools_used: string[];
  files_touched: { reads: string[]; writes: string[] };
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  transcript_path: string | null;
  transcript_hash: string;
  message_count: number;
  claude_version: string | null;
  synced_at: string;
  outline: string | null;
  title: string | null;
  outline_hash: string | null;
  models_used: string[];
  model_tokens: Record<string, ModelTokens>;
}

export interface SessionQueryParams {
  search?: string;
  machine?: string;
  project?: string;
  days?: number;
  limit?: number;
  offset?: number;
  tools?: string[];
}

export interface SessionStats {
  totalSessions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  topTools: Array<{ tool: string; count: number }>;
  byMachine: Array<{ machine_id: string; hostname: string | null; count: number }>;
  byModel: Array<{ model: string; input: number; output: number; cacheRead: number }>;
}

export interface OutlineProgress {
  total: number;
  completed: number;
  inProgress: boolean;
}

// ============================================
// System Types
// ============================================

export interface ScheduledTask {
  name: string;
  schedule: string;
  nextRun: string | null;
}

export interface HealthStatus {
  status: "ok" | "error";
  timestamp: string;
}

// ============================================
// Bulk Action Types
// ============================================

export interface BulkActionPayload {
  emailIds: number[];
  action: string;
}

export interface BulkActionResponse {
  success: boolean;
  action: string;
  count: number;
  message: string;
  error?: string;
}
