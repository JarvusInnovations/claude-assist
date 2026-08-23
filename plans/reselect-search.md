---
status: in-progress
depends: []
specs:
  - specs/modules/kitchen.md
issues: [232]
---

# Plan: Text search on the reselect strip

## Scope

`GET /reselect` accepted only `limit`, so the fastest path in the module got slower
the more it was used: both halves of the strip grow, and the recents half grows
without bound — every distinct label ever logged earns a permanent row. Re-logging a
habitual item degraded from two taps into a scroll.

- `GET /reselect?q=<text>` — case-insensitive substring, server-side, applied to
  **both** collections (`recipes[].name` and `recent[].label`) **before** each half's
  `limit`.
- `kitchen-axi recipes list [--q TEXT]`, mirroring `products list --q`.
- Absent/empty `q` ⇒ the strip is exactly what it was before search existed.

**Out of scope**: deduplicating near-identical recent labels, and the mobile search
field. See § Approach.

## Implements

- **specs/modules/kitchen.md § Searching the strip** — the whole section.

## Approach

**Copy `products list --q` rather than invent a shape.** The module already had a
substring-search vocabulary — same param name, same semantics, same help register —
so search costs no new concept anywhere in the CLI, the API, or the spec.

**The two-collection detail is the whole risk.** The strip is a merge of two
independent lists, and the naive implementation narrows only the recipes — leaving
the unbounded half, the one the search exists for, untouched. Both halves are matched
in the same call, and the sheet-recipe projection (which has no query surface of its
own) is matched in the pipeline alongside them.

**Match in the WHERE, not over the page.** Each half pushes `q` down to its store so
the grouping, the ordering, and the `LIMIT` all run over the matches. Filtering a
fetched page instead would make `?q=x&limit=5` mean "matches among the top five",
which is exactly the failure the search is supposed to remove.

**No `q` is byte-identical to no search.** The optional parameter is the safety
property: the planning-session context builder, and any client that never sends `q`,
sees the strip it always saw. It is tested as a property, not assumed.

**Deduplication is deliberately not in here.** The recents half is keyed on the label
*string*, so one food logged under two wordings is two rows with split counts. Label
equality is already what groups them — relabelling the odd row collapses the pair and
transfers the count — so the fix is a relabel affordance or read-time grouping, not a
`merge` verb borrowed from products. Search alone makes the duplicate survivable;
the grouping question stays open.

## Validation

- [x] `q` narrows recipes AND recents in one call; a non-match in either half is gone.
- [x] Matching is case-insensitive on both halves.
- [x] `q` + `limit` returns the top N **matches** — proven against a fixture where
      every match sits below the unfiltered cut-off.
- [x] Absent, `undefined`, and empty `q` all return a strip equal to the pre-search
      strip.
- [x] A `q` nothing matches is an empty strip with `200`, not an error.
- [x] The planning-session call site still receives the whole strip.
- [ ] Exercised against a live instance.
