# Behavior: Session outlines

## Rule

Every session gets an AI-generated outline (a short title plus summary) used
for search and browsing. **How** the outline is produced depends on the
session's size:

- **Short sessions** (under the outline threshold) get a **single-pass**
  outline: the whole transcript, capped to a prompt budget, summarized in one
  model call. This is the original behavior and is unchanged by windowing.
- **Long sessions** (over the threshold) get a **windowed** outline instead:
  the transcript is carved into windows by message range, each window is
  summarized once when it closes, and the session outline is **composed**
  from the window summaries — a summary of summaries — rather than a single
  pass that can only sample a head and a tail and drop everything between.

A persistent session (a long-running bot, an always-on loop) is exactly the
case single-pass truncation serves worst: the middle is most of the record,
and a head+tail sample of a multi-week transcript is mostly silence. Windowing
exists so that content survives into the outline regardless of how long a
session runs.

## Applies To

- `OutlineService` (`packages/sessions/src/outline.ts`) and its persistence,
  `OutlineWindowStore` (`packages/sessions/src/outline-windows.ts`).
- The `sessions.outline_windows` table and the `sessions.sessions.outline`,
  `outline_hash`, and `outline_windows_hash` columns.
- The session-detail route (`GET /sessions/:id`) and `sessions-axi details`,
  which surface window summaries additively.

## The single-pass path (short sessions, back-specced)

Below the windowing threshold, generation is exactly what shipped before
windowing existed, byte-for-byte:

1. Fetch the raw transcript capped at `RAW_TRANSCRIPT_FETCH_BUDGET` (2,000,000
   bytes), sampling head+tail in SQL so an oversized transcript never lands on
   the heap whole (`TranscriptReader.readHeadTail`).
2. Serialize to the `[U]`/`[A]`/`[T]` compact format.
3. Cap the serialized text at `TRANSCRIPT_PROMPT_CHAR_BUDGET` (300,000 chars),
   again keeping a head and a tail sample and dropping the middle on a line
   boundary.
4. One model call (`sessions.outline` task, `extract` tier) with a fixed
   prompt asking for a `<title>` and a `<summary>`.
5. Store `outline`, `title`, and `outline_hash = transcript_hash`.

A session is re-selected for outline generation whenever `outline_hash IS
DISTINCT FROM transcript_hash` (the transcript changed since the last
outline), up to `MAX_OUTLINE_ATTEMPTS` (5) failures, after which automatic
sweeps stop retrying it — a manual retry naming the session id explicitly
bypasses the cap.

This path is what makes windowing safe to add: the decision of which path to
take happens *before* any transcript is fetched (see below), so a short
session's code path is untouched.

## The windowing decision

A session is windowed when either its message count or its raw transcript
byte length exceeds a threshold (`isWindowedSession` in `outline-windows.ts`):

| Config | Default | Why |
| --- | --- | --- |
| `SESSIONS_OUTLINE_WINDOW_THRESHOLD_MESSAGES` | 400 | Comfortably covers a long single-sitting session; catches a persistent/multi-day session before it grows large enough to hit the byte threshold anyway. |
| `SESSIONS_OUTLINE_WINDOW_THRESHOLD_BYTES` | 2,000,000 | Exactly `RAW_TRANSCRIPT_FETCH_BUDGET` — the point where the single-pass path already starts sampling head+tail and dropping the middle. Windowing takes over right where that truncation would otherwise start losing content. |

The byte check is a scalar `length(raw_transcript)` read
(`TranscriptReader.rawByteLength`), never a content fetch — deciding whether to
window must not itself cost what windowing exists to avoid.

## Window boundaries

A window is `[from_seq, to_seq]` (message indices, same ordering as
`tool_calls.msg_index`), plus the timestamps of its first and last message.
It closes — becomes immutable — the first time any of these trip
(`planWindows`):

| Config | Default | Why |
| --- | --- | --- |
| `SESSIONS_OUTLINE_WINDOW_MAX_MESSAGES` | 200 | Half the session threshold, so a freshly-windowed session's first window closes well before the whole-session threshold matters again. |
| `SESSIONS_OUTLINE_WINDOW_MAX_BYTES` | 500,000 | A quarter of `RAW_TRANSCRIPT_FETCH_BUDGET`; keeps one window's raw content well under `TRANSCRIPT_PROMPT_CHAR_BUDGET` once serialized on its own. |
| `SESSIONS_OUTLINE_WINDOW_MAX_SPAN_MS` | 6 hours | Bounds a slow-trickling persistent session to a summarizable time slice regardless of message or byte volume. |

Boundary planning reads only the messages after the last known boundary
(`TranscriptReader.messagesSince`), never the whole transcript on a session
that's already been windowed once — the one unavoidable exception is the
first time an existing long session is windowed at all, which necessarily
walks its full backlog once to carve the initial windows.

