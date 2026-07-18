/**
 * Join-required classifier — deterministic core.
 *
 * An event earns an alert when it's a real meeting the owner must join: it has a
 * venue (conferencing link or physical location) AND other attendees AND the owner
 * hasn't declined AND it isn't an all-day / hold / focus-block pattern. The
 * obvious cases resolve here for free; the genuinely ambiguous residue
 * (`joinRequired: null`) is handed to the Haiku pass (llm.ts). A per-series
 * override always wins — that's the one-tap correction path.
 *
 * Lead times: video calls alert 1 min out (just enough to tab over — alerts
 * landing earlier than that get dismissed and forgotten); physical locations
 * alert 15 min out (travel). An override's custom lead wins.
 */

import type {
  CalendarEvent,
  JoinClassification,
  SeriesOverride,
  VenueKind,
} from '../types.js';

/**
 * Video lead is 1 minute: just enough to tab over to the call. Anything earlier
 * lands while you're still mid-task, gets dismissed, and is forgotten by start.
 */
export const DEFAULT_VIDEO_LEAD_MINUTES = 1;
export const DEFAULT_PHYSICAL_LEAD_MINUTES = 15;

/**
 * Hard-noise summary patterns: holds, focus blocks, OOO, personal blockers.
 * These never alert regardless of venue/attendees — they're the calendar's
 * scaffolding, not meetings.
 */
const HARD_NOISE = [
  /\bfocus\b/i,
  /\bfocus time\b/i,
  /\bdeep work\b/i,
  /\bhold\b/i,
  /\bblock(ed|er)?\b/i,
  /\bplaceholder\b/i,
  /\bdo not (schedule|book|disturb)\b/i,
  /\bdnd\b/i,
  /\bbusy\b/i,
  /\bo\.?o\.?o\.?\b/i,
  /\bout of office\b/i,
  /\bpto\b/i,
  /\bvacation\b/i,
  /\blunch\b/i,
  /\bbreak\b/i,
  /\bcommute\b/i,
  /\btravel time\b/i,
  /\bno meetings\b/i,
  /\bwork(ing)? from home\b/i,
  /\bwfh\b/i,
];

/**
 * Soft-ambiguous signals: the structure looks join-worthy but the framing hints
 * it may be optional / tentative. These get routed to the model rather than
 * auto-firing or auto-suppressing.
 */
const SOFT_AMBIGUOUS = [
  /\boptional\b/i,
  /\btentative\b/i,
  /\bmaybe\b/i,
  /\bif needed\b/i,
  /\bfyi\b/i,
  /\bcancel(l)?ed\b/i,
  /\?\s*$/,
];

const URL_RE = /https?:\/\/|meet\.google\.com|zoom\.us|teams\.microsoft|webex\.|whereby\.com/i;

/**
 * Conferencing-service NAMES that show up as the entire substance of a location
 * field with no URL at all — the signature of an Outlook-originated invite
 * ("Microsoft Teams Meeting", "Zoom Meeting", …), where the synced description
 * often carries no link either. These are virtual meetings; without this check
 * they'd fall through to the physical branch and get a travel-sized lead.
 * Word-boundary matched so "Zoom Meeting" or "Microsoft Teams Meeting;
 * conference ID 123" hit but a street address never does.
 */
const CONFERENCING_NAME_RE =
  /\b(?:microsoft teams|teams meeting|zoom|google meet|meet\.google|webex|gotomeeting|hangouts?)\b/i;

/**
 * True when the location text names a conferencing service (no URL required).
 * This classifies venue only — it never yields a join link (there's no URL to
 * extract), which `conferencingUrl` handles correctly by returning null.
 */
export function locationIsConferencingName(location: string): boolean {
  return CONFERENCING_NAME_RE.test(location);
}

export function matchNoisePattern(summary: string): RegExp | null {
  return HARD_NOISE.find((re) => re.test(summary)) ?? null;
}

function hasSoftAmbiguity(event: CalendarEvent): boolean {
  if (event.myResponse === 'tentative') return true;
  return SOFT_AMBIGUOUS.some((re) => re.test(event.summary));
}

export function locationHasUrl(location: string): boolean {
  return URL_RE.test(location);
}

