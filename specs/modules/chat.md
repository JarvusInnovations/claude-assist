# Module: Chat

Bridges the owner's Slack DMs with the assistant bot to a Claude Agent SDK
session running in the configured agent repo (`AGENT_REPO_PATH`). Each Slack
thread maps to one agent session: the first message starts it, and every
reply in the thread resumes it.

This spec covers which messages the module answers, how message content,
including attachments, reaches the agent, and which other events it hands
off to an external command (§ Event hand-off). It does not cover how replies
are rendered.

## Who and where

- Only direct messages (`channel_type: im`) start or continue an agent
  turn.
- Only messages from the configured owner (`SLACK_OWNER_USER_ID`) are
  answered. The agent runs with bypassed permissions, so no other user may
  ever reach it.
- Messages posted by any bot, including this one, are never answered.
- A direct message from anyone other than the owner is ignored: it is
  neither answered nor handed off.
- Every other event is either handed off (§ Event hand-off) or dropped. No
  event outside the owner's direct messages ever runs the agent.

## Which message events count

Slack sends one `message` event type with an optional `subtype`. The module
handles:

| Subtype | Handled | Why |
| --- | --- | --- |
| none | yes | An ordinary message. |
| `file_share` | yes | A message with one or more files attached, with or without text. |
| anything else (`message_changed`, `message_deleted`, `bot_message`, `thread_broadcast`, …) | no | Edits, deletions and system events are not new turns. |

A handled message with neither text nor files is ignored.

**A message the module drops must be one it means to drop.** An owner
message that should start or continue a turn and instead vanishes without a
reply or a log line is a defect. When Slack adds a way of sending a normal
message, it belongs in the table above.

## Capture sigil

A top-level message whose text starts with the capture sigil (`+`) is
stored as a capture and never starts an agent session (see the capture
module).

## Attachments

Each file on a handled message is downloaded with the bot token and saved
to a folder for that Slack thread, outside the agent repo. The prompt sent
to the agent is the message text followed by an attachments section that
lists, for each file:

- the absolute path of the saved copy, and a note to open it with the Read
  tool
- its name, MIME type and size

A file that can't be downloaded is still listed by name with the reason it
failed, such as a missing `files:read` scope, a file over the size limit, or
an HTTP error. The agent must always be told that something was attached, so
it never answers as if the message were text only. Files over 25 MB are not
downloaded.

A message that has files but no text gets an agent turn whose prompt is only
the attachments section.

## Threads and sessions

- A top-level DM starts a new agent session. Its reply goes in that
  message's thread, and the thread is titled from the message text, or from
  the first file's name when there is no text.
- A reply in a thread resumes that thread's session.
- While a turn runs, the triggering message shows a `thinking_face`
  reaction, which is removed when the turn ends.

## Event hand-off

Optional. When configured, Slack events that are not the owner's direct
messages are passed to an external command, with no agent run, so another
consumer can act on them (for example, a long-running agent session that
watches a wake file). The module stays the only Socket Mode connection on
the Slack app. Two connections on one app token split the events between
them, so a second consumer cannot open its own; the hand-off is how it hears
them instead.

When the hand-off is not configured, the module behaves exactly as it does
without this section: no extra listeners, no extra events, nothing spawned.

The capture sigil, attachments, and per-thread agent sessions are unchanged
by the hand-off. They apply only to the owner's direct messages, and those
are never handed off.

### Configuration

| Variable | Meaning |
| --- | --- |
| `CHAT_HANDOFF_COMMAND` | The command, as a JSON array of strings (argv), such as `["/usr/local/bin/wake", "--from", "slack"]`. It runs without a shell, so there is no quoting beyond JSON's. Unset or malformed means no hand-off; a malformed value is logged at boot. |
| `CHAT_HANDOFF_EVENTS` | Comma-separated event kinds to hand off: `app_mention`, `message`, `reaction_added`. Default: all three. An unknown kind is logged and ignored. |
| `CHAT_HANDOFF_AUTHORS` | `owner` (default) or `any`. See § Which events are handed off. Any other value is logged and treated as `owner`. |
| `CHAT_HANDOFF_TIMEOUT_MS` | How long one run of the command may take before it is killed. Default 10000. |

