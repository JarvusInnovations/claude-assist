# Behavior: Session context-window measurement

## Rule

Every archived session records **how full its context window got** — two
readings, both in tokens, plus the window they are measured against:

- **`context_final_tokens`** — the prompt size on the session's *last*
  main-chain API call. This is where the context would sit if the session were
  resumed.
- **`context_peak_tokens`** — the largest prompt size observed across the
  session's main-chain API calls.
- **`context_limit_tokens`** — the context window of the model that served the
  last main-chain call, or null when that model is unknown to the limit table.

A single reading is the sum of the three input components of one API call:

```
input_tokens + cache_creation_input_tokens + cache_read_input_tokens
```

Output tokens are excluded — they are not resident in the next request's prompt.

## Applies To

- The transcript parser, which derives all three at ingest.
- `GET /sessions` and `GET /sessions/:id`, which expose them.
- The admin sessions list (bar) and session detail page (full figures).

## Details

**Main chain only.** Messages with `isSidechain: true` are subagent turns with
their own independent context and are excluded from both readings. A session's
context is the context of its main conversation.

**One reading per API call.** Streaming produces several transcript messages
per call carrying identical input counts. A reading is taken only at the first
message of a chain — the same `isFirstInChain` test the token aggregates use —
so a long stream contributes one reading, not dozens.

**Peak and final diverge, and that is the point.** Compaction and context
editing shrink the prompt mid-session; a session may peak near the ceiling and
end far below it. Neither number alone is honest: the peak says whether the
session ran out of room, the final says where a resume would start.

**Null is a real state.** A session whose transcript carries no main-chain
usage (an empty or malformed session) records null for both readings rather
than zero — zero would render as an empty bar, asserting "0% full" about a
session that was never measured.

**Model → limit resolution.** The limit is resolved from the model id of the
last main-chain call, matching on the id with any date suffix stripped:

| Model | Window |
| --- | --- |
| `claude-fable-5-1`, `claude-fable-5`, `claude-mythos-5` | 1,000,000 |
| `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6` | 1,000,000 |
| `claude-sonnet-5`, `claude-sonnet-4-6` | 1,000,000 |
| `claude-haiku-4-5`, `claude-opus-4-5`, `claude-sonnet-4-5` | 200,000 |
| anything else (incl. `<synthetic>`) | null |

The 1M window arrived with the 4.6 generation; the 4.5 generation is 200K.
Source of truth for new models: the *Context window* row of Anthropic's
[models overview](https://platform.claude.com/docs/en/models/overview). Add a
model only once it is listed there.
An unrecognised model yields a null limit, never a guessed one — the UI then
shows token counts with no percentage.

## Display

**Sessions list** — a mini bar showing **final** as a percentage of the limit.
Final, not peak: the list is ordered by last activity and read to decide what
to resume, so the useful number is where a resume would start. Sessions with a
null reading or null limit show no bar.

**Session detail** — both readings as `used / limit` with their percentages,
and the model the limit came from. When peak exceeds final, the gap is what
compaction reclaimed.

## Timeline

Beyond the two summary readings, every archived session records its **context
timeline**: one reading per main-chain API call (same definition and
`isFirstInChain` rule as above, with the call's timestamp) plus one event per
**compaction**, the transcript's `system` / `compact_boundary` records, carrying
timestamp, trigger (`auto` / `manual`), `preTokens` and `postTokens`.

- **Recorded at ingest, append-only.** The incremental parser emits readings
  and compactions for the lines it feeds, and ingest appends them in the same
  transaction as the chunks. A cycle never recomputes earlier points.
- **Existing sessions are backfilled** by a background task that feeds each
  session's chunks through the incremental parser one chunk at a time (bounded
  memory), with a per-run byte budget, marking a session done when its
  timeline covers `ingested_bytes`.
- **Served downsampled.** `GET /sessions/:id/context-timeline` returns at most
  ~600 reading points plus every compaction event. Downsampling buckets along
  the active-time axis (below) and keeps each bucket's **maximum** and its
  **last** reading, so peaks and post-compaction drops survive. It also returns
  the context limit (null when unknown) and the axis segments.

**The axis is active time by default, with the time scale still visible.**
Sessions range from one dense day to weeks of bursts separated by long idles,
and neither calendar time nor message count serves both. The default x-axis
is real time, except that any gap between consecutive events longer than 30
minutes collapses to a break labeled with its duration (`⋯ 9h`, `⋯ 2d`). The
break's width grows with the logarithm of the gap's length, so a three-week
idle is visibly wider than an hour's pause without dominating the chart. Its
shading darkens in four steps (under 3h, 3h–1d, 1d–1w, over a week), and
labels for gaps of a day or more are bold. Day boundaries are marked with a
date label.

**Three views.** A switch on the chart selects the view, remembered per viewer
in the browser:

- **Condensed** (default): the active-time axis above.
- **Ruler**: Condensed, plus a thin strip below the chart in true calendar time
  showing where each active stretch falls, with faint connectors from each
  stretch on the chart to its place on the strip.
- **Calendar**: the x-axis is true calendar time. Idle periods between active
  stretches are shaded, and the line breaks across them rather than drawing a
  slope through time nobody was working. Axis ticks step by hours, days or
  weeks to fit the span.

**Chart.** On session detail, below the Context Window card and spanning the
page width: a line of context tokens over the active-time axis. The limit is
drawn as a horizontal ceiling line, but only when known (see Principles). Each
compaction is a vertical marker annotated with its drop (`968K → 21K`, auto or
manual). Hovering a point shows its time and token count. A session with fewer
than two readings shows no chart.

**Labels never overlap.** Axis and compaction labels that would collide are
dropped rather than drawn on top of each other, in priority order: a gap of a
day or more merged with the day it ends on (`⋯ 23d · Aug 3`), then day
boundaries, then gaps by length. Crowded compactions label the biggest drops;
every marker keeps a hover title. The y-axis shows 0, half and the maximum.

**Unknown stays unknown.** Some older transcripts record a compaction's
`preTokens` but not `postTokens` or `trigger`. Those are stored as null and
shown as `?`, never as 0 or a default trigger.

## Principles

**Local** — measure what the number will be used for. Two readings exist
because one would have to serve two incompatible questions ("did this run out
of room?" and "where would a resume start?"). When a single stored value would
force a lossy answer to a question the UI actually asks, store both.

Never render a fabricated denominator. An unknown context limit shows as absent,
not as a plausible default — a bar implies a measurement, and a bar drawn
against a guessed ceiling is a lie the reader cannot detect.
