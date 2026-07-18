/**
 * Types for the session-classification pipeline: per-session incremental
 * cursors, append-only classification events, and weekly synthesis reports.
 */

/**
 * The typed event classes detected over each new message window. `correction`
 * is the highest-value class (the owner correcting the assistant's work or facts).
 */
export const CLASSIFICATION_EVENT_TYPES = [
  'correction',
  'friction',
  'rule-candidate',
  'notable-decision',
] as const;

export type ClassificationEventType = (typeof CLASSIFICATION_EVENT_TYPES)[number];

/** A single event as returned by the classifier (pre-persistence). */
export interface DetectedEvent {
  type: ClassificationEventType;
  /** One-line description of the signal. */
  summary: string;
  /** 0.0–1.0. */
  confidence: number;
  /** Verbatim snippet from the transcript, or null. */
  quote: string | null;
}

/** The per-session classification cursor row. */
export interface ClassificationCursor {
  session_id: string;
  last_seq: number;
  last_hash: string | null;
  message_count: number;
  final_pass_done: boolean;
  attempts: number;
  last_classified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** A persisted classification event. */
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
  created_at: Date;
}

/**
 * An event enriched with its session's context, for the weekly synthesis and
 * narrative (which reason across sessions, not within one).
 */
export interface ClassificationEventWithContext extends ClassificationEvent {
  project_path: string | null;
  git_branch: string | null;
  title: string | null;
}

/** A session that was active in a period, for the narrative's "what moved" view. */
export interface ActiveSessionSummary {
  id: string;
  project_path: string | null;
  title: string | null;
  session_name: string | null;
  started_at: Date;
  ended_at: Date | null;
  event_count: number;
}

/** Structured payload the weekly synthesis emits (also rendered to markdown). */
export interface SynthesisPayload {
  proposed_memory_updates: string[];
  proposed_changes: Array<{
    target: 'rule' | 'hook' | 'skill' | 'spec' | 'protocol' | 'memory';
    summary: string;
    rationale: string;
  }>;
  friction_hotspots: Array<{
    area: string;
    count: number;
    examples: string[];
  }>;
}

/** A session row the sweep needs to classify a delta. */
export interface SessionForClassification {
  id: string;
  project_path: string | null;
  git_branch: string | null;
  raw_transcript: string;
  transcript_hash: string;
  ended_at: Date | null;
  output_tokens: string; // BIGINT as string from postgres.js
  cursor_last_seq: number | null;
  cursor_last_hash: string | null;
  cursor_final_pass_done: boolean | null;
}
