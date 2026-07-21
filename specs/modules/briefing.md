# Module: Briefing / Meeting Alerts

Two pipelines share one calendar read path and one classifier: the **daily
briefing** (a digest of the day's meetings, commitments, and other sources)
and **join-required alerts** (a tappable push shortly before a meeting
starts). This file currently documents only the piece both pipelines depend
on most heavily — venue detection, join-link resolution, and the
join-required decision — back-specced opportunistically per the repo
convention (`specs/README.md`); the rest of the module (briefing composition,
alert scheduling, meeting prep) is implemented but not yet written up here.

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

## Join-required decision

Whether an event earns a join alert is decided deterministically where the
signals are unambiguous, with a narrow ambiguous residue handed to a Haiku
pass. A per-series override always wins first (the one-tap correction path).
Absent an override, the order is:

1. **Declined** (`myResponse === 'declined'`) → no alert. The owner opting out
   is the strongest signal there is.
2. **All-day** → no alert (holds, "Office", OOO spans — not a meeting to join).
3. **Hard-noise summary** (focus / hold / block / placeholder / DND / OOO /
   PTO / lunch / commute / WFH …) → no alert, regardless of venue. Calendar
   scaffolding, not meetings.
4. **No venue** (no join link, no conferencing-name, no physical location) →
   no alert. Nothing to join.
5. **Video venue (a call link) the owner hasn't declined → join-required,
   regardless of attendee count.** This is the decisive rule: a real
   conferencing link is a stronger "this is a joinable meeting" signal than
   the attendee list. An **accepted** RSVP fires immediately (an explicit yes
   wins even over soft-ambiguous wording); otherwise a **soft-ambiguous**
   signal (a `tentative` response, or `optional`/`maybe`/`FYI`/`?`-tailed
   wording) routes to the model, and everything else fires. The attendee count
   is **not** consulted for video events.
6. **Physical venue** (a real address, no call link) → the attendee heuristic
   still applies: fewer than two attendees reads as a personal block or a
   solo hold and does not alert; two or more, absent soft-ambiguity, alert
   (soft-ambiguous → model).

### Why the call link beats the attendee count

The attendee count was a proxy for "is this a real, shared meeting." It breaks
for the flows that carry a join link but no attendee list: Microsoft Teams /
Zoom **registration and webinar events** land on the calendar as a stub (or a
"Hosted virtually … link in the description" placeholder) with the owner as
the only attendee — or none — so a `>= 2 attendees` gate silently drops
exactly the calls the owner registered for. Broken or partial attendee syncs
on ordinary 1:1s fail the same way. Since a genuine call link already means
"there is something to join," the count adds only false negatives there; the
owner suppresses the rare unwanted call-link event by **declining** it, which
rule 1 already honors. The count is kept only for physical events, where "no
other attendees" genuinely distinguishes a meeting from a personal block.

## Principles

**Local**

- **Lean on the RSVP and the call link, not the attendee count.** For anything
  with a conferencing link, the owner's response (declined suppresses, accepted
  fires) and the mere presence of the link decide the alert; the attendee list
  is unreliable for registration/webinar/broken-sync events and is not
  consulted. Bias toward alerting a not-declined call and let the owner decline
  the ones they don't want — a missed pillar meeting costs far more than a
  dismissible extra push.

## Applies to

`packages/briefing/src/calendar/gws-axi.ts` (field request + row parsing),
`packages/briefing/src/classifier/join-required.ts` (`detectVenue`,
`conferencingUrl`, `classifyEvent`), `packages/briefing/src/alerts/scheduler.ts`
(`alertUrl`, the alert's tappable action link).
