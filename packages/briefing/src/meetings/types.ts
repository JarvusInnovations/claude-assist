/**
 * Types for the per-meeting briefing (prep) pipeline.
 *
 * A "prep" is a model-composed briefing artifact for one occurrence of a
 * meeting. Preps live on the virtuous cycle: processing occurrence N (its end /
 * transcript) seeds the prep for N+1, a 24h-ahead pass refreshes it, and
 * captures routed to the meeting series fold in between occurrences.
 *
 * Occurrence identity is the load-bearing concept — see occurrence.ts.
 */

/**
 * Lifecycle of one occurrence's prep. Monotonic in practice:
 *   draft      — composed, not yet rendered into Tana.
 *   delivered  — composed AND rendered into the occurrence's Tana surface.
 *   refreshed  — re-composed with newer inputs after an earlier delivery and
 *                re-rendered (the 24h-ahead / rolling-capture path).
 */
export type MeetingPrepStatus = 'draft' | 'refreshed' | 'delivered';

/**
 * Stable identity for one occurrence of a (possibly recurring) meeting.
 *
 * The calendar instance id already encodes series + original-start (gws-axi
 * appends `_YYYYMMDD[THHMMSSZ]` to the base id), and Google keeps that suffix
 * anchored to the ORIGINAL start across reschedules — so the instance id is the
 * reschedule-stable occurrence key, while `occurrenceStart` tracks the actual
 * (possibly moved) start.
 */
export interface OccurrenceIdentity {
  /** Base recurring-event id (instance suffix stripped). Equals occurrenceKey for one-offs. */
  seriesKey: string;
  /** The calendar instance id — series + original-start; reschedule-stable. The PK. */
  occurrenceKey: string;
  /** Actual start (raw calendar string: date-only or ISO-with-offset), possibly rescheduled. */
  occurrenceStart: string;
  /** Epoch ms of the actual start, or null when unparseable. */
  occurrenceStartMs: number | null;
  /** The original start parsed from the instance suffix (null for one-offs / no suffix). */
  originalStart: string | null;
  summary: string;
}

/** A stored prep row (camelCase view of briefing.meeting_preps). */
export interface MeetingPrep {
  occurrenceKey: string;
  seriesKey: string;
  /** ISO timestamp of the occurrence start, or null. */
  occurrenceStart: string | null;
  summary: string | null;
  status: MeetingPrepStatus;
  /** The composed prep artifact (Tana-paste-ready outline / markdown-ish text). */
  prepContent: string | null;
  /** Hash of the inputs the current prep was composed from — skips redundant recompose. */
  inputsDigest: string | null;
  /** Model id that composed the current content ('deterministic' when no model wired). */
  model: string | null;
  /** Tana node id the prep was rendered into (for the link-out + idempotent re-render). */
  deliveredNodeId: string | null;
  generatedAt: string | null;
  refreshedAt: string | null;
  deliveredAt: string | null;
}
