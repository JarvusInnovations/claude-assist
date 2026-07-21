---
status: in-progress
depends: []
specs:
  - specs/modules/briefing.md
issues: []
pr:
---

# Plan: Join alerts lean on RSVP + call link, not attendee count

## Scope

Fix the join-required classifier so registration/webinar events (and other
call-link events with no real attendee list) earn alerts. The `>= 2 attendees`
gate was silently dropping Teams/Zoom registration stubs the owner had
registered for. The rule now: **a video (call-link) event the owner hasn't
declined is join-required regardless of attendee count**; the attendee
heuristic is kept only for physical venues.

In scope: the `classifyEvent` decision reorder + the `specs/modules/briefing.md`
back-spec of the whole decision tree (previously unspecified). Out of scope:
the model (Haiku) residue pass and alert scheduling, unchanged.

## Implements

- **specs/modules/briefing.md § Join-required decision** — new decision order:
  declined → all-day → hard-noise → no-venue → **video branch** (accepted fires;
  tentative/optional routes to the model; else fires — attendee count NOT
  consulted) → **physical branch** (the `>= 2 attendees` heuristic stays). New
  reason strings `rsvp-accepted+conferencing` / `conferencing+not-declined`.
- **§ Principles: Lean on the RSVP and the call link, not the attendee count** —
  the owner's response + the link decide a call; the owner suppresses unwanted
  calls by declining. Bias toward alerting a not-declined call (a missed pillar
  meeting costs more than a dismissible push).

## Approach

- Reorder `classifyEvent`: move the `no-venue` check ahead of the attendee
  check, split the tail into a video branch (RSVP-lean) and a physical branch
  (attendee heuristic retained). An `accepted` RSVP is decisive — it fires even
  over soft-ambiguous wording; a not-yet-accepted soft-ambiguous video event
  still routes to the model.
- No new fields: `myResponse === ''` (no attendee list) is the registration-stub
  signature and falls through the video branch to `conferencing+not-declined`;
  the model residue and scheduler are untouched.

## Validation

- [x] The two live cases from 2026-07-21 fire: accepted Zoom webinar with 1
      attendee (`rsvp-accepted+conferencing`); Teams registration stub with
      `myResponse: ''` + a description link + 0 attendees
      (`conferencing+not-declined`).
- [x] Declined call-link → no alert; tentative call-link stub → model; accepted
      call fires even with "optional" wording; solo PHYSICAL event still
      `no-other-attendees`.
- [x] Full briefing suite green (408 pass); reason-string + scheduler tests
      updated for the new behavior.
- [ ] `bun run build` green; PR CI green; deployed.

## Risks / unknowns

- **Over-firing on stray-link solo events** — a personal event carrying a call
  link that isn't a hard-noise pattern now alerts. Accepted as the owner's
  explicit tradeoff ("I'll hit no on things I don't want to join"); the decline
  path suppresses, and hard-noise/all-day still catch scaffolding.
- **Duplicate calendar entries** — a webinar can appear twice (real invite +
  no-reply stub). The stub without its own link resolves to `no-venue` and stays
  silent, so the pair yields one alert; a stub that *does* carry the link would
  double. Dedup is the scheduler's concern, out of scope here.

## Notes

(populated at closeout)

## Follow-ups

(populated at closeout)
