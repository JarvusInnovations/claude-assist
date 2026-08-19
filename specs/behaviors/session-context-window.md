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
| `claude-fable-5`, `claude-mythos-5` | 1,000,000 |
| `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6` | 1,000,000 |
| `claude-sonnet-5`, `claude-sonnet-4-6` | 1,000,000 |
| `claude-haiku-4-5`, `claude-opus-4-5`, `claude-sonnet-4-5` | 200,000 |
| anything else (incl. `<synthetic>`) | null |

The 1M window arrived with the 4.6 generation; the 4.5 generation is 200K.
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

## Principles

**Local** — measure what the number will be used for. Two readings exist
because one would have to serve two incompatible questions ("did this run out
of room?" and "where would a resume start?"). When a single stored value would
force a lossy answer to a question the UI actually asks, store both.

Never render a fabricated denominator. An unknown context limit shows as absent,
not as a plausible default — a bar implies a measurement, and a bar drawn
against a guessed ceiling is a lie the reader cannot detect.