The **open tail window** (`closed_at IS NULL`) is the only mutable row: each
sweep may extend its `to_seq`/`to_ts` and re-plan whether it should now close.
Once `closed_at` is set, a window's bounds never change again
(`OutlineWindowStore.upsertBoundary`'s `WHERE closed_at IS NULL` guard).

## Summarization: exactly once, idempotent, bounded per sweep

Per `specs/behaviors/scheduled-work-leases.md`, concurrency safety lives in
Postgres, not in a process flag. `OutlineWindowStore` implements a
claim/lease/complete cycle over `sessions.outline_windows.status`:

- **Claim** (`claimOne`): a single atomic `UPDATE ... WHERE status = 'pending'
  RETURNING` per window, guarding one row against a second process (a
  manual-trigger sweep racing the scheduled one) rather than selecting a batch.
  `OutlineService` spends a shared, per-sweep **budget**
  (`SESSIONS_OUTLINE_WINDOW_SWEEP_CAP`, default 20) as it walks sessions in the
  sweep's existing order, claiming a session's windows oldest-first (so a
  session's own closed backlog is always attempted before its open tail)
  until the budget runs out; whatever wasn't reached carries to the next
  sweep. This budget is what trickles first-time backfill of an existing
  archive instead of bursting the model budget in one cycle — it is not a
  strict global priority queue across sessions, just a shared counter, which
  is adequate: a sweep either has enough budget for the day's actual backlog
  or is genuinely constrained, and nothing is lost either way.
- **Complete**: a **closed** window goes terminal (`summarized`) and is never
  claimed again — it is now immutable in every sense. The **open tail**
  cycles back to `pending` with `attempts` reset to 0, ready to be claimed
  again once new content changes its `content_hash`.
- **Fail**: `attempts` increments; the row goes terminal (`failed`) once
  `SESSIONS_OUTLINE_WINDOW_MAX_ATTEMPTS` (5, mirroring
  `MAX_OUTLINE_ATTEMPTS`) is reached, otherwise back to `pending` for the next
  sweep.
- **Reclaim**: a row stuck in `summarizing` past `lease_expires_at` (a crashed
  sweep) reverts to `pending`.

**Why not `packages/core`'s `createLeaseQueue`.** That generic helper's
`complete()` never resets `attempts` — correct for a table of one-shot rows,
wrong here: the open tail is claimed and completed repeatedly across a
session's whole life, and each successful completion must clear its failure
count rather than carry it toward the cap (five successful completions would
otherwise permanently exhaust it). `OutlineWindowStore` is a small,
purpose-built claim/lease implementation over the same primitives
(`FOR UPDATE SKIP LOCKED`, a lease expiry, an attempt cap) rather than a
misuse of the generic queue.

**Skipping unchanged content.** Before summarizing the open tail, its current
content hash is compared against `content_hash` stored from the last
summarization; unchanged content is not re-summarized (no model call), even
though the row is still `pending` and eligible for claim. This is what keeps
"at most once per sweep" from also meaning "once per sweep whether or not
anything changed."

## Memory bounds on the windowed path

- **One windowed session at a time.** The sweep's session concurrency applies
  to single-pass sessions only; windowed sessions are processed serially, so
  at most one transcript parse is resident for windowing.
- **One parse per session per sweep.** Boundary planning and every window's
  text slice the same parsed messages; the transcript is never re-read per
  window.
- **No content read once the budget is spent.** A windowed session reached
  after the sweep's summarization budget is exhausted is skipped without
  reading its transcript, and stays selected for the next sweep.
- **Inline ceiling.** While a session's transcript is stored inline (before
  chunked storage, specs/behaviors/session-transcript-storage.md), a window
  read is a whole-transcript parse. A session whose inline transcript exceeds
  64 MiB keeps the single-pass head+tail outline, computed in SQL, until its
  storage is chunked.

## Composition: summary of summaries

The session outline (`sessions.sessions.outline`/`title`) for a windowed
session is composed from all of its window summaries in chronological order
(`buildComposePrompt`), one model call (`sessions.outline.compose` task,
`extract` tier — composing already-extracted summaries is still extractive
work, not the `synthesize` tier's once-per-batch narrative judgment).

Composition is **not** re-run every sweep just because the transcript grew.
`windowsSignature` hashes the ordered set of `(window_index, closed, summary)`
tuples; the outline is recomposed only when this signature differs from
`sessions.sessions.outline_windows_hash`, which is stamped after a successful
compose. A sweep where no window closed and the tail's summary didn't change
recomputes the signature (cheap — no model call) and finds it unchanged.

`outline_windows_hash` is deliberately a separate column from `outline_hash`.
`outline_hash` (single-pass path) tracks the outline against
`transcript_hash`, which is the right comparison when the whole transcript is
the input. For a windowed session the transcript keeps changing while it's
active, but the *composed* outline should track the windows, not the raw
transcript — reusing `outline_hash` for both would make every active windowed
session look permanently "pending" by the single-pass definition.

**Backfill completion.** A windowed session's `outline_hash` is only
advanced to `transcript_hash` once its boundaries are fully caught up to the
transcript's current end *and* every closed window through the tail is
summarized. If the sweep cap left windows pending, `outline_hash` is left
alone so the session stays selected by the existing pending-outline query
(`WHERE outline_hash IS DISTINCT FROM transcript_hash`) and its backfill
continues on the next sweep.

## Principles

**Inherited** — from [principles.md](../principles.md) and
[scheduled-work-leases.md](scheduled-work-leases.md):

- [Gather cheap, judge expensive](../principles.md#gather-cheap-judge-expensive) —
  per-window summarization and composition both run on the `extract` tier;
  nothing here escalates to `synthesize`.
- [The database is the coordination primitive](../principles.md#the-database-is-the-coordination-primitive) —
  window claiming is a Postgres claim/lease, not a process flag, safe under a
  manual trigger racing the scheduled sweep.
- [Alert on the absence of success](../principles.md#alert-on-the-absence-of-success) —
  an exhausted attempt cap leaves a queryable `failed` row with `last_error`,
  same as the existing single-pass `outline_attempts` convention.

**Local**

- **Truncation is a reader's choice, made once, not silently repeated.**
  Windowing does not eliminate truncation — a single window can still exceed
  the prompt budget in pathological cases — but it moves the choice from "drop
  the middle of the whole session" to "drop the middle of one bounded slice,"
  which is a much smaller loss.
- **A cap that is never reached costs nothing to have.** The per-sweep window
  cap and per-window attempt cap both default loose enough that a healthy,
  modestly-sized instance never notices them; they exist for the day an
  archive backfill or a stuck model call would otherwise matter.
