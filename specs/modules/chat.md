# Module: Chat

Bridges the owner's Slack DMs with the assistant bot to a Claude Agent SDK
session running in the configured agent repo (`AGENT_REPO_PATH`). Each Slack
thread maps to one agent session: the first message starts it, and every
reply in the thread resumes it.

This spec covers which messages the module answers and how message content,
including attachments, reaches the agent. It does not cover how replies are
rendered.

## Who and where

- Only direct messages (`channel_type: im`) are handled.
- Only messages from the configured owner (`SLACK_OWNER_USER_ID`) are
  handled. The agent runs with bypassed permissions, so no other user may
  ever reach it.
- Messages posted by any bot, including this one, are ignored.

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

## Principles

**Local:**

- **Tell the agent what it can't see.** When content can't be delivered,
  for example a file the module couldn't download, the agent gets an
  explicit note instead of silence. An honest "I couldn't open your file"
  beats a confident answer to half the message.
