---
status: done
depends: []
specs:
  - specs/modules/chat.md
issues: []
pr: 278
---

# Plan: hand Slack events off to another consumer

## Scope

The chat module answers the owner's direct messages and drops every other
event. It is also the only Socket Mode connection on the Slack app: a second
connection on the same app token would split the events between the two.
So another consumer that needs Slack events, such as a long-running agent
session's wake file, has no way to hear them.

In scope:

- An optional hand-off: when configured, mentions, channel / private-channel
  / group-DM messages (thread replies included) and reactions are passed to
  an external command as JSON on stdin, with no agent run.
- Owner-only by default, with an `any` setting; the bot's own posts are
  handed off and flagged so a consumer can remember the threads it started.
- De-duplication of Slack retries by event id.
- Failure isolation: a failing command never crashes the listener or blocks
  direct messages; it is logged with the event id and counted.
- The Slack app additions an operator must make, in the spec and in a docs
  snippet.

Out of scope:

- Any change to the direct-message path: the capture sigil, attachments and
  per-thread agent sessions behave as before.
- A heartbeat or a notification for hand-off failures (see the spec's
  § Failure behaviour for why).
- A manifest for any real app.

## Implements

- `specs/modules/chat.md` § Who and where (non-owner DMs stay ignored),
  § Event hand-off (configuration, which events, payload, failure
  behaviour, Slack app requirements), and the "one connection, many
  listeners" principle.

## Approach

- `packages/chat/src/handoff.ts`: config parsing, a pure `selectHandoff`
  that holds the whole selection rule and builds the payload, a
  `spawnRunner` (no shell, stdin, timeout, SIGKILL on timeout) and
  `createHandoff` (retry de-duplication, counters, never throws).
- `packages/chat/src/router.ts`: `createEventRouter` sends each event to
  exactly one place: the owner's DMs to the agent handler, the rest to the
  hand-off (or nowhere).
- `index.ts`: the DM body moves into `handleDirectMessage`; the `message`
  listener calls the router; `app_mention` and `reaction_added` listeners
  are registered only when the hand-off is configured; Bolt's `ignoreSelf`
  is turned off only when the hand-off is configured, so absent config
  nothing changes.
- Config: `CHAT_HANDOFF_COMMAND` (JSON argv, the `CHAT_CONTEXT_COMMANDS` /
  `SESSION_SPAWN_CMD` convention), `CHAT_HANDOFF_EVENTS`,
  `CHAT_HANDOFF_AUTHORS`, `CHAT_HANDOFF_TIMEOUT_MS`, parsed in the server
  and passed as `chatConfig.handoff`. Malformed values log and fall back
  rather than failing boot.

## Validation

- [x] Unit: the owner's DM reaches the agent handler unchanged with the
      hand-off on and off, and nothing is handed off.
- [x] Unit: non-owner, bot and edited DMs are neither answered nor handed
      off, even under `any`.
- [x] Unit: an owner mention is handed off with the exact JSON shape and
      no agent run.
- [x] Unit: a non-owner mention is not handed off under `owner` and is
      under `any`.
- [x] Unit: channel, private-channel and group-DM messages (thread replies
      included) are handed off; edits, deletions and joins are not; the
      bot's own posts are handed off flagged `is_self`; other bots only
      under `any`; the bot's own reactions never.
- [x] Unit: a retried event id is handed off once.
- [x] Unit: a failing command does not throw, is logged with the event id
      and counted, and a following DM is still answered.
- [x] Unit: absent config, mentions, reactions and channel messages spawn
      nothing.
- [x] Unit: the real runner writes the JSON to stdin with no argv from the
      event, and rejects on non-zero exit, timeout and a missing binary.
- [x] Slack event and scope names checked against Slack's current event
      reference pages.
- [x] CI steps (builds, `type-check:axi`, `check:skills`, `bun run test`)
      pass locally.

## Risks / unknowns

- With the hand-off on, Bolt's `ignoreSelf` is off, so the bot's own
  message events reach the `message` listener. The DM path already drops
  every message with a `bot_id`, which is what keeps the agent from
  answering itself; a unit test covers it.
- The retry de-duplication is in memory: a restart between Slack's original
  delivery and its retry can hand an event off twice.

## Notes

- Failures are surfaced in the logs only. A heartbeat would alarm on quiet
  weeks, and the notify dispatcher is not visible from the chat module's
  registration context. The reasoning is in the spec.

## After this plan

- Live check, after an operator adds the Slack app events and scopes in
  `docs/chat-event-handoff.md` and sets `CHAT_HANDOFF_COMMAND`: a mention
  of the bot in a channel reaches the command once, a DM to the bot is
  still answered, and a broken command shows up as an error log line with
  the event id.

## Follow-ups

None.
