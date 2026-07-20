# Module: Briefing / Meeting Alerts

Two pipelines share one calendar read path and one classifier: the **daily
briefing** (a digest of the day's meetings, commitments, and other sources)
and **join-required alerts** (a tappable push shortly before a meeting
starts). This file currently documents only the piece both pipelines depend
on most heavily — venue detection and join-link resolution — back-specced
opportunistically per the repo convention (`specs/README.md`); the rest of
the module (briefing composition, alert scheduling, meeting prep) is
implemented but not yet written up here.

## Calendar read path

Events come from `gws-axi calendar events` (a CLI-as-library boundary to
Google Calendar), parsed from its TOON output into a `CalendarEvent`. The
module requests `status,attendees,location,description,hangoutLink,join_url`
— everything the classifier needs to resolve a venue and a join link without
a second round trip.

## Venue detection and the join link

An event's venue (`none` | `video` | `physical`) and its clickable join link
are resolved independently, from the same signals, in the same priority
order — deliberately, since a link source that isn't also a venue signal
would let one disagree with the other:

1. **`join_url`** — gws-axi's structured, provider-uniform join link,
   resolved from the event's structured conferenceData. Populated for
   Microsoft Teams, Zoom, and Webex meetings organized through Calendar's
   conferencing add-ons; Meet meetings usually carry their link via
   `hangoutLink` instead and may leave this empty.
2. **`hangoutLink`** — Google Meet's own field. Kept as a fallback for the
   cases where `join_url` is empty but `hangoutLink` is set.
3. **An explicit `http(s)://` URL in `location`.**
4. **An explicit `http(s)://` URL in `description`.**
5. **A conferencing-service name with no URL anywhere** (the "Outlook invite"
   shape — `location` reads "Microsoft Teams Meeting" and nothing else on the
   event carries a link). This still counts as a `video` venue — the meeting
   is virtual — but yields no join link, since there is no URL to extract.

The **venue** check (`detectVenue`) stops at "does a signal exist" for (1)–(4)
and falls through to (5) as a name-only virtual signal, then to a physical
address, then to `none`. The **join link** check (`conferencingUrl`) walks
the same (1)–(4) in order and returns the first explicit URL found, or `null`
if only (5) or nothing matched.

### Why `join_url` leads

Before gws-axi 0.17.0, this module had no structured signal for
externally-organized Teams/Zoom/Webex meetings: `hangoutLink` is Meet-only,
and the calendar CLI's `description` column truncates long text — often
cutting off exactly the join URL a synced Outlook invite puts there. The
venue still resolved correctly via the name-only-conferencing rule (5), but
the join alert fired with no tappable link. gws-axi 0.17.0 added `join_url`,
resolved server-side from the event's structured conferenceData rather than
scraped from truncatable free text — the fix is to prefer it, ahead of
`hangoutLink` and the location/description scrapes, everywhere a join link or
a conferencing signal is needed. This module now depends on **gws-axi
>= 0.17.0** for that field.

## Applies to

`packages/briefing/src/calendar/gws-axi.ts` (field request + row parsing),
`packages/briefing/src/classifier/join-required.ts` (`detectVenue`,
`conferencingUrl`), `packages/briefing/src/alerts/scheduler.ts` (`alertUrl`,
the alert's tappable action link).
