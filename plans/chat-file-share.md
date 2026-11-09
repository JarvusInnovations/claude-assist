---
status: done
depends: []
specs:
  - specs/modules/chat.md
issues: []
pr: 276
---

# Plan: Slack messages with attachments reach the agent

## Scope

The chat module dropped every `message` event that had a `subtype`. A DM
with an attachment arrives as `subtype: file_share`, so it vanished without
a reply or a log line. Even without that filter, the agent only received
the message text, so it could never see an attached file.

In scope:

- Handle `file_share` events alongside plain messages. Keep ignoring every
  other subtype.
- Download attached files with the bot token into a folder for each thread,
  outside the agent repo. List them in the prompt with paths for the Read
  tool. List files that failed to download with the reason.
- Handle messages that have files but no text. Title a new thread from the
  first file name when there is no text.
- Back-spec the module's intake rules in `specs/modules/chat.md`.

Out of scope:

- Passing images to the SDK as inline image blocks. The Read tool already
  handles images and PDFs from a path, and it covers every file type.
- Cleaning up downloaded files. They live in the OS temp directory.

## Implements

- `specs/modules/chat.md` § Which message events count, § Attachments,
  § Threads and sessions (the title fallback).

## Approach

- A new `packages/chat/src/attachments.ts` with three pure helpers and one
  I/O helper:
  - `isHandledSubtype`
  - `buildPrompt(text, attachments)`
  - `threadDirName`
  - `downloadAttachments(files, token, dir, fetch)`
- In `index.ts`, the event handler accepts `file_share`, downloads the
  files, and passes the built prompt to the existing handlers.

## Validation

- [x] Unit: subtype filter. Plain messages and `file_share` pass; edits,
      deletions and bot messages don't.
- [x] Unit: prompt building. Text only gives the text unchanged. Text plus
      files lists each file's path, name, type and size. Files only gives
      just the attachments section. A failed file is listed with its reason.
- [x] Unit: download. It saves the file with the bearer token. It reports a
      Slack HTML login page (the response without `files:read`) as a missing
      scope, and it skips files over the size limit without fetching them.
- [ ] Deployed: an image sent to Hari in a DM thread gets a reply that
      reflects the image, or, until the `files:read` scope is added, a reply
      that says a file was shared but couldn't be opened.

## Risks / unknowns

- The bot token currently lacks `files:read`. Until the owner adds the
  scope and reinstalls the app, every download fails, and the agent is told
  so.

## Notes

- The deployed check runs after merge, and its result is recorded as a
  comment on PR #276. Seeing an image end to end needs the `files:read`
  scope, which the owner has to add in the Slack app settings.
- Files are saved under the OS temp directory, not the agent repo, so the
  agent's git working tree stays clean.

## Follow-ups

- Tracked as: add `files:read` to the Slack app's bot scopes and reinstall
  (an owner action outside this repo; see PR #276).
