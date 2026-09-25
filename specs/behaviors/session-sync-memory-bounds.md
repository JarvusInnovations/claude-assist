# Behavior: Session sync memory bounds

## Rule

Session sync never lets one transcript decide how much memory the server uses.

- **Growth is bounded, not size.** The `SESSIONS_MAX_FILE_SIZE` skip is retired:
  it is superseded by the per-cycle ingest budget
  (`SESSIONS_INGEST_BUDGET_BYTES`) in
  `specs/behaviors/session-transcript-storage.md`. A transcript of any size is
  ingestable; what a sync cycle reads, parses and writes is bounded by the
  budget, never by the transcript's total size. See that spec for the full
  chunking, continuity-check and incremental-parse rule.
- **A session's write is atomic.** The session row, its chunk and message-index
  rows, and its `tool_calls` index rows are written in one transaction. A
  failure leaves the previously archived version intact rather than a row
  whose `ingested_bytes` claims content the chunk or index tables never
  received.
- **Statement size never depends on session length.** The `tool_calls` index is
  inserted in fixed-size batches so no single statement approaches Postgres's
  65,534 bind-parameter ceiling.
- **Unchanged transcripts cost a `stat`, nothing more.** Change detection is
  size-plus-last-chunk-hash (see the storage spec), not a whole-file read or
  hash. A scan of an unchanged corpus costs one `stat` per session and builds
  no parse trees.
- **The shipped service unit caps the process.** The systemd unit sets
  `MemoryHigh`, `MemoryMax` and `MemorySwapMax`, so a runaway allocation
  throttles and then restarts the server instead of swapping the host into
  unresponsiveness.

## Applies To

- `SessionScanner` discovery and the push path
  (`getSessionInventory`/`getSessionsByIds`, and their chunked-ingest
  counterparts).
- `SyncService.ingestSession` and its `tool_calls` write, for both local sync
  and satellite pushes.
- `deploy/systemd/claude-assist-server.service`.

## Details

**Why the skip was retired.** The size skip existed because ingest held the
raw transcript, its full parse, the derived search text and the outgoing row
in memory together — multiplying the file's size many times over on every
cycle, indefinitely, for a session whose hash changes every time it grows.
Chunked, incremental ingest (the storage spec) removes the multiplier: a cycle
reads and parses only its budgeted slice of new bytes, so the transcript's
total size no longer determines the cycle's memory cost. A session that would
once have been skipped forever is now ingested over successive cycles like any
other.

**The budget is per instance.** Hosts with more memory can raise
`SESSIONS_INGEST_BUDGET_BYTES`. There is no upper bound above which a session
is skipped.

**The remaining containment layers are process-wide, not per-transcript.** The
atomic transaction, the batched `tool_calls` insert, and the systemd memory
caps guard against failure modes chunking doesn't touch (a crash mid-write, a
statement too large for Postgres, a runaway process). They stay in force
unconditionally.
