/**
 * Capture module types
 *
 * The capture contract: clients send a ULID + raw text (plus optional
 * freeform hints) and make zero routing decisions. Everything below the
 * CaptureInput line is server-side enrichment.
 */

export type CaptureSource = 'app' | 'slack' | 'terminal';

export const CAPTURE_SOURCES: readonly CaptureSource[] = ['app', 'slack', 'terminal'];

/**
 * Classification taxonomy. Extending it (e.g. the future `diet` type) means:
 * add the label here, teach the classifier prompt, and map it to a
 * destination in ROUTING_TABLE (src/state.ts) — the schema doesn't change.
 */
export type CaptureType =
  | 'stray_thought'
  | 'link_reference'
  | 'actionable'
  | 'team_relevant';

export const CAPTURE_TYPES: readonly CaptureType[] = [
  'stray_thought',
  'link_reference',
  'actionable',
  'team_relevant',
];

export type CaptureStatus =
  | 'queued'
  | 'classified'
  | 'awaiting_executor'
  | 'awaiting_review'
  | 'routed';

/** Metadata fetched for a captured URL */
export interface LinkMetadata {
  url: string;
  final_url?: string;
  title?: string;
  description?: string;
  site_name?: string;
  fetch_error?: string;
}

/** Stored in captures.classification (JSONB) */
export interface Classification {
  type: CaptureType;
  /** 0..1; deterministic and correction classifications are 1 */
  confidence: number;
  /** Short display title for review surfaces (model-suggested) */
  title: string | null;
  rationale: string;
  classifier: 'model' | 'deterministic' | 'correction';
  model?: string;
  /** Fetched metadata for every URL found in the capture */
  links?: LinkMetadata[];
}

/** What clients POST to /api/capture */
export interface CaptureInput {
  ulid: string;
  source: CaptureSource;
  text: string;
  /** Freeform type hint — advisory input to the classifier, never trusted */
  type?: string;
  urls?: string[];
  tags?: string[];
  /** Type-specific extension data (future diet entries, share-sheet extras) */
  payload?: Record<string, unknown>;
  /** Client clock; defaults to receive time when omitted */
  captured_at?: string;
}

/** A row in capture.captures */
export interface CaptureRecord {
  ulid: string;
  source: CaptureSource;
  text: string;
  type_hint: string | null;
  urls: string[];
  tags: string[];
  payload: Record<string, unknown>;
  captured_at: Date;
  received_at: Date;
  status: CaptureStatus;
  classification: Classification | null;
  classified_at: Date | null;
  classify_attempts: number;
  route_destination: string | null;
  route_attempts: number;
  routed_at: Date | null;
  route_result: Record<string, unknown> | null;
  last_error: string | null;
  last_error_at: Date | null;
}

/** A row in capture.references */
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
  captured_at: Date;
  extra_urls: LinkMetadata[];
  fetch_error: string | null;
}
