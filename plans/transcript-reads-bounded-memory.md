---
status: in-progress
depends: [transcript-read-layer]
specs:
  - specs/behaviors/session-transcript-storage.md
issues: []
---

# Plan: Bounded-memory transcript reads

## Scope

Two read paths still materialize a whole session to use a part of it:

1. **Time-windowed `serialize`** (`GET /sessions/:id/transcript?after=&before=`
   and the cross-session time-range transcript route) calls `readFull` and
   filters by timestamp afterwards. A poll for the last half hour of a long
   session reads all of it.
2. **Unbounded `find`** (`GET /sessions/:id/find` with no anchor bounds) joins
   every chunk into one string, parses every message, then returns the first
   `limit` matches.

On a session of several hundred MB, either request holds gigabytes of strings
and parsed objects. The server runs under a systemd memory cap; at the cap the
kernel throttles it into a freeze rather than killing it, so one such request
takes down every module until a manual restart.

In scope:

1. **Incremental serializer.** Turn `serializeTranscriptUntruncated` into a
   stateful serializer that accepts raw text a batch at a time, carries the
   cross-message state (pending questions) forward, and can keep only a
   bounded tail of its output. The existing function becomes a one-batch use
   of it, so every current caller renders identically.
2. **Windowed `serialize` reads only the window's chunks.** Read the chunk
   index (seq and message ranges, no content). Binary-search chunk first
   timestamps, fetching only a bounded head of each probed chunk, to find the
   first and last chunk covering `[after, before]`; widen by one chunk each
   side. Stream those chunks oldest-first through the incremental serializer,
   one at a time, keeping a bounded tail; apply the existing tail truncation.
3. **`find` scans chunk by chunk.** Walk the bounded seq range a chunk at a
   time, oldest first. Parse each chunk with one neighbouring chunk on each
   side for context windows, match only the messages whose seq falls in the
   current chunk and the requested range, and stop at `limit`. Correct each
   window's `moreBefore`/`moreAfter` to session-absolute counts.

Out of scope: `readRawMessages` (the session detail page's raw view) and the
reparse scripts, which deliberately read whole sessions one at a time and are
not on a polled request path. Recorded as follow-ups if they need the same
treatment.

## Implements

- `specs/behaviors/session-transcript-storage.md`: "Reads hold bounded
  memory", "Time windows resolve to chunks", "Search stops at its limit", and
  the local principle "A read costs what it returns".

## Approach

- `transcript.ts`: `TranscriptSerializer` class (`push(raw)`, `result()`,
  optional `keepChars` tail bound with an "earlier omitted" flag).
  `serializeTranscriptUntruncated` = one push. A pure
  `findInMessageSlice(msgs, opts, { base, from, to, lastSeq })` shares
  `messageMatches`/`buildWindow` with `findInTranscript` and rebases indexes
  and remaining-counts to absolute seqs.
- `transcript-reader.ts`: `chunkIndex(sessionId)` (seq, msg ranges),
  `chunkFirstTimestamp(sessionId, seq)` (bounded `left(content, N)` head,
  parse complete lines, first `timestamp`), `chunkContent(sessionId, lo, hi)`.
  Windowed `serialize` and `find` built on those. No schema change.
- Tests extend the existing fake-SQL reader tests: multi-chunk fixtures prove
  windowed output equals the whole-transcript filter, a question/answer pair
  split across chunks still pairs, `find` returns the same matches and windows
  as the whole-transcript search and stops early, and the number of chunks
  fetched stays bounded.

## Validation

- [ ] Windowed `serialize` on a multi-chunk fixture returns exactly what
      `serializeTranscript(readFull, opts)` returns, for windows at the start,
      middle and end, and fetches only the window's chunks plus one each side
      and probe heads.
- [ ] A question and its answer in different chunks render paired.
- [ ] `find` returns the same matches, windows and remaining counts as the
      whole-transcript search on a multi-chunk fixture, and stops fetching
      once `limit` is reached.
- [ ] `bun test` for the sessions package passes; `bun run build` passes.
- [ ] Deployed: a `transcript --after` poll and an unbounded `find` against
      the largest live session complete with the server's memory staying far
      below its cap.

## Risks / unknowns

- **Time order is assumed, not guaranteed.** Rows can land slightly out of
  order; the one-chunk margin each side covers boundary skew. A transcript
  whose head chunks carry copied older messages (a fork) still has
  non-decreasing chunk first timestamps.
- **`left(content, N)` and TOAST.** Postgres may detoast the whole value to
  take a prefix, so probes cost server-side I/O, but the bytes crossing into
  the Node heap stay bounded. Acceptable at log2(chunk count) probes.
