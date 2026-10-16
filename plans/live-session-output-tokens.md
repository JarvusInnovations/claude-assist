---
status: in-progress
depends: []
specs:
  - specs/behaviors/session-transcript-storage.md
issues: []
---

# Plan: a live session's output tokens include its open chains

## Scope

Incremental ingest added a response chain's output to the session row only
when the chain was finalized. That happens in two cases: the checkpoint holds
more than `MAX_OPEN_CHAINS` (128) open chains and the oldest is evicted, or
the session-ended signal arrives. A long-running session with fewer than 129
model responses therefore stored `output_tokens = 0` for as long as it was
live. That caused two visible problems:

- the sessions list's default "hide empty" filter (`output_tokens > 0`) hid it
- the outline sweep treated it as empty and gave it no outline or title

The spec already required the aggregate to equal a full parse of the
transcript, and a full parse counts open chains. This plan brings ingest into
line and states the live-session case explicitly in the spec.

In scope:

- The session row's `output_tokens` and per-model `model_tokens[*].output`
  include every open chain's running max on every write.
- Loading the prior state subtracts those open chains back out, so the
  settled aggregate the parser resumes from is unchanged and nothing is
  counted twice.
- Rows written before this change hold only the settled count. A checkpoint
  marker tells the load path which convention a row uses, so no migration is
  needed. Each live session corrects itself on its next cycle.

Out of scope:

- Changing what "empty" means in the list filter or the outline sweep. With
  correct counts, output tokens are the right test.
- Rows for sessions that will never get another cycle. Their open chains
  were finalized when they ended, so their counts are already correct.

## Implements

- `specs/behaviors/session-transcript-storage.md` § Incremental derivation —
  the equality with a full parse holds after every cycle, including open
  chains.

## Approach

- `incremental-parser.ts`: a pure helper that sums open chains' output (total
  and per model) from a checkpoint.
- `chunk-store.ts`: `writeIngestCycle` adds the open-chain output to the
  aggregate it writes and marks the checkpoint as provisional.
  `toChunkState` subtracts it again when the marker is present.

## Validation

- [ ] Unit: adding then removing the open-chain output round-trips the
      aggregate exactly. A checkpoint without the marker loads unchanged.
- [ ] Integration (real Postgres): a session that never ends shows nonzero
      `output_tokens` after its first cycle. After an append that extends an
      open chain and adds a new one, the total equals a full `parseTranscript`
      of the file, with no double counting.
- [ ] Integration: when the session-ended signal finalizes it, the stored
      total still equals a full parse.
- [ ] Deployed: the two live sound-transit sessions that were hidden appear
      on `/sessions` without "include empty".

## Risks / unknowns

- The extra field in `parse_checkpoint` must survive the parser's own
  checkpoint rebuilds. `chunk-store` sets it on every write, so it never
  depends on the parser keeping it.

## Notes

## Follow-ups
