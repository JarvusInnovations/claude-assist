# Behavior: Session transcript storage

## Rule

A session's raw transcript is archived **in full**, as an **append-only series
of chunks**, and ingested **incrementally**: each sync stores only the bytes
appended since the last one. The cost of syncing a session is proportional to
how much it grew, never to how large it is.

- **Complete.** Every byte of a transcript is archived, however large the
  session grows. There is no size above which a session is skipped or
  truncated. Long-running persistent sessions (bots, loops, always-on agents)
  are the most valuable to keep, and the local copy is eventually pruned.
- **Append-only.** A chunk, once written, is never rewritten. A sync that finds
  new bytes adds chunks after the last one. It never rewrites earlier content,
  and neither do the derived indexes (`tool_calls` rows keep their ids).
- **Bounded per cycle.** One sync cycle ingests at most a fixed byte budget per
  session (`SESSIONS_INGEST_BUDGET_BYTES`). A session with a larger backlog, for
  example on first sight, catches up over successive cycles. Memory use is
  bounded by the budget, not by session size.
- **Readers take ranges.** Every consumer reads the transcript through a range
  API (all, a message range, head and tail within a budget, or a window around an
  anchor). None loads a whole transcript to use a part of it.

## Applies To

- Local sync and satellite push (ingest).
- Every reader of transcript content: the transcript, grep, around-anchor and
  share routes; the outline and classification pipelines; reparse and backfill
  scripts.
- The `tool_calls` index and everything that consumes it by ascending id (the
  audit ledger).

## Details

**Chunk shape.** Each chunk records its session, a dense sequence number, the
byte range `[byte_start, byte_end)` it covers in the source file, the message
index range it contains, its content, and a content hash. Chunks split only at
line boundaries: a trailing partial line is left for the next cycle. Chunk size
is capped (`SESSIONS_CHUNK_MAX_BYTES`, default 8 MiB) so no single row is large.
The per-cycle ingest budget `SESSIONS_INGEST_BUDGET_BYTES` defaults to 64 MiB.

**Continuity check.** Before appending, sync confirms that the file still
begins with what was archived: the file is at least `ingested_bytes` long, and
the bytes of the last archived chunk match its stored hash at the same offset.
If the check fails (the file was rewritten, truncated or replaced), sync
re-ingests that session from byte zero. It writes the new chunk series under
the same session in one transaction, replacing the old one. That is the only
path that removes chunks.

The per-cycle check covers only the tail. A **nightly full verification**
walks each session active in the last day and compares every stored chunk's
hash against the same byte range on disk, streaming, never holding more than
one chunk. A mismatch triggers the same full re-ingest.

**Message index.** Every archived message has a row mapping `(session, seq)` to
its uuid and the chunk that holds it, so anchor lookups (around-a-message) and
message-range reads resolve to exactly the chunks they need.

**Incremental derivation.** Session aggregates (tokens, message counts, models,
activity ranges, context readings, user messages, files touched) are derived by
parsing only the new chunk against a persisted **parse checkpoint**: the state
the parser needs to continue, such as open chain roots and running totals. The
result must equal a full parse of the whole transcript. New tool calls are
appended to `tool_calls`; existing rows are untouched.

**Satellite push** follows the same rule. The server's inventory response tells
a satellite each session's `ingested_bytes` and last-chunk hash. The satellite
sends only the bytes after that offset, or the whole file if its continuity
check fails.

**Search text is bounded.** Full-text indexing covers the most recent user
messages up to 256 KiB of text, well under Postgres's 1 MB `tsvector` limit,
not an ever-growing concatenation. Exact-match search over full content goes
through the grep path, which reads chunks.

**Storage tiering is additive [phase 2].** A chunk's content may later live in
object storage (the row keeping its range, hash and an object reference instead
of inline content), for cold or very large sessions. Nothing in phase 1 may
assume chunk content is always inline, beyond the read layer. The trigger
(database size or session age) is decided when tiering is planned.

## Principles

**Local**

- **Keep everything; bound the work, not the record.** When archive
  completeness and ingest cost conflict, spread the ingest across cycles; never
  drop or truncate content. Truncation is a reader's choice (for example an
  outline's prompt budget), made at read time over the complete record.
- **Growth, not size, drives cost.** A 400 MB session that grew by 50 KB must
  cost what a 50 KB append costs. Any design that re-reads, re-parses or
  rewrites unchanged content per cycle violates this.