/** Physical location = a non-empty location that isn't just a conferencing URL. */
export function hasPhysicalLocation(location: string): boolean {
  const l = location.trim();
  if (!l) return false;
  if (URL_RE.test(l) && !/\d|\bst\b|\bstreet\b|\bave\b|\broom\b|\bfloor\b|,/i.test(l)) {
    // Pure URL with no address-like tokens → treat as conferencing, not physical.
    return false;
  }
  return true;
}

export function detectVenue(event: CalendarEvent): VenueKind {
  const conferencing =
    !!event.hangoutLink || locationHasUrl(event.location) || URL_RE.test(event.description);
  const physical = hasPhysicalLocation(event.location);
  // Physical wins for lead-time purposes when travel is implied; but a Meet link
  // on a physically-located event still reads as attendable remotely → video.
  if (conferencing) return 'video';
  // No URL anywhere, but the location names a conferencing service — the
  // Outlook-invite shape. Virtual, despite the populated location field.
  if (locationIsConferencingName(event.location)) return 'video';
  if (physical) return 'physical';
  return 'none';
}

/** An explicit http(s) URL, trimmed of trailing punctuation a sentence might add. */
const HTTP_URL_RE = /https?:\/\/[^\s<>"')]+/i;

/**
 * The clickable link for a "Join" action on an alert, checked in the same
 * priority order as `detectVenue`: hangoutLink, then location, then
 * description. Returns null when none of those hold an explicit http(s) link —
 * a bare domain mention (e.g. "zoom.us/j/1" with no scheme, which still counts
 * toward `detectVenue`'s conferencing check) isn't trivially safe to turn into
 * a link, so it's left out rather than guessed at.
 */
export function conferencingUrl(event: CalendarEvent): string | null {
  if (event.hangoutLink) return event.hangoutLink;
  return (
    event.location.match(HTTP_URL_RE)?.[0].replace(/[.,;:]+$/, '') ??
    event.description.match(HTTP_URL_RE)?.[0].replace(/[.,;:]+$/, '') ??
    null
  );
}

/**
 * Classify one event. Returns a resolved `JoinClassification`, or one with
 * `joinRequired`/reason `ambiguous` when the model should decide. An override
 * short-circuits everything.
 */
export function classifyEvent(
  event: CalendarEvent,
  override?: SeriesOverride | null
): JoinClassification {
  if (override) {
    return {
      joinRequired: override.action === 'force',
      reason: `override:${override.action}`,
      venue: detectVenue(event),
      source: 'override',
    };
  }

  const venue = detectVenue(event);

  if (event.myResponse === 'declined') {
    return { joinRequired: false, reason: 'declined', venue, source: 'deterministic' };
  }
  if (event.allDay) {
    return { joinRequired: false, reason: 'all-day', venue, source: 'deterministic' };
  }
  const noise = matchNoisePattern(event.summary);
  if (noise) {
    return {
      joinRequired: false,
      reason: `noise-pattern:${noise.source}`,
      venue,
      source: 'deterministic',
    };
  }

  const hasOthers = event.attendeeCount >= 2;
  if (!hasOthers) {
    return { joinRequired: false, reason: 'no-other-attendees', venue, source: 'deterministic' };
  }
  if (venue === 'none') {
    return { joinRequired: false, reason: 'no-venue', venue, source: 'deterministic' };
  }

  // Structurally join-worthy. Clean → decisive; soft-ambiguous → model residue.
  if (hasSoftAmbiguity(event)) {
    return { joinRequired: false, reason: 'ambiguous', venue, source: 'deterministic' };
  }

  return {
    joinRequired: true,
    reason: venue === 'physical' ? 'location+attendees' : 'conferencing+attendees',
    venue,
    source: 'deterministic',
  };
}

/** True when the event needs the model's judgment (structural pass + soft signal). */
export function isAmbiguous(classification: JoinClassification): boolean {
  return classification.reason === 'ambiguous' && classification.source === 'deterministic';
}

/** Resolve the lead time (minutes) for a join-required classification + override. */
export function leadMinutesFor(
  classification: JoinClassification,
  override?: SeriesOverride | null
): number {
  if (override?.leadMinutes != null) return override.leadMinutes;
  return classification.venue === 'physical'
    ? DEFAULT_PHYSICAL_LEAD_MINUTES
    : DEFAULT_VIDEO_LEAD_MINUTES;
}
