---
status: done
depends: [kitchen-module, product-corrections, added-sugar-panel]
specs:
  - specs/modules/kitchen.md
issues: [161]
---

# Plan: two guards against a plausible-looking wrong number

## Why

Both halves of this plan close the same class of defect: a value that looks right,
lands on a tracked figure, and is never questioned. Neither is an error anything
downstream can flag, which is why prose alone was not going to be enough for
either.

**The negligible marker asserts zero sodium for salt.** `nutrition_negligible`
asserts an all-zero effective panel for products whose realistic serving
contributes nothing. Its natural reading — "seasonings and condiments qualify" —
sweeps in salt, which is ~0 on eight of the nine panel fields and roughly
38,700 mg/100 g on the ninth. A gram is ~17% of a 2,300 mg daily ceiling; a
teaspoon is the whole ceiling. So a marked salt product would assert **zero
sodium** while being the largest sodium contributor in the house, against a field
the daily view surfaces as a ceiling. That inverts the marker's justification,
which is that the error stays bounded by the category — for salt the error *is*
the dominant term.

What makes it dangerous is that the qualifying intuition ("it's a seasoning, you
use a pinch") is **true** and the conclusion is still wrong, so a careful reader
working through the general rule arrives at the wrong answer. The discriminating
pair is garlic powder versus garlic salt: adjacent on a shelf, identical to a name
filter, a factor of 400 apart on the one field that matters.

**The estimator treats billing lines as food.** When it reads receipt or
delivery-order text — which the printed-text-is-authoritative rule tells it to
trust — the money lines print in the same list, same shape, with a price
attached: delivery fee, service fee, small order fee, bag fee, tax, tip, bottle
deposit, promo credit, rounding. Estimated as food they invent calories out of a
service charge. Worse, the signed ones (a discount, a deposit return, a refund)
can arrive as negative amounts, and negative nutrition reads as *better* eating —
the one direction an owner never questions.

## Scope

1. **Spec** — § Nutritionally negligible products gains § Sodium is the exception
   that breaks the marker (the rule is "~0 in *every* field including sodium",
   salt named, garlic-powder-vs-garlic-salt as the discriminator, the guard and
   its override); § Nutrition panel gains the cross-reference where a reader
   deciding whether to mark something is looking; § Estimation & model tiering
   gains § Billing artifacts are not ingredients.
2. **The sodium guard** — `negligible-guard.ts`, a pure three-tier refusal wired
   into `POST /products` (all three branches) and `PATCH /products/:ulid`, with a
   request-level `nutrition_negligible_override` and a `--force-negligible` CLI
   flag.
3. **The estimator's non-food rule** — a prompt instruction plus an output-contract
   field: `ModelEstimate.excluded: [{text, kind}]`, persisted as
   `entries.excluded_lines` (additive migration 019) and surfaced on the entry
   read shape and the CLI entry detail. Plus the structural backstop: a negative
   panel value parses as unknown.

**Out of scope, with reasons:**

- **Backfilling or auditing products already marked.** No migration touches data.
  A pre-existing mismark keeps its marker until someone re-states it, and the
  refusal at that moment is how it surfaces — see Approach.
- **Receipt-parser line handling.** It already skips tax/total/payment lines and
  flags obvious non-groceries (§ Conservative non-food skip). The estimator is a
  different door onto the same text and is what this changes.
- **A per-quantity negligible threshold.** Argued down in the existing spec
  section and unchanged here: the flag is a property of the product, read where no
  quantity is in hand.
- **Widening the guard to every sodium-bearing food.** It targets the products a
  reasonable person *would* mark negligible, which is a far smaller set than
  "things containing sodium".

## Implements

- `specs/modules/kitchen.md` § Nutritionally negligible products § Sodium is the
  exception that breaks the marker — the every-field-including-sodium rule, the
  three evidence tiers and their ceiling, the assert-only firing condition, the
  override, and the `400` shape.
- `specs/modules/kitchen.md` § Nutrition panel — the cross-reference tying both
  assert-zero mechanisms together and pointing at the exception.
- `specs/modules/kitchen.md` § Estimation & model tiering § Billing artifacts are
  not ingredients — the exclusion rule, the fee-vs-unknown-food distinction, the
  reported-not-vanished requirement, and the no-negative-nutrition backstop.
- `specs/modules/kitchen.md` § API `POST /products` / `PATCH /products/:ulid` — the
  `400` and the override field.
- `specs/modules/kitchen.md` § Data Requirements — `excluded_lines` on entries.

## Approach

- **Three evidence tiers, none of which grants permission.** Known `sodium_mg`
  over a per-100 g ceiling; an ingredients list naming salt or sodium chloride;
  the name and aliases matching a salt-forward pattern. Ordered strongest-evidence
  first so the refusal message quotes the best reason available, but *independent*
  — a low stated sodium does not vouch for a salt-shaped name. That asymmetry
  costs nothing real: a product carrying a readable panel never needed the marker,
  since `needs_nutrition` is satisfiable by scanning it. The alternative (letting
  a transcribed number override the heuristic) would hand the guard's job to
  whichever number landed first, which on a spice jar is nobody's.
- **The ceiling is 2,000 mg/100 g, chosen with room on both sides.** Real spices
  and dried herbs land far under (garlic powder ~60, black pepper ~20, paprika
  ~68, celery seed ~160, a salt-bearing chili powder under ~1,700); everything the
  marker gets wrong lands far over (salt ~38,700, garlic/celery salt ~26,000,
  baking soda ~27,400, bouillon ~24,000, MSG ~12,300, baking powder ~10,000, soy
  sauce ~5,500). At the ceiling a generous 10 g serving is 200 mg — under 9% of a
  day, which is the bounded-error claim the marker rests on.
- **The name tier is the one that does the work, and the override is what makes
  that acceptable.** The category the marker exists for is precisely the category
  with no panel to read, so the weakest evidence is the only tier that fires on the
  bare spice jar. The false-positive story is therefore the design's load-bearing
  argument, not a footnote: a false positive costs one extra flag on one write,
  while a false negative is a wrong number on a tracked ceiling that nothing
  downstream flags. Two mitigations keep the false-positive rate honest anyway —
  salt *negations* (`salt-free`, `no salt added`, a potassium-chloride salt
  substitute, and `unsalted`, which the word-boundary match never matches inside)
  are exempt, and the salt-forward list beyond the word "salt" is deliberately
  short: bouillon, MSG, the two sodium leavening agents, soy sauce, fish sauce.
- **The guard fires only when a request ASSERTS the marker.** Silence is not an
  assertion. That is what keeps the machine paths clear — a receipt seed or label
  enrich landing on a marked product says nothing about negligibility and can
  never be refused by this — and it is why the private `upsertProductByName` used
  by the label pipeline needed no guard at all. The one addition is a `PATCH` that
  **renames** a product that stays marked: "garlic powder" → "garlic salt" is a new
  claim about a different food wearing an old record's marker. A rename that
  unmarks in the same body asserts nothing and passes.
- **Each door hands the guard the record it is about to write**, not the half the
  request happened to state: a `ulid` replace states the whole record, so the
  body's own facts are judged; a name-key enrich is judged on the merge, under the
  same never-null-clobbering precedence `enrichProduct` applies; a patch is judged
  on the post-patch composite. Otherwise a two-step (`POST {name}` then
  `PATCH {negligible}`) would slip past a guard that only ever saw one request.
- **The override is request-level, never a stored column.** It is an instruction
  about this write, not a fact about the product, and storing it would create a
  second, quieter way to be permanently marked. `--force-negligible` implies
  `--negligible` — the only reason to reach for the override is to make the
  assertion just refused, so requiring both flags would only add a way to get it
  half-right.
- **The estimator's exclusion list is a reported array, not a silent filter.**
  `excluded: [{text, kind}]` with a seven-value kind enum, normalized leniently
  (an unrecognized kind becomes `other`, a textless entry is dropped, the list is
  bounded) — the numbers are the answer and the exclusion list is the audit trail
  beside them, so a malformed entry must not fail the estimate. It persists to
  `entries.excluded_lines` on the *same write* as the numbers it explains, which
  is what makes it auditable rather than merely logged: the entry read shape
  carries it (`serializeEntry` spreads the record) and the CLI entry detail renders
  it as `kind: text` pairs. Visibility cuts both ways on purpose — a real food line
  reported as a `fee` is a bug you can read off the entry, where a silent drop just
  makes the meal smaller for no stated reason.
- **The fee-vs-unknown-food distinction is stated as an asymmetry, not a
  taxonomy.** "MISC GROCERY" and a bare department code are food the reader could
  not identify: they stay in the estimate with lower confidence. The prompt says so
  explicitly and closes with "when you are unsure which a line is, treat it as
  food" — the same direction the receipt parser's conservative non-food skip
  already resolves in, for the same reason.
- **Negative panel values parse as unknown.** The prompt rule protects against the
  model reasoning wrongly; this protects against it reasoning wrongly *anyway*. No
  food has negative calories or negative sodium, so a negative can only be a
  signed money line that reached the arithmetic, and the direction it fails in
  (a day reading as less eaten) is the one nobody questions. `null` costs one
  field; a negative corrupts the day.
- **`applyEstimate` takes the report as an optional trailing argument**, so the
  reselect/manual/recipe call sites that produce no exclusions are untouched, and
  an empty report stores the same `NULL` as no report — one representation of
  "nothing was excluded".
- **The parse moved to an exported `parseEstimateResponse`.** It is the estimator's
  whole output contract; pinning it in tests should not require standing up an API
  client.

## Validation

- [x] `bun run test`, `bun run build`, `bun run type-check:axi`,
      `bun run check:skills` all green.
- [x] The guard refuses a salt-shaped product at all four write doors (name
      create, `ulid` replace, name-key enrich, `PATCH`) and writes nothing.
- [x] It permits garlic powder — the discriminating pair passes both ways.
- [x] It permits every salt *negation* (`salt-free`, `no salt added`, salt
      substitute, `unsalted`) and every real spice in the sample set.
- [x] It refuses on the ingredients list alone (a blend whose name says nothing)
      and on a stated `sodium_mg` alone.
- [x] The override applies the marker as asked, on both `POST` and `PATCH`, and is
      never stored.
- [x] A write that makes no negligible assertion is never refused (the machine
      paths stay clear).
- [x] A rename that walks a still-marked product into a salt name is refused; the
      same rename with an unmark in the body succeeds.
- [x] The estimator prompt carries the non-food rule, the money-line list, the
      unknown-food distinction, and the exclusion report shape.
- [x] Reported exclusions land on the entry; an estimate with none stores null.
- [x] A genuinely-unknown *food* line stays food — the rule is asymmetric and the
      prompt says so.
- [x] A negative money line never becomes negative nutrition: negative panel
      values parse as unknown, `0` still means zero.
- [x] The exclusion report is not scaled by the portion multiplier.
- [x] Migration 019 is additive and nullable; no data migration runs.

## Risks / unknowns

- **The name tier is a heuristic and will have false positives.** A legitimately
  negligible product whose name happens to carry a salt-forward word is refused
  until someone passes the override. Accepted on the asymmetry above, and bounded
  by the negation list; the shape to watch is a *new* salt-forward term worth
  adding (an unmodelled seasoning category) versus a negation worth adding (a new
  way of printing "no salt").
- **Grandfathered marks are not audited.** A product marked before this guard
  keeps its marker until a write re-states it. Deliberate — a backfill would be a
  data migration, and the refusal-on-restatement is a real detection path — but it
  means the guard's protection is prospective only. A `products list` filter for
  marked-and-salt-shaped records would close it and is a follow-up, not a
  blocker.
- **The exclusion report is only as good as the model's classification.** The
  prompt tells it to keep an unidentifiable food line as food, but a model that
  files one as a `fee` drops real eating. Reporting is the mitigation rather than
  the fix: the wrong call is visible on the entry rather than invisible in the
  numbers. There is no automatic cross-check that the excluded lines sum to a
  plausible non-food share of the bill.
- **`excluded_lines` is written only by the model path.** A reselect clone of an
  entry that had exclusions does not inherit them, and a manual override does not
  clear them. Both are defensible (the report describes one estimation attempt,
  and a re-estimate overwrites it) but the field is not a general-purpose
  provenance channel and should not be read as one.

## Notes

- **The issue proposed the guard as three options, cheapest first; all three
  landed, because they cover disjoint cases rather than the same case at
  different prices.** The name filter is the only tier that fires on a bare spice
  jar, which is the case the marker exists for. A known `sodium_mg` almost never
  exists there (no panel to read is *why* the marker exists) but is free and
  exact when it does. The ingredients list is the only tier that sees a blend
  whose name says nothing — "poultry seasoning" listing salt first, which is the
  issue's own "most commercial blends that list salt first" case and the one a
  name filter structurally cannot catch. Picking one would have left a hole.
- **The issue's framing of the override as `--force` for "anything whose
  ingredients string contains salt" was narrower than what shipped.** The override
  is per-request and applies to all three tiers, because the judgement it protects
  ("this jar of flaked salt is a garnish") is a claim about *use*, not about which
  tier happened to detect the salt.
- **`--force-negligible` implies `--negligible`.** Requiring both would only add a
  way to get it half-right; the sole reason to reach for the override is to make
  the assertion just refused.
- **A patch body carrying only the override is now a `400`.** The override is an
  instruction rather than a fact, so it satisfies the body schema's
  `minProperties: 1` while changing nothing — the spec's "at least one key" rule
  had to become "at least one key that changes something" to stay true.
- **The estimator's parse is now an exported `parseEstimateResponse`.** It was a
  private method, which meant pinning the output contract in tests would have
  required constructing an `Anthropic` client. Worth knowing for the next contract
  change.
- **`mealbank.test.ts` is flaky in this environment, independent of this
  branch.** Its fixture hooks shell out to the `gitsheets` CLI under a 5,000 ms
  `beforeEach`/`beforeAll` budget, and a cold first invocation can exceed it.
  Reproduced on a clean `origin/main` worktree; passes on every warm run. Not
  caused by, and not addressed by, this plan.

## Follow-ups

- **A read surface for marked-and-salt-shaped products.** The guard is prospective
  only: a product marked before it existed keeps its marker until a write
  re-states it. A `products list` filter (or a one-off report) running
  `checkNegligible` over already-marked products would flush out any grandfathered
  mismark without a data migration.
- **No cross-check that excluded lines sum to a plausible non-food share.** The
  receipt parser has a self-check against the printed total; the estimator's
  exclusion report has no equivalent, so a model that files a food line as a `fee`
  is caught only by someone reading the entry.
- **`excluded_lines` is written by the model path only.** A reselect clone does not
  inherit it and a manual override does not clear it. Defensible (the report
  describes one estimation attempt) but worth revisiting if the field ever gets
  read as general provenance.
