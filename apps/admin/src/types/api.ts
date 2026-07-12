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
  with?: string;
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
  user_message_count: number;
  claude_version: string | null;
  synced_at: string;
  outline: string | null;
  title: string | null;
  session_name: string | null;
  outline_hash: string | null;
  models_used: string[];
  model_tokens: Record<string, ModelTokens>;
}

export interface ActivityRange {
  start: string;
  end: string;
  duration_minutes: number;
}

export interface ActivitySession {
  id: string;
  title: string | null;
  session_name: string | null;
  project_path: string | null;
  project_name: string | null;
  activity_ranges: ActivityRange[];
  total_active_minutes: number;
}

export interface SessionQueryParams {
  search?: string;
  machine?: string;
  project?: string;
  days?: number;
  since?: string;
  until?: string;
  forever?: string;
  limit?: number;
  offset?: number;
  tools?: string;
  files_read?: string;
  files_written?: string;
  min_user_messages?: number;
  include_empty?: string;
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

export interface SessionShare {
  auth_code: string;
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

// ============================================
// Capture Module Types
// ============================================

export type CaptureStatus =
  | "queued"
  | "classified"
  | "awaiting_executor"
  | "awaiting_review"
  | "routed";

export type CaptureType =
  | "stray_thought"
  | "link_reference"
  | "actionable"
  | "team_relevant";

export interface LinkMetadata {
  url: string;
  final_url?: string;
  title?: string;
  description?: string;
  site_name?: string;
  fetch_error?: string;
}

export interface CaptureClassification {
  type: CaptureType;
  confidence: number;
  title: string | null;
  rationale: string;
  classifier: "model" | "deterministic" | "correction";
  model?: string;
  links?: LinkMetadata[];
}

export interface CaptureRecord {
  ulid: string;
  source: "app" | "slack" | "terminal";
  text: string;
  type_hint: string | null;
  urls: string[];
  tags: string[];
  payload: Record<string, unknown>;
  captured_at: string;
  received_at: string;
  status: CaptureStatus;
  classification: CaptureClassification | null;
  classified_at: string | null;
  classify_attempts: number;
  route_destination: string | null;
  route_attempts: number;
  routed_at: string | null;
  route_result: Record<string, unknown> | null;
  last_error: string | null;
  last_error_at: string | null;
}

export interface CaptureListResponse {
  captures: CaptureRecord[];
  count: number;
}

export interface ReferenceRecord {
  capture_ulid: string;
  url: string;
  final_url: string | null;
  title: string | null;
  description: string | null;
  site_name: string | null;
  notes: string;
  tags: string[];
  source: string;
  captured_at: string;
  extra_urls: LinkMetadata[];
  fetch_error: string | null;
}

export interface ReferenceListResponse {
  references: ReferenceRecord[];
  count: number;
}

// ============================================
// Notify Module Types
// ============================================

export type NotificationPriority = "interrupt" | "notice" | "digest";
export type NotificationStatus = "sent" | "pending" | "error";

export interface NotificationLogEntry {
  id: number;
  ts: string;
  priority: NotificationPriority;
  title: string;
  body: string;
  delivered_via: string[];
  url_redacted: string | null;
  payload_hash: string | null;
  status: NotificationStatus;
  error: string | null;
}

export interface NotificationListResponse {
  notifications: NotificationLogEntry[];
  count: number;
}

export interface HeartbeatEntry {
  name: string;
  last_success_at: string | null;
  threshold_interval: string;
  source: "heartbeat" | "manual";
  ledger_path: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface HeartbeatListResponse {
  heartbeats: HeartbeatEntry[];
}

// ============================================
// Briefing (Meeting Alerts) Types
// ============================================

export type OverrideAction = "suppress" | "force";

export interface SeriesOverride {
  seriesId: string;
  action: OverrideAction;
  leadMinutes: number | null;
  note: string | null;
}

export interface OverrideListResponse {
  overrides: SeriesOverride[];
}

export interface AlertPlanItem {
  eventId: string;
  seriesId: string | null;
  summary: string;
  start: string;
  joinRequired: boolean;
  reason: string;
  venue: string | null;
  source: string;
  leadMinutes: number | null;
  fireAt: string | null;
}

export interface AlertPlan {
  date: string;
  calendarError: string | null;
  items: AlertPlanItem[];
}

// ============================================
// Slack Urgency Types
// ============================================

export interface UrgencyCandidate {
  channel: string;
  ts: string;
  thread_ts: string | null;
  channel_type: string;
  sender: string;
  sender_name: string | null;
  text: string;
  permalink: string | null;
  tier: string;
  verdict: string;
  classifier: string;
  model: string | null;
  gist: string | null;
  signals: string[];
  rationale: string | null;
  confidence: number | null;
  interrupted: boolean;
  near_miss: boolean;
  notification_id: number | null;
  message_ts: string;
  created_at: string;
}

export interface NearMissListResponse {
  near_misses: UrgencyCandidate[];
  count: number;
}

export interface InterruptListResponse {
  interrupts: UrgencyCandidate[];
  count: number;
}

export interface UrgencyCorrectionResponse {
  corrected: string;
  sender: string;
  channel: string;
  sender_weight: number;
  channel_weight: number;
}

// ============================================
// Session Classification Types
// ============================================

export type ClassificationEventType =
  | "correction"
  | "friction"
  | "rule-candidate"
  | "notable-decision";

export interface ClassificationEvent {
  id: string;
  session_id: string;
  seq_start: number;
  seq_end: number;
  event_type: ClassificationEventType;
  summary: string;
  confidence: number;
  quote: string | null;
  model: string | null;
  created_at: string;
  project_path: string | null;
  git_branch: string | null;
  title: string | null;
}

export interface SynthesisReport {
  id: string;
  kind: string;
  period_start: string;
  period_end: string;
  report: string;
  event_count: number;
  created_at: string;
}

// ============================================
// Email Digest (interactive confirm-to-execute) Types
// ============================================

// Deterministic action the executor takes in Gmail. 'spam' quarantines (moves
// to the Spam folder) — it is NEVER deleted/trashed.
export type GmailAction = "leave" | "archive" | "spam";

// Legacy history-row shape (raw email detail as returned by the history route).
export interface DigestEmail {
  id: number;
  account_identifier: string;
  from_address: string | null;
  from_name: string | null;
  subject: string | null;
  date: string | null;
  digest_section: string | null;
  gmail_action: GmailAction | null;
  planned_labels: string[] | null;
  workflow_status: string;
  analysis: EmailAnalysis | null;
}

export type DigestRenderMode = "summary" | "listed";
export type SenderKind = "human" | "automated";

// One assembled email in a section (digest v2 payload).
export interface DigestItem {
  id: number;
  account_identifier: string;
  from_address: string | null;
  from_name: string | null;
  subject: string | null;
  date: string | null;
  gist: string | null;
  sender_kind: SenderKind;
  planned_action: GmailAction;
  planned_labels: string[] | null;
  digest_section: string | null;
  workflow_status: string;
  is_newsletter: boolean;
  age_days: number | null;
  rolled_over: boolean;
}

export interface DigestSectionPayload {
  key: string;
  title: string;
  render: DigestRenderMode;
  count: number;
  summary: string[] | null;
  items: DigestItem[];
}

export interface DigestPendingResponse {
  count: number;
  sections: DigestSectionPayload[];
}

export interface DigestHistoryResponse {
  count: number;
  days: number;
  emails: DigestEmail[];
}

// Sender standing + classification refinements (digest v2 affordances).
export type SenderStanding = "whitelist" | "unsubscribe_queue";

export interface SenderStandingRow {
  sender_email: string;
  standing: SenderStanding;
  set_at: string;
  source: string | null;
}

export interface ClassificationRefinement {
  id: number;
  email_id: number;
  from_class: string | null;
  to_class: string;
  note: string | null;
  status: "pending" | "resolved";
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ExecuteResult {
  emailId: number;
  success: boolean;
  appliedLabels?: string[];
  appliedGmailAction?: GmailAction | null;
  skipped?: boolean;
  reason?: string;
  error?: string;
}

export interface ExecuteResponse {
  requested: number;
  succeeded: number;
  failed: number;
  results: ExecuteResult[];
}