### Which events are handed off

| Event | Handed off when |
| --- | --- |
| `app_mention` | Always (subject to the author rule). |
| `message` in a public channel, private channel or group DM (`channel_type` `channel`, `group`, `mpim`), top-level or a thread reply | Its subtype is none, `file_share`, `thread_broadcast` or `bot_message`. Edits, deletions, joins and other system subtypes are not handed off. |
| `message` in a direct message (`channel_type: im`) | Never. The owner's are answered by the agent; anyone else's are ignored. |
| `reaction_added` | Any reaction, in any conversation, except one the bot itself added (the bot's own status reactions, such as `thinking_face`, are noise). |

Author rule (`CHAT_HANDOFF_AUTHORS`):

- `owner`: hand off only events whose author (`user`) is the configured
  owner, plus messages the bot itself posted. A consumer needs its own
  top-level posts to know which threads it started.
- `any`: hand off events from any author, including other bots. A consumer
  that wants to hear replies from other people in a thread it started needs
  this.
- Under `owner`, messages from other bots are never handed off.

The bot's own messages are flagged `is_self: true`. Recognising them needs
the module to receive its own events, so when the hand-off is configured the
Slack client no longer filters out the bot's own events; the direct-message
path still ignores every bot message, as before.

A message that mentions the bot arrives twice from Slack: once as
`app_mention` and once as `message`. Both are handed off when both kinds are
enabled; the consumer can match them on `channel` and `ts`.

### What the command receives

The command runs once per event. It receives one JSON object on stdin and
nothing from the event on argv:

```json
{
  "type": "app_mention",
  "channel": "C…",
  "channel_type": "channel",
  "user": "U…",
  "ts": "1700000000.000100",
  "thread_ts": null,
  "text": "<@U…> can you look at this?",
  "event_ts": "1700000000.000100",
  "team": "T…",
  "is_owner": true,
  "is_self": false,
  "raw": { "…": "the Slack event, unchanged" }
}
```

- `type` is the Slack event type: `app_mention`, `message` or
  `reaction_added`.
- For `reaction_added`, `channel`, `channel_type` and `ts` describe the
  message that was reacted to, `user` is who reacted, `thread_ts` and `text`
  are `null`, and the emoji name is in `raw.reaction`.
- `app_mention` events carry no `channel_type` from Slack; it is `null`.
- A field Slack did not send is `null`, never missing.

Slack retries an event it thinks was not delivered. Each event is handed off
at most once per process, keyed by its Slack event id.

### Failure behaviour

Slack is acknowledged before the hand-off runs (Bolt acknowledges events
before calling listeners), and the hand-off never delays or blocks the
direct-message path. A run that exits non-zero, times out, or cannot be
spawned is logged as an error with the Slack event id, the event type and
the reason, and is counted. Each log line carries the running totals
(handed off, failed, consecutive failures), so a broken command is visible
in the logs on its first failure and its extent is visible on every one
after.

The hand-off does not register a heartbeat. Silence is its normal state
(days can pass with no mention or channel message), so a staleness
threshold would alarm on quiet weeks rather than on breakage. It does not
dispatch notifications either: the chat module is registered outside the
context where the notify dispatcher lives. Failures are surfaced in the logs
only.

### Slack app requirements

The hand-off only receives what the Slack app subscribes to. An operator
enabling it must add these bot events and scopes in the app's settings (or
manifest) and reinstall the app:

| Bot event | Scope it requires |
| --- | --- |
| `app_mention` | `app_mentions:read` |
| `message.channels` | `channels:history` |
| `message.groups` | `groups:history` |
| `message.mpim` | `mpim:history` |
| `reaction_added` | `reactions:read` |

Channel and private-channel messages arrive only from conversations the bot
is a member of. A manifest snippet is in `docs/chat-event-handoff.md`.

## Principles

**Local:**

- **One connection, many listeners.** The module owns the app's only Socket
  Mode connection. Another consumer that needs Slack events gets them through
  the hand-off, never through a second connection.

- **Tell the agent what it can't see.** When content can't be delivered,
  for example a file the module couldn't download, the agent gets an
  explicit note instead of silence. An honest "I couldn't open your file"
  beats a confident answer to half the message.
