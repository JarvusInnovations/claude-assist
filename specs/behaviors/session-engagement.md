# Behavior: Session engagement

## Rule

The archive answers "how long was a human hands-on, per local day and per
project?" from the server alone. A consumer never needs filesystem access to
the transcripts, and never reimplements turn classification, day bucketing or
cross-session dedupe.

- **Every user turn is recorded as a prompt event.** One row per user-role
  message with text and per queued prompt: its message ordinal, message id
  (uuid), timestamp, leading text, the transcript's own flags (meta,
  sidechain, compaction summary, queued) and its authorship fields (origin
  kind, prompt source, queue priority). Recorded at ingest, append-only, in
  the same transaction as the chunks; a continuity re-ingest replaces them
  with the chunks.
- **A prompt is counted once, however many transcripts carry it.** Resuming
  or forking a session copies earlier turns into the new transcript with
  their original message ids and timestamps. Engagement identifies a prompt
  by its message id.
- **A prompt is human unless something marks it automated.** Classification is
  a pure function of the recorded facts and the pattern lists, applied when
  engagement is read.
- **Engagement is blocks of time after human prompts**, pooled across sessions
  so parallel agents never double-count, and bucketed by local day in a
  caller-named timezone.
- **Activity ranges stay a timeline feed.** `GET /sessions/activity` keeps its
  meaning (when a session had turns of any kind) and is not an engagement
  measure. No range is ever stored or returned with `end < start`.

## Applies To

- The incremental parser, chunked ingest and its write transaction.
- A background backfill for sessions ingested before prompt events existed.
- `GET /sessions/engagement`, `GET /sessions/activity`.
- The `sessions-axi` CLI (`engagement` command; `activity` help text). The
  CLI sends `tz` only when the caller passes one.

## Details

### Human or automated

A prompt event is classified in this order; the first rule that applies
decides:

1. The transcript flags the turn as meta, as a sidechain turn (a prompt an
   agent wrote for a subagent), or as a compaction summary → **automated**.
2. The turn carries an origin kind. `human` → **human** — this includes a
   typed slash command and a person typing `/loop` to start one. Any other
   kind (`task-notification`, `peer`, `coordinator`, …) → **automated**.
3. No origin kind, and the turn's queue priority is `later` → **automated**:
   a scheduled wakeup, whether from `/loop` or from a self-paced loop
   re-firing its own skill command.
4. Its text, after leading whitespace, starts with a built-in marker →
   **automated**: `<command-message>loop`, `<command-name>/loop`, an
   autonomous-loop sentinel (`<<autonomous-loop`), `<task-notification`,
   `This session is being continued`, `<local-command`, `Caveat:`,
   `<bash-stdout`, `<bash-stderr` (the output of a `!` shell command; the
   `<bash-input` turn is the person typing), `<system-reminder`,
   `[Request interrupted`, `<cross-session-message` (a message another agent
   session sent into this one). These carry transcripts from client versions
   that recorded no authorship fields.
5. Its leading text matches an instance-configured pattern
   (`SESSIONS_AUTOMATED_PROMPT_PATTERNS`: newline-separated regular
   expressions) → **automated**. The toolkit ships none: which bridged-message
   wrappers are automation is instance data.
6. Otherwise → **human**.

The prompt source (`typed`, `queued`, `sdk`, `system`, …) is recorded but
never decides on its own: `sdk` covers both people on remote clients and task
notifications. The origin kind is the authorship fact.

Each automated event reports which rule decided it (`meta`, `sidechain`,
`compaction`, `origin`, `task-notification`, `peer`, `scheduled`, `loop`,
`local-command`, `system`, `interrupt`, `instance`), so a consumer can see why a session reads as zero.

A queued prompt is classified by the same rules as a typed one: queueing says
when it arrived, not who wrote it.

The leading text kept per event is long enough to decide every rule above
(256 characters) and no longer. Patterns only ever see that prefix.

### One prompt, one owner

Prompt events sharing a message id are one prompt. Copies within one
transcript (a resumed session replaying its own history) and across
transcripts (a fork, or a resume that opened a new session) collapse to one
event before anything is counted.

The prompt **belongs to one session**: of the sessions carrying it, the one
that started first, then the one that ended first, then the lowest session
id. The original stops where its continuation starts, so this picks the
transcript the person was actually typing into. Every figure attributes the
prompt to its owner only: a continuation's prompt counts and minutes cover
the turns it originated, never its parent's past, and it is not listed under
days before it existed. An event without a message id is its own prompt.

### Blocks

- Each prompt opens a block running `block_minutes` from its timestamp.
- Blocks are merged when the gap between one's end and the next's start is at
  most `gap_minutes`; the merged block covers the gap.
- A block never extends past the moment of the request.
- Blocks are split at local midnight in the requested timezone, daylight-saving
  transitions included. Each piece counts toward the day it falls in.
- **A day's figures do not depend on the requested window.** A block that
  begins on the day before `from` contributes its after-midnight part to
  `from`; a block that runs past the end of `to` contributes nothing beyond
  it.

