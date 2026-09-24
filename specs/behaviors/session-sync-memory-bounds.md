# Behavior: Session sync memory bounds

## Rule

Session sync never lets one transcript decide how much memory the server uses.

- **A transcript over the size limit is skipped, not read.** Local sync and the
  push CLI compare each transcript's on-disk size against
  `SESSIONS_MAX_FILE_SIZE` (default 128 MiB) *before* reading it. An oversized
  transcript is not read, hashed, parsed or written; each sync logs a warning
  naming it, and the push CLI prints the same.
- **A session's write is atomic.** The session row and its `tool_calls` index
  rows are written in one transaction. A failure leaves the previous archived
  version intact rather than a row whose `transcript_hash` claims content the
  index never received.
- **Statement size never depends on session length.** The `tool_calls` index is
  inserted in fixed-size batches so no single statement approaches Postgres's
  65,534 bind-parameter ceiling.
- **Unchanged transcripts are never parsed.** The content hash is compared
  against the archive before any parse (including the ignore-marker check), so
  a scan of an unchanged corpus reads and hashes files but builds no parse
  trees.
- **The shipped service unit caps the process.** The systemd unit sets
  `MemoryHigh`, `MemoryMax` and `MemorySwapMax`, so a runaway allocation
  throttles and then restarts the server instead of swapping the host into
  unresponsiveness.

## Applies To

- `SessionScanner` discovery (`discoverAllSessions`, `discoverSessions`) and the
  push path (`getSessionInventory`, `getSessionsByIds`).
- `SyncService.ingestSession` and its `tool_calls` write, for both local sync
  and satellite pushes.
- `deploy/systemd/claude-assist-server.service`.

## Details

**Why skip rather than truncate.** Ingest holds the raw transcript, its full
parse, the derived search text and the outgoing row in memory together, which
multiplies the file's size many times over. A transcript large enough to exceed
the limit is almost always a long-running automated loop that is still being
appended to. Its hash changes on every cycle, so without a limit it would be
re-read, re-parsed and rewritten whole every five minutes indefinitely. A
truncated archive would claim to be the session while omitting most of it.
Skipping keeps whatever version was last archived under the limit, and the
warning makes the gap visible.

**The limit is per instance.** Hosts with more memory can raise
`SESSIONS_MAX_FILE_SIZE`. Setting it to a very large number restores the
unbounded behavior.

**Streaming is the real fix.** Hashing and parsing a transcript without holding
it whole would let the limit rise substantially. That is follow-up work; this
behavior is containment.
