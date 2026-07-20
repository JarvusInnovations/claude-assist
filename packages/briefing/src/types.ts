/**
 * Shared types for the briefing + meeting-alert pipelines.
 *
 * Both pipelines read one calendar path (`CalendarEvent`) and share one
 * classifier (`classifyEvent` → `JoinClassification`); the daily briefing then
 * lists the day's alert plan so misclassifications are visible before they bite.
 */

/** the owner's attendee response, straight from gws-axi's `my_response` column. */
export type ResponseStatus =
  | '' // self-organized / no attendee list
  | 'accepted'
  | 'declined'
  | 'tentative'
  | 'needsAction';

/**
 * One calendar event, normalized from a gws-axi `calendar events` row. The raw
 * `start`/`end` are kept verbatim (all-day events are date-only strings, timed
 * events carry an offset) alongside parsed epoch-ms for scheduling math.
 */
export interface CalendarEvent {
  /** Instance id including any recurrence suffix, e.g. `abc_20260710T190000Z`. */
  id: string;
  /** Base recurring-event id (instance suffix stripped) — the override key. */
  seriesId: string;
  summary: string;
  /** Raw start: date-only (all-day) or ISO-with-offset (timed). */
  start: string;
  /** Raw end. */
  end: string;
  allDay: boolean;
  /** Epoch ms of start, or null when unparseable. */
  startMs: number | null;
  /** the owner's response on this event. */
  myResponse: ResponseStatus;
  /** Total attendees incl. the owner (0 when no attendee list). */
  attendeeCount: number;
  /** Physical location, if any (may hold a conferencing URL — see hasUrl). */
  location: string;
  /**
   * Provider-uniform join link from gws-axi's structured `join_url` column
   * (resolved from conferenceData; populated for Teams/Zoom/Webex, and for
   * Meet via hangoutLink when conferenceData itself is empty). Preferred over
   * `hangoutLink`/location/description scraping — see `conferencingUrl`.
   */
  joinUrl: string;
  /** Google Meet link, if any. Kept as a fallback alongside `joinUrl`. */
  hangoutLink: string;
  /** Free-text description (only when requested from gws-axi). */
  description: string;
  status: string;
}

/** How a join decision was reached — deterministic core vs. the Haiku residue. */
export type ClassifierSource = 'deterministic' | 'model' | 'override';

/** A meeting's venue kind — sets the default alert lead time. */
export type VenueKind = 'video' | 'physical' | 'none';

export interface JoinClassification {
  joinRequired: boolean;
  /** Machine-readable reason token, e.g. `conferencing+attendees`, `declined`. */
  reason: string;
  venue: VenueKind;
  source: ClassifierSource;
  /** Present for model classifications. */
  confidence?: number;
}

/** Per-series override — the one-tap correction path. */
export type OverrideAction = 'suppress' | 'force';

export interface SeriesOverride {
  seriesId: string;
  action: OverrideAction;
  /** Custom lead-time minutes; null → use the venue default. */
  leadMinutes: number | null;
  note: string | null;
}

/** A fully-resolved alert decision for one event on a given day. */
export interface AlertPlanItem {
  event: CalendarEvent;
  classification: JoinClassification;
  /** null when not join-required. */
  leadMinutes: number | null;
  /** Epoch ms at which the alert should fire, or null. */
  fireAtMs: number | null;
}
