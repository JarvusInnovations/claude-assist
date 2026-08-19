---
status: done
depends: []
specs:
  - specs/behaviors/session-context-window.md
issues: []
pr: 223
---

# Plan: Session context-window measurement + admin display

## Scope

The archive stores per-session token *aggregates* (`input_tokens`,
`cache_read_tokens`, `model_tokens`) — lifetime sums across every API call.
None of them answer "how full did this session's context get", which is a
property of a single call, not a sum. This plan derives that reading at ingest
and surfaces it.

In scope:

1. Parser derives `contextFinalTokens`, `contextPeakTokens`, `contextModel`
   from main-chain assistant usage.
2. A model → context-window table (`context-window.ts`), resolving with the
   date suffix stripped and returning null for unknown models.
3. Migration `013-context-window.sql` adding the four nullable columns.
4. Backfill of existing rows by re-parsing the stored `raw_transcript` — no
   filesystem access needed, and it covers sessions whose transcript files
   Claude has since pruned.
5. `GET /sessions` and `GET /sessions/:id` expose the fields.
6. Admin: mini bar (final %) in the sessions list; both readings with full
   figures on the detail page.

Out of scope: exposing context in the `sessions-axi` CLI, and any alerting on
sessions approaching their ceiling. See Follow-ups.

## Implements

- **specs/behaviors/session-context-window.md** — the whole spec; it is new
  and this plan is its first implementation.

## Approach

The reading is taken inside the parser's existing second pass, gated on the
same `isFirstInChain` test the token aggregates already use (streaming emits
several messages per call with identical input counts) and on
`!msg.isSidechain` (subagents hold their own context).

Backfill runs as a one-shot startup task over rows where
`context_final_tokens IS NULL AND context_backfilled_at IS NULL AND
raw_transcript IS NOT NULL`, in batches, so a 2.6k-row / 2.5 GB corpus does not
land in memory at once. The stamp column is what stops a legitimately
unmeasurable session (no main-chain usage) from being rescanned every night.

## Validation

- [x] Parser unit test: peak > final when a compaction shrinks the prompt
- [x] Parser unit test: sidechain messages excluded from both readings
- [x] Parser unit test: streamed chain counts once, not per message
- [x] Empty/malformed transcript yields null, not 0
- [x] Unknown model yields a null limit; dated ids (`-20251101`) still resolve
- [x] Migration applies clean (verified inside a rolled-back transaction against
      the live schema; backfill selector resolves, 2,614 rows awaiting)
- [x] Backfill populated existing rows: 2,614 stamped, 2,312 measured of 2,615
- [x] Live check: parser output matches an independent `jq` recomputation on 6
      frozen real transcripts, final and peak, exactly
- [x] List bar renders final %; absent when reading or limit is null
- [x] Detail page shows both readings, limit, and model
- [x] `bun test packages/sessions` green (91); admin + sessions `tsc` clean

## Risks / unknowns

The limit table is a cached copy of published context windows and will drift
as models ship. Unknown models degrade to a null limit (figures shown, no
percentage) rather than a wrong denominator, so drift is visible rather than
silently wrong.

## Notes

Shipped in #223 (`26d85ee`); migration 013 and the backfill ran on the
2026-08-19 restart.

The null case held up on real data: all **302** unmeasured sessions have
`output_tokens = 0` and ~10 messages — genuinely empty sessions, not parser
failures. Zero unmeasured rows have output above 1k, which is the check that
would have caught a silent miss.

Model resolution covered the whole archive — every measured session resolved
to a limit, including the dated snapshots the suffix-stripping exists for
(`claude-opus-4-5-20251101` → 200K, ×377; `claude-sonnet-4-5-20250929` → 200K,
×84; `claude-haiku-4-5-20251001` → 200K, ×60). No session's last main-chain
call was `<synthetic>`, so the null-limit path is unexercised in practice but
still correct to keep.

Best demonstration of why both readings are stored: session
`177966e4` peaked at 976,990 (98%) and ended at 661,525 (66%) — 315,465 tokens
reclaimed by compaction. Final-only would have shown a comfortable 66%.

## Follow-ups