Minutes are computed three ways from the same events, and are deliberately not
additive:

| Figure | Prompts pooled over | Meaning |
| --- | --- | --- |
| Day `envelope_minutes` | every session's human prompts | time the human was engaged with anything |
| Project `human_minutes` | human prompts of that project's sessions | time engaged with that project |
| Session `human_minutes` | that session's human prompts | time engaged with that session |

Pooling happens before merging, so two sessions prompted alternately inside
the gap form one block rather than several short ones. Project minutes can sum
to more than the envelope (interleaved or parallel work) and session minutes
to more than their project's. That is expected: the parts are never scaled
down to fit the whole.

A session's `automated_minutes` is the same block computation over its
automated prompts. It is reported for visibility and enters no other figure.

### `GET /sessions/engagement`

Query: `from` and `to` (local dates, `YYYY-MM-DD`, inclusive), `tz` (IANA
zone), `block_minutes` (default 15), `gap_minutes` (default 15).

- **The zone is the request's `tz`, else the instance's `SESSIONS_OWNER_TZ`.**
  With neither, the request is a `400`. The server never falls back to its own
  host zone, and a client never substitutes its machine's zone: machines
  travel, and a drifted zone moves late-evening work to the wrong day without
  any visible error. The response echoes the zone it used.
- `from` and `to` are required. A missing or malformed value, an unknown zone,
  `to` before `from`, or a non-positive `block_minutes` / negative
  `gap_minutes` is a `400` naming the parameter.
- A window over 92 days is a `400` whose body states the cap and the span
  requested, so a script can split the request.

Response:

```
{
  from, to, tz, block_minutes, gap_minutes,
  pending_sessions,          // sessions whose prompt events are not yet backfilled
  days: [{
    date,                    // local date
    envelope_minutes,
    human_prompt_count,
    first_human_prompt,      // ISO instant, null when none
    last_human_prompt,
    projects: [{ project_path, project_name,
                 human_minutes, human_prompt_count,
                 first_human_prompt, last_human_prompt }],
    sessions: [{ id, title, session_name, project_path, project_name,
                 human_minutes, human_prompt_count,
                 first_human_prompt, last_human_prompt,
                 automated_minutes, automated_prompt_count,
                 automated_by }]   // rule → count
  }]
}
```

- Every date in the window appears, in order; a day with no prompts has zero
  figures and empty lists.
- A session appears under a day when it has any prompt event on that day or a
  block piece falling in it, so an all-automated session is listed with
  `human_minutes: 0`.
- A project appears under a day when it has a human prompt on that day or
  human time falling in it. Automation alone does not list a project.
- Projects and sessions are ordered by human minutes, most first.
- Minutes are whole numbers, rounded once per figure from exact durations
  (never a sum of rounded pieces).
- `pending_sessions` counts sessions the backfill has not finished and that
  have activity inside the window. While it is non-zero the figures are a
  lower bound.

### Existing sessions

A background task derives prompt events for sessions ingested before this
behavior existed, with the same properties as the context-timeline backfill
(`session-context-window.md`): stored chunks only, one chunk at a time, a
per-run byte budget, resumable, and a row-locked handoff to live ingest so no
event is derived twice or dropped.

When the task finishes a session it also **rebuilds that session's activity
ranges** from the timestamps of the prompt events it owns (replayed copies
of another session's turns excluded) and resets the parser's remembered
range end to match. This repairs ranges already stored inverted, and any
range that stopped short of the transcript's last turn. Sessions are
backfilled in ownership order (started first, ended first, lowest id), so a
prompt's owner is always settled before any continuation is rebuilt.

Live ingest of a continuation still derives its ranges from every turn in
its transcript, replayed ones included: `GET /sessions/activity` is a feed of
when a transcript had turns, not an engagement measure.

### Activity ranges are monotone

Timestamps in a parse delta are ordered before merging. A turn timestamped at
or before the end of the session's last range (a replayed line in a resumed or
forked session) neither moves that end nor opens a range. The last range's end
only ever moves forward.

## Principles

**Inherited**

- [The toolkit is generic; the instance is private](../principles.md#the-toolkit-is-generic-the-instance-is-private)
  — built-in markers are the ones the client itself emits; anything naming a
  particular bot, bridge or command arrives through configuration.
- [A response code is a claim](../principles.md#a-response-code-is-a-claim) —
  no guessed timezone, and `pending_sessions` rather than silently low totals:
  these numbers feed a ledger.

**Local**

- **Record facts at ingest, judge at read.** Ingest stores what the transcript
  says about a turn; whether that makes it human is decided per request. A
  better marker list or a new instance pattern then corrects every past day at
  once, with no re-ingest. When a derived label and the evidence for it could
  both be stored, store the evidence.
- **Undercount before overcount.** When a turn's authorship is ambiguous under
  the rules, prefer the reading that claims less human time. The consumer is
  reconciling billable hours; a missed quarter-hour is caught by a person, a
  phantom eighty-hour day is not.
