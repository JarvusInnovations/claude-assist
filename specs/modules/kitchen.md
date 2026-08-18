# Module: Kitchen

A generic consumption-journal and kitchen-inventory module for an individual
agent's instance. Sibling of the capture module — same structural idioms
(ULID-keyed idempotent upserts, status-as-work-queue, store interface with
pg/memory implementations, sweep worker, Fastify routes) — with its own tables
and its own `/api/kitchen/*` surface. Single-user by design: the module serves the
instance owner and exposes no sharing or multi-user surfaces.

Phase 1 covers consumption entries, estimation, and recipes. Phase 2 (below)
adds inventory: receipts, labels, a receipt lexicon, stock state, and
events-in-passing.

## Data Requirements

All tables are instance-agnostic empty schema; records enter an instance only
through the module's APIs (never as committed seed content).

- **Entries** — one row per consumption entry, ULID primary key supplied by the
  client so offline replays are idempotent upserts (a replay must never
  duplicate or regress a processed entry). Fields: timestamp (`logged_at` — the
  meal's own moment, client-supplied and post-hoc editable; see § Logged-at
  backdating), optional free-text
  note, resolved label, nutrition estimate (calories + macros with a
  confidence/portion basis) stored as the **base**, estimation source
  (`model` | `reselect` | `manual`), a **portion multiplier** (post-hoc rescale
  of the base — see § Portion multiplier), the note-derived portion modifier
  (applied once at estimation time, baked into the base), optional recipe
  reference with per-component quantities, optional inventory-item links (phase 2),
  and the estimator's non-food exclusion report (`excluded_lines`, null when
  nothing was excluded — § Billing artifacts are not ingredients).
- **Recipes** — named loggable templates: name, optional per-ingredient
  components (label, default quantity, per-100g macros), source
  (`sheet` | `pushed` | `promoted`), created/updated stamps, and an
  `archived_at` retirement stamp (null while live — § Recipe corrections).
  Sheet-sourced recipes are read-through projections of the configured meal-bank
  gitsheet — the module never writes the sheet.
- **Estimation status** doubles as the work queue:
  `estimating → estimated | failed`, attempt-capped. A `failed` entry is a
  valid, rollup-visible entry awaiting a manual label.
- **Photos are never persisted.** Meal photos arrive inline (multipart) on the
  entry POST, are held in memory for the model call, and are discarded on every
  outcome. No disk writes, no object storage, no staging prefixes. Records carry
  no image data. The client retains its local copy until the entry is confirmed
  processed and re-posts to retry a stale `estimating`.

## Portion multiplier

Every entry carries a `portion_multiplier` — a positive number, default `1`.
It is the owner's **post-hoc** "I only ate half of that" knob: after an entry is
logged (by photo, recipe, or manual override), the multiplier rescales how much
of the entry actually counts, without touching the per-field macro estimate.

**Base vs effective — the wire rule.** The entry's stored nutrition fields
(the panel — see § Nutrition panel: `calories`, `protein_g`, `fat_g`,
`sat_fat_g`, `carbs_g`, `sugar_g`, `added_sugar_g`, `fiber_g`, `sodium_mg`) are the
**base**: the amount as estimated, recipe-computed, or manually overridden. The
entry wire shape (POST / GET / list responses) carries those base fields
**exactly as stored, unscaled**, alongside `portion_multiplier`. **Every consumer
computes effective macros itself: `effective = base × portion_multiplier`.** This
is the one rule, applied everywhere — entry tiles, day-group totals, the briefing
daily totals, and any future macro consumer. The wire never carries pre-multiplied
macros; base-on-the-wire is unambiguous (a macro field always means the base) and
lossless (no division needed to recover the base).

## Nutrition panel

An entry's nutrition is a **nine-field panel**: `calories`, `protein_g`,
`fat_g`, `sat_fat_g`, `carbs_g`, `sugar_g`, `added_sugar_g`, `fiber_g`,
`sodium_mg`. Each field is a number or `null` (unknown is `null`, never `0` — a
missing value must not read as "zero of it"). `added_sugar_g` and `sodium_mg` are
ceilings the owner overshoots and feels; `fiber_g` is a floor the owner has to aim
at — the three the daily view surfaces beyond calories/protein.

**Asserting zero is a claim about all nine fields.** Two mechanisms in this module
assert `0` where a `null` would otherwise erase a day's field: § Filling
`added_sugar_g` (whole foods are `0` by definition) and the product-level
`nutrition_negligible` marker (§ Nutritionally negligible products). Both are only
sound where the number really is ~0, and the field that breaks the second one is
`sodium_mg` — salt is ~0 on the other eight and ~38,700 mg/100 g on that one, so
"seasonings qualify" sweeps in the biggest sodium line in the kitchen. Garlic
powder qualifies; garlic salt does not. Read § Sodium is the exception that breaks
the marker before marking anything.

### A panel means nothing without its basis

A product can hold the same nutrition twice — `serving_size_g` +
`nutrition_per_serving`, and `nutrition_per_100g`. **Two stored representations of
one fact can disagree, and the disagreement is invisible at read time** because both
columns look equally authoritative. This is the third member of the
plausible-looking-wrong-number family (§ Nutritionally negligible products § Sodium
is the exception; § Estimation & model tiering § Billing artifacts are not
ingredients): a value that looks right, lands on a tracked figure, and is never
questioned.

**Per-100 g is DERIVED, never stated, wherever serving data exists.** § Data model
§ Raw serving capture already establishes this for the label-scan path
(`derivePer100gFromServing`, "capture as printed, scale late"), on the reasoning
that serving arithmetic is the classic extraction error. That reasoning does not
stop at the label pipeline, and the rule must not either: **every write door that
can set a panel derives it the same way.** A door that accepts a caller-stated
per-100 g alongside a per-serving panel re-opens exactly the hole the label path
closed, and it is the *quieter* door — a label scan is at least reviewable as a
transcription, while an API caller's per-100 g arrives with no source at all.

Concretely, when a write leaves both representations present:

- `nutrition_per_100g` is **recomputed** from `nutrition_per_serving ÷
  serving_size_g × 100`. A caller-supplied per-100 g is ignored, not merged.
- A caller-supplied per-100 g is honoured **only** when there is no serving basis
  to derive from — the genuine per-100 g case (labels printed per-100 g, and
  reference-sourced foods such as unpackaged produce, which carry no label at all).
- A stated per-100 g that **contradicts** a derivable one is a refusal, not a silent
  overwrite, so a caller that believes it has better numbers finds out rather than
  winning by writing last.

**Observed failure.** In a production ledger, 2 of 18 products carrying both
representations had silently disagreed. In each case most fields had been scaled
correctly and one or two had not — and the un-scaled fields were **plausible round
numbers for the food category** rather than off by a consistent factor, which is the
signature of recall substituted for arithmetic on a per-field basis. `calories` was
wrong in both. One product under-reported its own energy by a third; the other
likewise. Neither had gone through the label pipeline; both were written through the
agent-facing product endpoints, which is why the existing derivation never ran.

**Tolerance for the legacy check.** While rows predating this rule still carry a
stated per-100 g, a consistency check compares each field against its derived value
and flags `|stated − derived| > 8% + 0.6`. The absolute floor is load-bearing: label
values round hard at small magnitudes, so 0.5 g of saturated fat is a 100% relative
error against 0.4 g and means nothing. Calibrated against the ledger above, this
band flagged exactly the two genuinely-wrong rows and none of the sixteen sound
ones.

### Panel operations belong in one implementation

Rebasing, scaling to a weight, summing components into a meal, and validating
coherence are one concern, not four helpers. A helper gets bypassed at a call site;
a value type that carries its own basis has to be constructed, and cannot be scaled
as if it were the other basis. Every server-side surface that computes nutrition —
product writes, entry computation, recipe resolution, consume (§ Consume from
inventory), receipt-lexicon seeding — goes through it.

**Validation rejects at write time rather than storing-and-flagging**: no negative
fields (§ Billing artifacts already establishes that a negative can only be a signed
money line), saturated fat ≤ fat, added sugar ≤ total sugar, and stated calories
within a loose band of `4·protein + 4·carbs + 9·fat`. The band must stay loose —
real labels miss it legitimately on sugar alcohols, fiber accounting, and rounding
at small servings — because a check that fights reality is a check that gets
disabled.

### `added_sugar_g` vs `sugar_g` — two quantities, one target

`sugar_g` is **total** sugar. `added_sugar_g` is the portion added during
processing or preparation. They are not interchangeable, and only one is a target.

**Only `added_sugar_g` carries a ceiling.** There is no established guideline for
total sugar: WHO's 10%/5%-of-energy thresholds and the AHA limits govern *free* or
*added* sugars and explicitly exclude the intrinsic sugars in whole fruit and milk.
A ceiling on `sugar_g` is therefore a borrowed number, and it misfires in a
specific, corrosive way — a day of fruit, milk, and plain yogurt reads "over" while
containing almost no added sugar. An alarm that fires on the owner's best-eating
days trains him to ignore it, which costs more than the signal is worth.

- `added_sugar_g` — **a real ceiling**, surfaced in the daily view alongside sat
  fat, sodium, and fiber.
- `sugar_g` — **still captured, still displayed, no target.** Context for the
  owner's own judgment ("was today fruit-heavy?"), not a line to breach. The guards
  against an all-fruit day are already tracked: the calorie ceiling, the protein
  floor, and fiber.

**Juice counts as added.** The precise concept is WHO's *free sugars* — added sugar
plus honey, syrups, and fruit juice. Labels report "Added Sugars," so that is what
a scan captures, but a source estimating a juice-bearing item attributes its juice
sugar to `added_sugar_g`. Whole fruit and plain dairy never contribute.

**Display: one nested bar, not two.** Total sugar is the bar's full extent; the
added portion is a filled segment inside it, and the threshold marker sits at the
*added* ceiling. One object then answers three questions — how much sugar, how much
was added, and whether the added part crossed its line — without implying total
sugar has a threshold. Two side-by-side bars would double the visual weight and
reintroduce the false-alarm reading this change exists to remove.

The rule governs the *figure*, not the pixels, so a text surface obeys it the
same way: the CLI day view renders the pair as **one** value —
`62.4 total, added 1.2 / 36 max (34.8 left)` — the total stated bare and the
`logged / target` verdict attached only to the added portion. It never emits a
second, peer sugar line; that is the text equivalent of the two bars. A day whose
added portion is unknown reads `added unknown`, never `added 0`. (A tabular
multi-day rollup is not a bar and carries both as plain columns, neither judged.)

### Filling `added_sugar_g`

- **Labeled packaged foods** — US Nutrition Facts panels have carried "Includes Xg
  Added Sugars" since the 2016 rule, so a product seeded from a label gets it
  directly. Highest-confidence path. (Receipts carry no nutrition; this lands in
  product seeding and label capture, not the receipt parser.)
- **Whole foods** — fruit, vegetables, plain dairy, eggs, meat, fish, plain grains
  and legumes are `0` **by definition, not `null`**. A source recognizing an
  unprocessed single ingredient asserts zero rather than unknown.
- **Restaurant and prepared dishes** — a genuine estimate, reasoned from the
  visible sweeteners: glazes, sauces, dressings, marinades, baked goods, sweetened
  drinks. Confidence is lower and that is acceptable; a reasoned estimate beats
  `null`, which reads as "no data" and silently drops the day's total.
- **`null` remains legal** and means unknown. A day's `added_sugar_g` is null only
  when no entry carried it.

**Every source fills the whole panel it can.** The panel is only useful if it's
complete regardless of *how* a meal was logged:

- **Model-estimated** entries (photo / note) — the estimator returns all nine
  fields; its prompt and output schema enumerate the full panel (so `sugar_g`,
  `added_sugar_g`, and `fiber_g` are estimated alongside the rest, not left
  null), with the attribution rules of § Filling `added_sugar_g`.
- **Recipe / component-computed** entries (a reselect recipe, a `--recipe` log,
  and the derived-item macros § Consume from inventory reads) — computed from the
  recipe's per-ingredient `per_100g` reference, which carries the **full panel**
  (not just `calories`/`protein_g`/`sat_fat_g`). `computeRecipeMacros` sums every
  panel field across the components × logged quantities, so a deterministically
  logged meal no longer silently drops `sodium_mg` / `sugar_g` / `fiber_g` /
  `fat_g` / `carbs_g` to null. A component may still omit a field it genuinely
  doesn't know; the sum then treats that component's contribution to that field
  as unknown, not zero (a field is null in the total only when no component
  carried it).
- **Reselect-clone** ("recent") entries copy the source entry's base panel
  verbatim, so they inherit whatever it had.
- **Manual override** sets whichever panel fields the owner pins.
- **Directly-stated panel** — a client that has *already computed* an entry's
  full panel locally (a recipe-scaling or portion-builder UI, a bulk importer, a
  fully-resolved label scan) supplies the nine fields verbatim at creation. No
  estimator runs and no recipe is resolved — the numbers **are** the answer.
  Source `manual`, terminal from birth (see § Directly-stated panel entries).

The daily rollup sums the full panel. The nine fields are the canonical set the
whole module (storage, estimator, recipes, rollup, patch-override keys, the
meal-template contract's `per_100g`, and the client displays) agrees on — one
list in code (`NUTRITION_FIELD_KEYS`), which every panel iteration derives from
rather than re-enumerating.

Consequences of this choice:

- `confidence` and `portion_basis` are **not** scaled — the multiplier changes
  how much was eaten, not how confident the estimate is.
- Re-adjusting the multiplier always rescales **from the base**, so it is
  idempotent and never compounds: setting `0.5` then `0.75` yields exactly
  `0.75 × base`, not `0.375 × base`.
- `portion_multiplier = 1` (the default and the value on every pre-existing row)
  makes effective ≡ base, so the wire is byte-identical to the pre-feature shape
  for every unscaled entry.

**Distinct from adjacent mechanisms:**

- *Not* the note-derived portion modifier (`portionModifierFor`): that fires once
  at estimation time on standalone words like "half"/"double" and **bakes into
  the base**. The multiplier is the separate post-hoc knob the owner turns later.
- *Orthogonal to the manual override*: a manual override sets the **base**; the
  multiplier scales it. A `manual` entry can carry a multiplier ≠ 1, and setting
  a multiplier does **not** flip `source` to `manual`, re-queue estimation, or
  change any macro field.

Bounds: `0 < portion_multiplier ≤ 20` (the API rejects non-positive or absurd
values). It is set via `PATCH /entries/:ulid`.

## Directly-stated panel entries

There are three ways an entry can come to exist with useful macros: **compute**
it from a recipe/component reference, **guess** it from a photo or note via the
model, or **state** it — hand over the finished nine-field panel because the
caller already did the arithmetic. The first two are creation shapes today; the
third is not, and its absence forces a two-step (`POST` → model estimate →
`PATCH` override) for every client that already knows the exact numbers.

**Rule.** `POST /entries` accepts a `macros` panel object as a creation shape
**mutually exclusive** with `recipe_ulid`, component quantities, and
`reselect_of` (`400` if combined with any). When present:

- The nine panel fields are stored **as the base**, verbatim — no field is
  re-derived, defaulted, or rounded. Unstated fields are `null` (unknown), never
  `0`, exactly as everywhere else in the panel.
- The entry is born `source: 'manual'`, `status: 'estimated'` (terminal) — the
  same terminal state a `PATCH` override produces, reached in one atomic write.
- **No estimation job is ever enqueued.** This is the load-bearing property, not
  a nicety: the `manual`-is-terminal guarantee (`PATCH` may not be
  model-overwritten, § Endpoints) has a *birth-race hole* — a `POST` that
  enqueues estimation, followed by an immediate `PATCH`, can have the override
  land first and the late-finishing estimate clobber it, because that estimate is
  the entry's *original* pass, not a "later" one the 409-guard blocks. A
  directly-stated panel enqueues nothing, so there is nothing to lose the race
  to. The two-step is not merely more work — it is racy by construction; this
  shape is the fix.
- `note`/`label` may accompany the panel (provenance, e.g. what computed it);
  editing them afterward via `PATCH` **does not** re-queue estimation for a
  `manual` entry (as today). `portion_multiplier` applies normally.

**This is orthogonal to how recipes evolve.** Whatever a recipe *is* or becomes,
a caller that has resolved a meal to exact numbers needs a way to record the
answer rather than resubmit its inputs for re-guessing. The directly-stated panel
is that primitive; it neither depends on nor constrains the recipe model.

Its first in-system caller is **§ Cook mode**, where an eaten prep worksheet's
computed panel lands through exactly this shape.

## Principles

**Local:**

- **A caller that knows the answer states it; the system never re-guesses it.**
  When a client has already computed an entry's full panel, the module records it
  verbatim and runs no estimator over it. Re-deriving numbers a caller already
  holds is worse than useless — it discards precision *and* opens a clobber race
  against the correction that would restore it. Deterministic-in beats
  estimate-then-correct wherever the caller can supply the panel.

## Expenditure & net energy (claude-assist#121)

The module tracks intake; the actual weight-loss target is the daily energy
**balance** — deficit = expenditure − intake. Expenditure is a first-class
record so that balance is computable in-system instead of by manual Garmin
pulls and hand math.

**`kitchen.expenditures`** — one row per activity/burn: `ulid` (client-
suppliable idempotency key, same convention as entries), `occurred_at`
(ISO date-time — the activity's own moment, backdatable), `source`
(`'strava' | 'health_connect' | 'garmin' | 'manual'`), `label` (e.g.
`"Evening ride"`), `kcal` (numeric, required — active calories, not gross),
`duration_min` (numeric, nullable), `avg_hr` (numeric, nullable),
`created_at`/`updated_at`. Deletable
(`DELETE /expenditures/:ulid`, same remove-from-rollups semantics as
entries). No model estimation path — expenditure numbers always arrive
stated (a device said it, or the owner did); the module never guesses a
burn.

**API**: `POST /kitchen/expenditures` (idempotent on ulid, returns the bare
row, `201`/`200` replay), `GET /kitchen/expenditures?since&limit` →
`{ expenditures, count }`, `DELETE /kitchen/expenditures/:ulid`,
`GET /kitchen/expenditures/skipped` → `{ skipped, count, tz }` (§ Skip
visibility, below the Strava sync contract).

**The net line.** The daily rollup gains: `expenditure_kcal` (sum of the
day's expenditure rows), `tdee_base_kcal` (instance-configured
`KITCHEN_TDEE_BASE` — the owner's estimated non-exercise daily expenditure;
absent config ⇒ the net line is simply omitted, never guessed), and
`net_kcal = (tdee_base + expenditure) − intake` (positive = deficit). Home
view, daily briefing, and the app's day header surface it alongside the
intake total.

**Framing rule (normative, not cosmetic):** exercise-calorie estimates are
unreliable (±20–30%, HR-derived) and "eating back" exercise calories is a
weight-loss trap. Every surface presents the net line as **context, not a
spend-it budget** — the primary target stays intake-managed (the diet
protocol's intake range), and no surface may render remaining-intake
headroom *derived from* the day's burn. The value is seeing the honest
balance, not licensing more intake.

**Source architecture — one feed per data type, by reliability tier:**

- **Exercise burns → Strava API (phase 2 — § Strava activity sync).**
  Every real workout lands in Strava (Garmin writes through, carrying
  Garmin's own calorie computation), and it is the only listed source with
  a stable official OAuth API suitable for unattended scheduled pulls. The
  full contract is § Strava activity sync below.
- **Weight → Health Connect via the capture app (phase 3 — § Weigh-ins).**
  The Android Health Connect hub is the only path to the smart scale. The
  capture app reads it on-device and posts `kitchen.weigh_ins` rows; the
  full contract is § Weigh-ins below, written against two probe dumps
  (2026-07-26): the scale app shares weight + body-fat pairs only (water/
  lean mass are not written), Garmin occasionally writes its own weight
  row, and the platform's timestamps arrive zone-naive.
- **Recovery signals — mostly Health Connect now; `garmin-pull` only for
  the proprietary leftovers.** The 2026-07-26 probe dumps falsified this
  bullet's original premise ("exist nowhere else"): detailed sleep
  (sessions + stages) and daily resting HR flow through Health Connect
  from Garmin. Only body battery, stress, and HRV/training-readiness stay
  locked in Garmin's app, where the janky authenticated-session replay
  would be the sole path — acceptable never as an automated dependency.
  Boundary (owner decision, 2026-07-26): that deeper telemetry is
  **owner-domain by design** — it lives instance-side as a periodic
  health-analysis protocol, segmented out of this module entirely. The
  module's only Garmin touchpoint is `source: 'garmin'` on occasional
  manual-assisted expenditure imports; the deficit pipeline never depends
  on it.

Until any feed lands, `manual` entries via the CLI cover the need (v1).

**Module boundary (what kitchen owns vs what rides on top).** The module
owns the *primitives and the arithmetic*: the expenditure (and later
weigh-in) records, their CRUD, and the deterministic net line — computed
server-side so every surface reads one consistent number — plus the
generic scheduled Strava sync (instance-credentialed, same precedent as
the mail sync). Everything interpretive stays outside: the owner's
targets and how to read a deficit are doctrine (agent-side); the
`KITCHEN_TDEE_BASE` value is opaque instance config the module never
guesses or auto-tunes (adjusting it against the weigh-in trend is an
agent-judgment loop); session-replay pulls and training orchestration are
API clients, not module code. And a deliberate anti-scope line: kitchen
stores **just enough burn to compute the balance** — no routes, laps,
splits, or training load. It is not an activity tracker; the exercise
system of record stays upstream.

## Strava activity sync (phase 2 — the exercise auto-feed)

The scheduled server-side pull the source architecture names primary: real
workouts land as expenditure rows on their own, no agent in the loop. The
sync is a transcriber with a clock — it inserts stated burns and never
judges them.

**Config.** `KITCHEN_STRAVA_CLIENT_ID`, `KITCHEN_STRAVA_CLIENT_SECRET`,
`KITCHEN_STRAVA_REFRESH_TOKEN` — all three present ⇒ the sync runs; any
absent ⇒ the feature is entirely off (never partial, never guessed).
Optional `KITCHEN_STRAVA_SYNC_MINUTES` (default 30) sets the cadence on the
module's scheduler.

**Token custody.** Strava rotates the refresh token on every refresh, so a
static env var cannot stay authoritative. `kitchen.strava_oauth` (single
row) holds the current refresh token, access token, and expiry; the env
refresh token is the **first-boot seed only** — once the row exists, the
stored token is authoritative and the env value is ignored (delete the row
to re-seed after a revocation). A refresh failure skips that tick with a
warning log; it never crashes boot and never wipes the stored row (the next
tick retries — transient Strava outages must not force a re-auth).

**Pull contract.** Each tick lists the athlete's activities over the
trailing 7 days, then — only for activities whose seeded ulid is not
already stored — fetches the activity **detail** (calories exist only
there) and inserts an expenditure row:

- `ulid` = `ulidFromSeed(0, "strava:<activity_id>")` — the locked
  convention (the manual backfill used it, so the sync's first run replays
  those rows instead of duplicating them).
- `label` = activity name (fallback: activity type), `kcal` = the detail's
  calories, `duration_min` from moving time, `avg_hr` when present,
  `occurred_at` = the activity's start instant, `source: 'strava'`.
- An activity with no calorie value is **skipped with a log line** — a burn
  is a stated number, never a written 0 (absent ≠ zero, same doctrine as
  the nutrition panel). This is a *permanent* skip, not a deferral — see
  § Skip visibility below for what that means and how it surfaces.

**Idempotency IS the watermark.** The sync keeps no cursor: the 7-day
window plus seeded-ulid replays are the resume semantics. A tick that dies
mid-batch costs nothing; the next tick re-lists and replays. Detail calls
happen only for unseen activities, which keeps steady-state API usage at
one list call per tick — far inside Strava's rate limits.

**Cross-source rule.** The sync only ever inserts its own seeded rows — it
never deletes, merges, or edits anything, including a manual row that
overlaps a synced activity's time span. An overlap is surfaced as a warning
log for owner judgment (stated-burns doctrine: the module records; the
owner arbitrates duplicates).

**Skip visibility (claude-assist#214).** A calorie-less activity is not
merely skipped *this tick* — the trailing-window relist re-evaluates it on
every future tick too and reaches the same answer, so it is never
imported, permanently. That refusal is correct (a written 0 asserts
"burned nothing," which is worse than an absent row), but read at the
verb boundary it can sound like it forbids logging the activity by hand.
It does not: **an activity Strava reports with no calorie value is the
owner's to state, via `expenditure log`, exactly because the feed will
never state it.** This matters most for manually-entered Strava
activities — Strava's manual-entry form has no calories field, and
without HR or power data Strava computes none — so the activity most
likely to need a stated burn (a pool swim, a gym session, anything a
device missed) is exactly the one the feed will never produce.

A permanent, silent skip is otherwise indistinguishable from "hasn't
synced yet" without reading server logs, so the sync keeps a live skip
list: `StravaSync.getSkipped()` returns the *current tick's* skipped
activities (activity id, label, start instant) — rebuilt fresh on every
successful run, not accumulated, so an activity that ages out of the
trailing 7-day window (or finally carries a calorie value) simply stops
appearing. Nothing is persisted for it; there is no new table, and a
failed tick (e.g. token refresh) leaves the prior list in place rather
than clearing it. `GET /kitchen/expenditures/skipped` and
`expenditure list --include-skipped` read this live list, so a permanent
skip is answerable from the CLI in one call instead of a log search.

**Anti-scope.** Unchanged from § Expenditure & net energy: just enough burn
to compute the balance — no routes, laps, splits, gear, or kudos. Strava
remains the exercise system of record; this feed carries numbers, not
activities. Also out of scope here: linking a manually-stated burn back to
the Strava activity it corresponds to (an optional `--strava-activity-id`
on `expenditure log`) — tracked as a follow-up, not built by this section.

## Timezone & local-day bucketing (module-owned, not caller-owned)

AXI output is consumed **only by LLM agents**, and the tool's job is to make
agent mistakes hard (AXI design guide). Handing back a bare UTC instant and
leaving the agent to derive the local calendar day is a footgun that fires
reliably — UTC-vs-local day-bucketing is a recurring agent-error class (two wrong
week-reviews on 2026-07-26 came from exactly this: an agent hand-bucketing
`logged_at` by its UTC date). So the module **owns** timezone and day-bucketing.
No AXI caller ever supplies, knows, or computes a timezone/offset to get correct
day-grouped data. This **reverses** the prior "caller owns its day boundaries"
stance (the home view's local-window hack and any caller-computed day windows go
away).

**Owner timezone is module config.** A single configured IANA zone
(`KITCHEN_OWNER_TZ`, e.g. `America/New_York`) is the one source of truth for
every day boundary — instance config in the same spirit as `KITCHEN_TDEE_BASE`.
Unset ⇒ the module falls back to UTC **and says so** in the affected output
(a stated fallback, never a silent guess).

**Every timestamped row surfaces its local day.** Entry, expenditure, and
weigh-in rows — in list and detail AXI output — carry a `day` field: the
owner-tz calendar date (`YYYY-MM-DD`), computed server-side. Displayed times
render in the owner's local zone, not a bare `Z` UTC string. An agent grouping,
filtering, or bucketing keys off `day`; it must never parse a timestamp to derive
a day. (The precise UTC instant stays in the record for ordering and machine use,
but no AXI surface *requires* deriving local day from it.)

**Per-day totals are a pre-computed aggregate (AXI §4), never a caller
aggregation.** A first-class rollup — `kitchen-axi days [--since <n|date>]` over a
`GET /kitchen/summary` day-grouped mode — returns **per-owner-local-day** rows:
the nine-field nutrition panel, calories, and the net line (when
`KITCHEN_TDEE_BASE` is set), one row per day, computed server-side in the owner
zone. An agent asking "how did the week go" calls it **once** and gets correct
numbers. Hand-summing entries into daily/weekly totals is the expensive follow-up
AXI §4 warns against **and** the exact operation that produced the 2026-07-26
mis-buckets — the rollup exists so no agent ever does it.

**Applies to the whole module surface:** the home view's "today" totals, the
`entries`/`expenditure`/weigh-in lists, the summary/net line, the briefing daily
totals, and the weekly trend all bucket by the owner zone via this one config —
no surface re-derives day boundaries independently.

**Inventory dates are owner-local calendar days.** The `DATE`-typed inventory
columns — `acquired_at`, `opened_at`, `closed_at`, `storage_moved_at`, the
`purchase_batches.purchased_at` they descend from, the `eat_by` those anchor, and
the dates written into toss/consumption/reconcile audit notes — are the *owner's*
calendar day of the act, never the UTC day. This is stated rather than left to
"the whole module surface" because it was violated exactly once and silently: a
UTC-stamped inventory date and an owner-bucketed journal entry, written seconds
apart for the same meal, disagreed by a day for every evening event in a
western-hemisphere instance. The two must always name one day.

Three inputs, one rule:

- **No date supplied** → the owner-local day *now*. This is the common path and
  was the defective one.
- **A bare `YYYY-MM-DD`** → taken **verbatim**. The caller named a calendar day
  and the column stores calendar days; there is no instant in between, so no
  offset is applied — including by the CLI, which passes these flags through
  unconverted rather than routing them via § Logged-at backdating's local-noon
  coercion. That coercion belongs to `timestamptz` fields (`logged_at`,
  `occurred_at`), where a bare date genuinely must become *some* instant;
  applying it to a calendar-day field would make the stored day depend on where
  the CLI ran, which is precisely the caller-owned timezone this section
  abolishes.
- **A full timestamp** → the owner-local day its wall clock reads.

The derived read-time counts (`days_until_eat_by`, `age_days`) measure from the
owner-local *today* for the same reason: read from a UTC evening, "today" is
already tomorrow and every remaining-days figure comes back one short. And where
an inventory verb also writes a consumption entry (§ Consume, § Stated-weight
consumption), the entry's `logged_at` resolves through the same zone, so the item
and its entry cannot disagree.

## Weigh-ins — scale data via the capture app (phase 3)

Weight is the goal metric and the empirical tuner for `KITCHEN_TDEE_BASE`
(and, downstream, the § Daily targets calories line). Readings originate on
the owner's scale, reach Android Health Connect via the scale app, and arrive
here from the capture app, which reads the platform store on-device. The
module transcribes observations and derives; it never decides.

**Data.** `kitchen.weigh_ins`: `ulid`, `occurred_at` (timestamptz — the
poster supplies an explicit zone offset; the platform emits zone-naive local
timestamps and only the device knows its zone, so the app attaches it and
the server never infers a clock), `weight_kg`, `body_fat_pct` (nullable —
the scale writes weight+body-fat pairs; other writers send weight alone),
`source` (writer package id, e.g. the scale app's, or `manual`),
`created_at`. **Every reading is a row**, including same-morning repeats and
non-scale writers — noise is handled at read time, never by refusing or
rewriting observations (capture-verbatim, derive-in-code).

**Idempotency.** A Health-Connect-sourced row's ulid is seeded
`ulidFromSeed(0, "healthconnect:<record-uuid>")` — same convention as
`strava:<id>` — so re-reads are replays. The POST accepts either a
caller-supplied `ulid` or an `hc_uuid` the server seeds from (exactly one;
keeping the seed function server-side means no client reimplements it).
Manual rows use fresh ulids.

**API.**

- `POST /kitchen/weigh-ins` — one reading; idempotent (`201`, `200` replay
  returning the stored row); body: `{ ulid | hc_uuid, occurred_at,
  weight_kg, body_fat_pct?, source }`. `occurred_at` MUST carry an explicit
  UTC offset — a zone-naive timestamp is a `400`, not a guess.
- `GET /kitchen/weigh-ins?since&limit` — raw rows, newest first.
- `GET /kitchen/weight?days=N` (default 30) — the derived read:
  - `daily[]` — one entry per local day that has readings (bucketed by each
    reading's own stored offset): `date`, `weight_kg` (the day's **median**
    reading — same-morning repeats spread up to ~0.7 kg, and a median
    shrugs at both repeats and the odd manual entry), `body_fat_pct`
    (median of the day's non-null values), `readings` (count).
  - `trend[]` — 7-day rolling mean over `daily` values (computed over the
    days that exist in the window; no interpolation, no invention).
- `DELETE /kitchen/weigh-ins/:ulid` — removes a bad reading.

CLI: `weigh-ins list [--since] [--limit]`, `weigh-ins log --weight KG
[--body-fat PCT] [--at TIME]` (manual entry), `weight trend [--days N]`.

**Derivation is read-time and non-destructive.** Collapse (daily median)
and trend live in the read path only — the raw rows are never merged,
deleted, or "corrected" by the module. And the standing rule extends here:
the module serves the trend; **retuning `KITCHEN_TDEE_BASE` or any § Daily
targets line against it stays an owner/agent judgment loop** — no
auto-adjustment, ever.

## Daily targets — owner-set reference lines

The owner's diet doctrine defines per-nutrient daily reference lines (a
sat-fat cap, a fiber floor, an intake band). The module stores them as opaque
instance config and serves them with the daily rollup so every client renders
logged-vs-remaining against the **same** lines — the config is the single home
for the numbers; clients stop hardcoding their own copies. The module never
derives, tunes, or interprets a target (retuning the lines against labs/trend
is an owner/agent-judgment loop, like `KITCHEN_TDEE_BASE`).

**Config.** `KITCHEN_DAILY_TARGETS` — a JSON object mapping panel field names
(§ Nutrition panel: `calories`, `protein_g`, `fat_g`, `sat_fat_g`, `carbs_g`,
`added_sugar_g`, `fiber_g`, `sodium_mg`) each to exactly **one** of `{"max": N}`
(a cap — stay under) or `{"min": N}` (a floor — reach it). Any subset of fields
may be configured; an unconfigured field simply has no line. A malformed
value — unknown field, both bounds, non-positive N — fails loudly at boot,
never silently drops (a half-parsed budget is worse than none).

**`sugar_g` is the one panel field that is deliberately NOT targetable**
(§ `added_sugar_g` vs `sugar_g`) — total sugar is served and displayed, but a
config naming it is **refused at boot**, with an error saying the ceiling belongs
to `added_sugar_g`. Silently ignoring the retired key would leave an instance
believing it still has a sugar line; the generic unknown-field message would tell
it the field doesn't exist, which is wrong. The added-sugar ceiling is instance
config like every other line (36 g/day is the AHA's stated limit for men, 25 g
for women) — the module suggests nothing and defaults nothing.

**Exposure.** The daily rollup (`GET /kitchen/summary`) gains `targets`: the
parsed config, verbatim. Absent config ⇒ the block is **omitted entirely,
never defaulted** (same rule as the net line). `remaining = target − logged`
is display arithmetic computed client-side — the module serves the two
numbers, not the judgment. The CLI day summary lists each configured line as
`logged / target` with remaining.

**Direction is semantic, not styling.** A `max` exceeded is a breach; a `min`
met is success. Clients MUST NOT style a met floor as an overrun (30 g of
fiber is the goal, not an alarm) — the cap/floor distinction travels with the
target precisely so no client has to guess which way a line points.

**Framing rule (inherits § Expenditure & net energy).** Targets are static,
intake-managed lines. The `calories` target is never adjusted by expenditure
or net — the existing rule that no surface renders intake headroom derived
from the day's burn applies unchanged; a budget sheet shows the net line as
separate muted context, never folded into a remaining figure.

## Logged-at backdating

Every entry carries `logged_at` — the moment the meal actually happened, which
is **not** the same as when it was logged. Logging a gallery photo hours after
eating is the common case: the entry must land on the meal's day, not the
logging day.

**The timestamp is deterministic, never model-inferred.** `logged_at` is set by
the client from a concrete source and is directly editable by the owner; the
estimation model is deliberately **not** given authority over time. This is the
module's *deterministic-beats-estimated* principle applied to the time axis:

- Gallery-picked photos carry an EXIF capture time (`DateTimeOriginal`) which
  *is* when the meal happened — the client defaults `logged_at` to the earliest
  selected photo's capture time.
- Camera-shot-now photos, no-EXIF files, and note/reselect-only logging default
  to now.
- The owner can always override via a visible, editable affordance (the composer
  time chip; the correction sheet "Logged at" row).

A future implementer must **not** hand the model authority to infer or adjust
`logged_at` from photo content or note text — the note-derived portion modifier
governs PORTION only, never time.

**`logged_at` is PATCHable**, as a fourth orthogonal axis on `PATCH
/entries/:ulid` (alongside note/label re-queue, macro override, and portion
multiplier):

- Accepted on **any** entry regardless of `source` (including `manual`). It
  **never re-queues estimation, never changes `source`, and never 409s** — like
  the portion multiplier, it touches only its own column. It may be sent alone
  or composed with any other patch field.
- Because every rollup (day-group totals, the briefing daily totals, weekly
  trend) filters and buckets by `logged_at`, moving an entry's `logged_at`
  moves it — and its effective macros — to the new day automatically. Rollups
  are never stored, so nothing else must be recomputed.

**Bare-date coercion → local noon.** When a `logged_at` (or a CLI `--at`) is
supplied as a **bare calendar date** with no time-of-day (`YYYY-MM-DD`), it
coerces to **noon in the owner's local timezone**, never midnight UTC. Midnight
UTC is the previous evening across US zones, so a bare date logged for "today"
buckets onto the wrong day; noon local sits safely inside the intended day for
any real-world offset. This is a **backstop for a caller that omitted the time**,
not a substitute for it — a caller that knows the meal's actual time should send
the full local timestamp (with offset), and only a genuinely time-less date falls
back to noon. Callers/agents SHOULD always supply a specific local time when they
have one; the coercion only rescues the bare-date case.

**Bounds.** `logged_at` must be a valid ISO date-time that is neither in the
future beyond clock/timezone skew nor absurdly old:

- Not later than `now + 24h`. A full day of future tolerance absorbs
  device-clock skew and timezone ambiguity (EXIF `DateTimeOriginal` carries no
  zone) while still rejecting a plainly-future date.
- Not earlier than `now − 5 years`. Generous enough for any legitimate backfill
  of an old photo, tight enough to reject a corrupt/typo'd stamp (epoch 0, year
  0001, a mis-parsed EXIF value). The API rejects out-of-range or unparseable
  values with `400`.

These bounds are enforced at the API (they are relative to the server clock, so
they cannot be a static DB `CHECK`); the column itself is unchanged
(migration-free).

## Reselect cloning (recent entries)

The reselect strip (§ API `GET /reselect`) merges recipes with recent logged
items. The two kinds of pill re-log by different deterministic mechanisms, and
neither spends a model call:

- **Recipe pills** re-log via `recipe_ulid` (+ optional component quantities);
  macros are recipe-computed.
- **Recent pills** re-log by **cloning a source entry**. Each recent summary the
  strip carries names, in an `entry_ulid` field, the source entry it summarizes:
  the **most-recent estimated occurrence** of that label. The pill re-logs by
  POSTing `reselect_of: <entry_ulid>` (never a bare, identity-less entry — a
  bare POST would blind-estimate a note-less, photo-less entry into a garbage
  meal).

**The clone is deterministic — never a model call.** On ingest with
`reselect_of`:

- The server resolves the source entry and copies its **label** and **base macro
  fields** (`calories`, `protein_g`, `fat_g`, `sat_fat_g`, `carbs_g`,
  `sodium_mg`, plus the `confidence`/`portion_basis` describing them) onto the
  new entry, then sets `source: 'reselect'` and `status: 'estimated'`
  immediately. The estimator is never invoked.
- `portion_multiplier` is **not** cloned — it defaults to `1`. The clone is a
  fresh serving; the source's post-hoc "I only ate half" rescale does not carry.
- A `note` riding the same POST is stored on the clone as a comment and does
  **not** trigger estimation. This is the deterministic implementation of the
  spec's "optional comment carried onto the cloned entry" for recents — the note
  is retained, but a reselect clone never runs the model over it.
- Cloning from **any** source entry is legal regardless of its `source`
  (`model` | `reselect` | `manual`) — the numbers are the numbers. The clone is
  an independent entry; its own later corrections (note/label re-queue, macro
  override, multiplier, backdate) follow the normal PATCH rules.

**Mutual exclusivity & errors.** `reselect_of` and `recipe_ulid` may not both
appear on one POST (`400`). An unknown or deleted source ULID is rejected `400`
with a clear "unknown source entry" error — never a silently-empty clone.

**Deleted source.** `entry_ulid` always references a live estimated entry at
strip-build time: the recents query groups only `estimated` entries by label and
takes the most-recent occurrence's ULID as `entry_ulid` (the same row whose base
macros the summary carries). The strip is a client-cached snapshot, so a source
entry can be deleted (e.g. an agent DELETE) between strip build and replay; the
resulting `reselect_of` then 400s. The client treats that 400 as a **permanent,
non-retryable send failure** surfaced through the send-failed affordance — the
local optimistic clone keeps its label + macros visible for retry-or-discard —
rather than spinning retries that can never succeed. Refreshing the strip drops
the stale pill.

**Recent-summary wire shape** (`GET /reselect` `recent[]` item): `{ entry_ulid,
label, calories, protein_g, fat_g, sat_fat_g, carbs_g, sodium_mg, last_logged_at,
log_count }`. The macro fields are the source entry's **base** (unscaled) macros.

## Recipe corrections — upsert on name, explicit-ulid replace, archive

A recipe's numbers get corrected: a component was wrong, a per-100g reference
was off, a name needs to change. A correction has to **replace** the recipe, not
fork it. Recipes are tapped from the reselect strip by *name* — a pill carries a
name, not a ULID — so two same-named recipes are indistinguishable to whoever
taps one, and the stale fork keeps logging the wrong numbers. That is the worst
available failure mode, because every tap looks like success.

**`POST /recipes` upserts.** The request may carry an optional `ulid`:

- **With `ulid`** — create-or-replace that exact record, idempotent on the key
  (the same client-supplied-ULID convention `POST /inventory` uses). A replace
  overwrites `name` + `components` and bumps `updated_at`; `ulid`, `created_at`,
  and `source` are preserved (replacing a `promoted` record leaves it
  `promoted`). A create with a caller-supplied `ulid` is `pushed`. An explicit
  key is explicit intent, so this is the escape hatch for every ambiguous case
  below.
- **Without `ulid`** — the **normalized name** is the key: case-folded,
  whitespace-collapsed, trimmed. Resolved against the non-archived
  DB-persisted recipes:
  - No match → create a new `pushed` recipe (`201`).
  - Exactly one match with `source: 'pushed'` → replace it in place (`200`),
    same ULID. Entries referencing it keep resolving and the strip keeps showing
    one pill.
  - A match with `source: 'promoted'`, or a name collision with a
    `sheet`-sourced recipe → `409`. A promoted recipe is the record of something
    the owner actually logged, and a sheet recipe belongs to the meal-bank sheet
    this module never writes; neither may be clobbered by a name collision on a
    push. The error names the colliding ULID and its source, and states both
    ways forward: rename, or pass `ulid` to replace deliberately.
  - More than one `pushed` match (duplicates that predate this rule) → `409`
    naming every candidate. The upsert refuses to guess which fork is canonical.
- The response is the bare recipe row either way; the status distinguishes
  create (`201`) from replace (`200`).

**`POST /entries/:ulid/promote` refuses a `promoted` name twin.** Promote is the
other door into the recipe table, and it inserts. Promoting twice under one label
therefore used to mint a second `promoted` recipe with the same name — the exact
indistinguishable-pill failure the upsert above exists to prevent, reached by a
different route. Promote now **refuses with `409`** when a live `promoted` recipe
already holds the normalized name.

It refuses rather than replacing, unlike a push: a promoted recipe is the record
of *one* entry's resolved macros, so replacing one derived from a **different**
entry would silently rewrite it with unrelated numbers. The remedy is a distinct
name (`{"name": "..."}` in the body) or archiving the existing recipe — which
frees the name, since the check only sees live rows.

**Scoped to `promoted` collisions only, deliberately.** An entry logged *from* a
recipe carries that recipe's name by construction, and promoting it is an
intended flow — component reconstruction exists to serve it — so a `pushed` or
`sheet` twin is permitted here. That leaves a narrower ambiguity alive: one
`pushed` and one `promoted` recipe can share a name, and the strip will show two
pills. Collapsing names across sources is a broader design question than closing
the fork hole, and is **not** decided here.

**`DELETE /recipes/:ulid` archives — it never destroys.** An `archived_at`
stamp, not a row deletion:

- An archived recipe **leaves the reselect strip** and every merged recipe
  listing (`GET /reselect`, the module's full merged recipe view, the briefing's
  stock-aware suggestions), so it can never be tapped again.
- It stays **resolvable by ULID forever**: an entry logged from it still names a
  live recipe, `POST /entries/:ulid/promote`'s component reconstruction still
  works, and a derived inventory item whose provenance points at it stays
  one-tap consume-eligible (§ Consume from inventory). Retiring a template must
  never break history.
- **Idempotent**: archiving an already-archived recipe succeeds and returns the
  same row. Unknown ULID → `404`. A `sheet`-sourced ULID → `404` saying so —
  sheet recipes are a read-through projection and this module never writes the
  sheet, so there is nothing here to archive.
- There is deliberately **no hard delete**. This is the same "state, not delete"
  idiom the inventory side already uses (§ Non-inventory dismissal, and the
  `finished`/`tossed` terminals): the row survives for provenance, and a state
  filter — never a row removal — is what takes it off the live surfaces.

### Principles (local)

- **A correction replaces; it never forks.** When a caller re-states something
  the system already holds under the same identity, the system updates that
  record instead of minting a second one. Two records with one name and
  different numbers are worse than one wrong record: nothing downstream can tell
  them apart, so the wrong one keeps getting picked.
- **Retire by state, never by deletion.** Anything an entry, batch line, or
  derivation can point at is archived rather than deleted. Provenance outlives
  usefulness.

## Product corrections — upsert, patch, merge, archive

A product accretes facts over its life: a receipt seeds a bare name, a label
scan adds a panel, the owner fixes a mangled store abbreviation. Creation is
therefore never the last write, and a create-only surface is a broken one — the
`needs_nutrition` flag on any product born without a panel is unclearable, and
posting the product again to enrich it mints a duplicate instead.

The identity rules mirror § Recipe corrections, with one deliberate divergence
called out below (a name-key hit **enriches** rather than replacing).

**`POST /products` upserts.** The request may carry an optional `ulid`:

- **With `ulid`** — create-or-replace that exact record, idempotent on the key
  (the same client-supplied-ULID convention `POST /inventory` and
  `POST /recipes` use). A replace **states the whole record**: every field the
  body omits reverts to its default (`null`, `unknown` for
  `shelf_life_class`, `[]` for `aliases`, `false` for
  `nutrition_negligible`) — an explicit key plus a full body is an explicit
  claim about the record's whole content, and it is the only way to *clear* a
  field. `ulid` and `created_at` are preserved; `updated_at` bumps. An
  archived record is **not** resurrected by a replace: `409`, naming the
  survivor when it was merged away.

  An explicit key also **bypasses the name checks below**, deliberately. The
  escape hatch out of a name-key ambiguity is "pass the ulid of the one you
  mean"; if that path re-checked the name it would be blocked by the very
  collision it exists to resolve.
- **Without `ulid`** — the **normalized name** is the key: case-folded,
  whitespace-collapsed, trimmed. Resolved against the live (non-archived)
  products:
  - No match → create (`201`).
  - Exactly one match → **enrich it in place** (`200`), same ULID.
  - More than one match (duplicates that predate this rule) → `409` naming
    every candidate. The upsert refuses to guess which duplicate is canonical;
    the error states both ways forward — pass `ulid`, or merge the duplicates.
- The response is the bare `Product` row either way; the status distinguishes
  create (`201`) from replace/enrich (`200`).

**A name-key hit enriches; it does not replace.** This is the divergence from
`POST /recipes`, and it follows from what the two records *are*. A recipe is
its name plus its components — a caller pushing one states the whole thing, so
overwriting is exactly right. A product is a many-field accretion built by
several independent writers, and the label pipeline already merges onto it
per-field, never null-clobbering (§ POST /inventory/:ulid/label). If a name-key
POST replaced, a receipt seed carrying `{name, shelf_life_class}` would silently
erase a scanned nutrition panel — a write that destroys data it never mentioned.
So the name key uses the same precedence the label enrich uses: supplied
non-null fields win, omitted or null fields keep the existing value,
`nutrition_per_100g` / `nutrition_per_serving` merge **per-field**, `aliases`
union-merge, and `shelf_life_class` only overrides when the incoming class is
not `unknown`. Clearing a field is reachable only through the two explicit
doors — `PATCH`, or a `ulid` replace.

**`PATCH /products/:ulid` is the correction door.** Partial by definition:

- Only the keys present in the body change; every other field is untouched.
  At least one key that *changes something* is required (`400` otherwise — a body
  carrying only `nutrition_negligible_override`, which is an instruction rather
  than a fact, states no change).
- An explicit `null` **clears** a nullable field. This is where `PATCH` differs
  from every enrich path in the module: enrichment must never null-clobber
  because its input is a *guess* about a field it may simply not have read,
  while a `PATCH` body is the owner stating what is true. `null` there means
  "there is no value", not "I didn't look".
- `nutrition_per_100g` / `nutrition_per_serving` merge **per-field**: a body of
  `{"nutrition_per_100g": {"sodium_mg": 120}}` fills sodium and leaves the
  other eight alone; `{"sodium_mg": null}` clears just sodium;
  `{"nutrition_per_100g": null}` clears the whole panel. Filling one missing
  field is the overwhelmingly common correction, and it must not require
  restating eight numbers the caller would have to re-read to avoid destroying.
- **`name` is patchable.** A product's identity is its `ulid`, not its name:
  items, lexicon lines, and batch lines all link by `product_ulid`, so a rename
  can't orphan anything, and receipt-derived names badly need correcting
  (`"OLV OL X-VRG 750ML"` → `"Olive Oil"`). This is the opposite of a recipe,
  where the *name* is the tap target on the reselect strip. One guard: a rename
  that **changes** the normalized name into another live product's → `409`.
  Renaming into a collision would manufacture exactly the duplicate the
  name-key upsert and the merge path exist to remove; the error names the twin
  and points at merge. Restating the name a product already has is never a
  collision with itself, so patching other fields alongside an unchanged `name`
  always works.
- Patchable fields are every stored fact: `name`, `shelf_life_class`,
  `aliases`, `nutrition_per_100g`, `nutrition_per_serving`, `serving_size_g`,
  `servings_per_container`, `net_content_g`, `net_content_ml`,
  `unit_model_hint`, `ingredients`, `package_size`,
  `shelf_life_days_unopened`, `shelf_life_days_opened`,
  `nutrition_negligible`. Unknown ULID → `404`. Returns the bare updated
  `Product`.

**`POST /products/:ulid/merge` folds a duplicate into a survivor** — body
`{ into: <survivor ulid> }`. Duplicates already exist in the wild (the
create-only `POST` minted one on every re-seed), and a plain delete is the
wrong tool for them: the losing record is what an inventory item, a lexicon
line, and a receipt batch line already point at, so deleting it orphans live
records and loses the mapping work the lexicon represents. A merge is what the
situation actually calls for. In one operation:

1. **Enrich the survivor** from the loser under the same never-null-clobbering
   precedence a label enrich uses — the survivor's own values win, and the
   loser's facts fill what the survivor lacks. A merge must not lose the panel
   that happens to live on the duplicate. The loser's **name joins the
   survivor's aliases**, so depletion and lexicon matching on the retired
   spelling keeps working — that spelling is exactly what some receipt prints.
2. **Relink every dependent** to the survivor: `inventory_items.product_ulid`,
   `receipt_lexicon.product_ulid`, `purchase_batch_lines.product_ulid`. The
   response reports the counts.
3. **Retire the loser** — `archived_at` stamped and `merged_into` set to the
   survivor.

Rules: `into` must differ from `:ulid` (`400`); either ULID unknown → `404`;
`into` already archived → `409` (merging into a retired record would bury the
data twice over, and following a merge chain invites cycles — the error names
its `merged_into` so the caller retargets). **Idempotent**: re-merging an
already-merged loser into the same survivor succeeds with zero relinks.
Merging it into a *different* survivor → `409` naming where it went.

**`DELETE /products/:ulid` archives — it never destroys.** Same stamp, no
`merged_into`, for the retire-with-nothing-to-merge case (a product seeded from
a misread receipt line that never existed). An archived product:

- Leaves `GET /products` and every live listing, and stops being a candidate
  for the name-key upsert or a name match — so it can never be re-seeded into
  or matched against again.
- Stays **resolvable by ULID forever**. An item still linked to it keeps
  rendering `product_name`, its shelf-life overrides still derive, and a
  lexicon line still resolves. Retiring a record must never break history.
- **Idempotent**; unknown ULID → `404`. There is deliberately **no hard
  delete** — the same "state, not delete" idiom as § Recipe corrections and the
  inventory terminals.

### Nutritionally negligible products

`nutrition_negligible` (bool, default false) is an owner-set assertion that
**every panel field is ~0 at any realistic serving of this product — including
`sodium_mg`**. Spices, dried herbs, vinegar, black coffee, extracts, and the
seasonings that are only seasoning. **Not salt**, and not anything salt-forward;
see § Sodium is the exception that breaks the marker below.

It exists because the `needs_nutrition` flag is otherwise unclearable for a
whole category. A US spice jar carries **no Nutrition Facts panel at all** —
FDA exempts foods containing insignificant amounts of every nutrient — so
"scan the label" is not an available answer, and neither is § Absent line = 0,
which needs a panel to read absences from. A normal spice rack therefore
accrues permanently-flagged items, and a flag that can never be cleared trains
the reader to ignore it, at which point it stops working for the items that
*are* actionable. Widening the panel makes it worse: every added field
retroactively flags every pre-existing product.

**Effects, both of them:**

1. **`needs_nutrition` is false** for any item whose linked product is marked,
   regardless of panel completeness — at the item view (`GET /inventory`, the
   CLI list, the app) and everywhere the signal is read. The flag means "a
   number is missing that could be found", and for a marked product that is not
   true.
2. **The product's effective panel reads as all zeros.** The marker is an
   assertion about the numbers, not merely a request to stop asking. A caller
   resolving a marked product's nutrition (building a recipe component from it,
   costing a serving) gets `0` for every field it doesn't otherwise know —
   never `null`. This is load-bearing, not a nicety: under the module's
   per-field null semantics a single unknown contribution makes a whole day's
   field read *unknown* (§ Nutrition panel — "a field is null in the total only
   when no component carried it"). A pinch of paprika whose sodium is `null`
   costs the day its entire sodium figure. Asserting zero is the same move
   § Filling `added_sugar_g` already requires of whole foods, which state `0`
   **by definition, not `null`**.

**The marker asserts a realistic-serving approximation, with no quantity
threshold — deliberately.** 100 g of paprika is genuinely ~282 kcal, so the
zeros are wrong at that quantity. Accepted anyway, for three reasons. *First,
there is nothing to condition on*: the flag is a property of the **product**,
read at points that hold no quantity, so a threshold rule would have no
argument at the moment it needed one. *Second, a context-dependent flag is
worse than a bounded-error one*: two reads of the same product would disagree
about whether it has nutrition, which is precisely the "indistinguishable
records" failure the rest of this section exists to remove. *Third, the error
is bounded by the category and by the alternative.* A product qualifies only if
realistic use is a teaspoon or two, so the worst-case drift is single-digit
calories a day — against a `null` that erases a whole field of a whole day.
Nobody eats 100 g of paprika; someone cooking with that much is logging a
*dish*, which is logged as an entry or a recipe carrying its own numbers, not
by consuming a spice jar.

#### Sodium is the exception that breaks the marker

The rule is "~0 in **every** field, sodium included" — not "~0 in calories and
macros". The distinction is not pedantry; it is the whole difference between a
marker whose error is bounded and one whose error is the dominant term.

**Salt is the counterexample.** Table salt is ~0 on eight of the nine panel
fields and roughly **38,700 mg of sodium per 100 g** on the ninth. One gram is
~390 mg — about 17% of a 2,300 mg daily ceiling; a teaspoon is essentially the
whole ceiling in one spoon. A salt product marked negligible would assert **zero
sodium** while being the single largest sodium contributor in the kitchen, and it
would do it against a field the daily view surfaces as a **tracked ceiling**. That
inverts the justification above: the marker is affordable because a product
qualifies only if realistic use is a teaspoon or two, so the worst-case drift is
single-digit calories a day. For salt the drift is not bounded by the category —
it *is* the category.

**What makes it dangerous is that the qualifying intuition is true.** "It's a
seasoning, you use a pinch" is a correct statement about salt, and the conclusion
drawn from it is still wrong. A careful reader reasoning their way through the
general rule arrives at the wrong answer, which is why this is stated as its own
exception rather than left to follow from "every field".

**The discriminating pair: garlic powder qualifies, garlic salt does not.**
~60 mg/100 g against ~26,000. They sit adjacent on a shelf, read identically to a
name filter, and differ by a factor of 400 on the one field that matters. The
same shape covers celery salt, onion salt, seasoned salt, bouillon powder, MSG,
the sodium leavening agents (baking soda ~27,400 mg/100 g, baking powder
~10,000), soy and fish sauce, and **most commercial blends that list salt first**
— a blend whose *name* says nothing about salt is the case no name filter can
see.

**A guard enforces this, because prose protects a careful reader and nobody
else.** The write doors refuse a `nutrition_negligible` assertion on evidence of
salt, in descending order of evidence strength: a **known `sodium_mg`** over a
per-100 g ceiling (2,000 mg — well above every real spice, well below everything
salt-bearing); an **ingredients list** naming salt or sodium chloride; or the
**name and aliases** matching a salt-forward pattern, with salt *negations*
(`salt-free`, `no salt added`, a potassium-chloride salt substitute) explicitly
exempt. No tier grants permission — a low stated sodium does not excuse a
salt-shaped name, since a product carrying a readable panel never needed the
marker at all.

- **The guard fires only when a request asserts the marker.** Silence is not an
  assertion, so a receipt seed or a label enrich landing on a marked product is
  never blocked by this; the machine paths stay clear. A `PATCH` that **renames**
  a still-marked product also asserts — "garlic powder" → "garlic salt" is a new
  claim about a different food wearing an old record's marker.
- **There is an override, because this is a judgement.**
  `nutrition_negligible_override: true` on the `POST`/`PATCH` body (CLI:
  `--force-negligible`, which implies `--negligible`) applies the marker as
  asked. It is a request-level instruction, never a stored fact. The case it
  exists for is real — flaked finishing salt used a few crystals at a time — and
  the asymmetry justifies the shape: a false positive costs one extra flag, while
  a false negative is a wrong number on a tracked ceiling that nothing downstream
  flags.
- **Refusal is a `400` naming the evidence and the override.** Never a silent
  un-marking: a write that cannot do what was asked says so (§ Principles).

A consequence worth stating: a product marked before this guard existed keeps its
marker until someone re-states it, and the refusal at that moment is exactly how
a pre-existing mismark surfaces.

**Never inferred, never backfilled — and never un-marked by an enrich.**
Marking is a deliberate per-product act by the owner or an agent acting on an
explicit instruction: no category heuristic sets it, no migration backfills it,
and only an explicit `PATCH` (`nutrition_negligible: false`) clears it. An
enrich carries no evidence *against* negligibility — a later receipt seed
saying nothing about it is silence, not a retraction. The stored
`nutrition_per_100g` is **not** rewritten to zeros either: the assertion stays
one reversible boolean, zeros are derived at read time, and a real panel found
later supersedes the marker without anyone having to tell asserted zeros from
scanned ones.

### Principles (local)

- **A write that cannot do what was asked says so.** It never discards the
  intent and reports success. The create-only `POST /products` accepted an
  existing `ulid`, stripped it, minted a new record, and answered `201` — a
  duplicate reported as a create, indistinguishable from the enrichment the
  caller asked for. An unhonorable request is a `4xx`; silently doing something
  adjacent is the worst outcome available, because nothing downstream can tell
  it from success.
- **A flag nobody can clear is worse than no flag.** Any "needs attention"
  signal must have a reachable resolving action for every case it fires on. When
  a category has none, the signal gets an honest way to be satisfied rather
  than being left to fire forever — an unclearable alarm trains the reader to
  ignore the clearable ones too.

## Meal-bank sheet consumption

The module reads a meal-bank gitsheet owned by the instance's own repo:

- Wiring is **instance configuration** — repo path + sheet name via env; no
  source is hardcoded in the toolkit.
- The module **publishes its meal-template contract document** (gitsheets schema
  contract, `contracts/meal-template.v1.schema.json`, name
  `gitsheets.io/meal-template/v1`) as its named interface; any sheet
  satisfying it works. The read opens with `contract: { schema, mode:
  'verify' }` (gitsheets ≥ 2.5.0) — rung-1 declared identity preferred,
  structural fallback — and a contract failure is a wiring-time refusal,
  never a mid-read surprise.
- **Verification outcomes**: a sheet that declares the contract
  (`implements` + byte-identical vendored copy) verifies by identity with no
  record scan; a contract-unaware sheet whose records structurally conform
  still reads, with a log line noting the undeclared conformance (so sheets
  predating contract adoption never regress); a non-conforming sheet is
  refused at wiring time — the read logs the `ContractError` and returns no
  sheet recipes, and reselect degrades to recents-only, exactly like the
  missing-config path. The server never crashes on a bad sheet, and reads
  are never blocked mid-flight (post-wiring drift is an advisory log).

## API

All endpoints under `/api/kitchen`. Error envelope and auth follow the server's
existing conventions. Every path here is under the `/api` prefix; a request to
the bare `/kitchen/…` path space belongs to the admin SPA's client-side routes
and is **not** an API surface — see `specs/behaviors/http-not-found.md` for what
such a request gets (never a false `200`).

### Request validation is strict, not permissive

Every write body (and any querystring with named parameters) is
`additionalProperties: false` over an explicit key list — this was already the
intent everywhere in this module (§ The cook seam in `specs/modules/pages.md`
states the same rule for the worksheet sink) — but stating `additionalProperties:
false` is not sufficient on its own: Fastify's default AJV compiler sets
`removeAdditional: true`, and that combination makes AJV **silently strip**
unmatched keys instead of rejecting the request, no matter how the schema reads.
A caller who misnames a field (`nutrition` for `nutrition_per_100g`) gets a
`200` with the rest of the body applied and the misnamed field discarded
unmentioned — a partial write reported as a full success, indistinguishable at
the response from every other partial-field PATCH this module makes legal on
purpose. The module installs its own strict validator (`removeAdditional:
false`) wherever it declares a body or querystring schema, so an unrecognized
key is always a `400` that **names the offending key** and, where there is an
unambiguous near-miss among the schema's real keys, says what it probably meant.
This is a module-local fix — the same Fastify default applies to every other
module's schemas — scoped here because this module is what regressed.

- `POST /entries` — multipart: entry JSON part (ULID, timestamp, note,
  optional recipe ref + component quantities, `reselect_of`, **or** a `macros`
  panel) + 0..N photo parts. Posts immediately (`estimating` when photos present
  and no deterministic source; `estimated` when recipe-computed, reselect-cloned,
  or a `macros` panel was supplied). Idempotent on ULID. `recipe_ulid`,
  `reselect_of`, and `macros` are **mutually exclusive** (`400` if more than one,
  or if `macros` is combined with component quantities or photos). `reselect_of`
  clones a source entry deterministically — see § Reselect cloning; a `macros`
  panel is stored verbatim as a born-`manual` terminal entry that enqueues no
  estimation — see § Directly-stated panel entries.
- `GET /entries?since|limit` — newest-first listing for client sync.
- `PATCH /entries/:ulid` — note/label edits re-queue estimation; a macro
  override sets source `manual` and is terminal (no later model pass may
  overwrite it). 409 on attempts to model-overwrite a `manual` entry. A
  `portion_multiplier` (positive number, ≤ 20) is accepted on any entry
  regardless of source — it rescales the base post-hoc, never re-queues
  estimation, never changes `source`, and never 409s (§ Portion multiplier). A
  `logged_at` (ISO date-time, bounded — § Logged-at backdating) is likewise
  accepted on any entry, moving it to a new day without re-queue or source
  change. Any of these axes may be sent alone or composed in one PATCH (override
  sets base, multiplier scales it, logged_at moves the day).
- `DELETE /entries/:ulid` — removes the entry from all rollups.
- `GET /reselect` — the strip: recipes (sheet + pushed + promoted) merged with
  recent/frequent logged items. Each recent item carries an `entry_ulid` — the
  source entry it summarizes — so a recent pill can re-log by cloning it (§
  Reselect cloning). See § Reselect cloning for the recent-summary shape and how
  `entry_ulid` is derived.
- `POST /recipes` — agent-pushed one-off or reusable templates. **Upserts**:
  `201` on create, `200` on replace, `409` on a name collision it must not
  resolve by guessing — see § Recipe corrections for the key rules.
- `DELETE /recipes/:ulid` — **archives** a recipe (soft, `archived_at`): gone
  from the strip, still resolvable by ULID for historical entries and derived-item
  provenance. Idempotent; `404` for an unknown or `sheet`-sourced ULID. See
  § Recipe corrections.
- `POST /entries/:ulid/promote` — creates a recipe from a logged entry.
- Rollup queries (daily totals, weekly trend) are computed, never stored, over
  **effective** macros (`base × portion_multiplier` per entry); they feed the
  instance's briefing/review renderings.

## Plan-session — app-initiated warm meal-planning session

`POST /api/kitchen/plan-session` is the kitchen module's use of the generic
session-spawn service (`specs/modules/session-spawn.md`). It is the server side
of the "Plan meals" button: the app taps it, the endpoint gathers the current
kitchen state, composes a warm-start **preload prompt**, and asks the shared
`SessionSpawner` to warm an interactive session and ping the phone with a
takeover link. The endpoint returns only an **acknowledgement** — never the
link, which rides the push alone (§ security below).

The meal-planning briefing is the only kitchen-specific part; the spawn
machinery is entirely generic. This endpoint is a *configured caller* of the
session-spawn module.

### Request

`POST /api/kitchen/plan-session` — no body required. A body, if sent, is
ignored (the endpoint gathers everything server-side). No auth beyond the
server's existing posture.

### Context gathered (server-side)

The endpoint reads its own module data and builds a concise current-state
briefing. All of it comes from the kitchen stores directly — no external call:

- **Today's effective totals** — sum of `base × portion_multiplier` over
  today's `estimated` entries (today = the server-local day), plus a count of
  entries still `estimating`. Computed the same way the briefing daily-totals
  source computes them (§ Portion multiplier); the wire never pre-multiplies.
- **Eat-first inventory (top N)** — the most-urgent on-hand items
  (`stocked`/`open`, `on_hand_fraction > 0`), ordered `eat_by` ascending — the
  same eat-first ordering the inventory list and briefing use. Default N small
  (a briefing, not a dump).
- **Recent entries** — a handful of recently/frequently logged meals (the
  reselect "recent" summaries), so the session opens knowing what the owner
  actually eats.
- **Reselect / meal-bank options** — the reselect strip's recipes (sheet +
  pushed + promoted), so meal-bank meals are on the table from the first turn.
- **Open needs-info items** — a note of how many inventory items are awaiting
  info (and a few examples), so the session can nudge the owner to resolve them.

### Preload prompt

The endpoint composes these into a **preload prompt**: a short current-state
briefing (the totals, the eat-first list, recent meals, meal-bank options, open
needs-info count) followed by an instruction that **this is a warm
meal-planning session** and that, when the human takes over, the assistant
should help plan meals that **use what is aging and hit the owner's targets**.
It is a warm-start briefing, not a full data dump — the session's working
directory (instance config on the spawn command) already gives it the kitchen
CLI and diet protocol to pull more if needed. The prompt names no instance data
that isn't already the owner's own kitchen state.

The prompt is handed to `sessionSpawner.spawn({ preloadPrompt, title, group })`
with a title like `"meal-planning"` and the group `kitchen`.

### Model

Meal planning is an interactive session the owner is waiting on, so it gets an
explicit model rather than the CLI's sticky interactive default (session-spawn
§ Model selection). `KITCHEN_PLAN_SESSION_MODEL` overrides the instance-wide
`SESSION_SPAWN_MODEL` for this caller only; unset (the normal case) ⇒ the
instance default applies. This is the model a *human* session runs on under
subscription auth — unrelated to `KITCHEN_ESTIMATION_MODEL` /
`KITCHEN_RECEIPT_MODEL`, which are the module's own metered API models.

### Response

An **ack, never the link**:

- **`200`** — spawn accepted and dispatched. Body: `{ status: "spawned",
  spawn_id: string }`. The takeover link was delivered to the phone (redacted at
  rest per session-spawn § dispatch-and-redact); it is **not** in this response.
- **`503`** — spawning is not configured (`SESSION_SPAWN_CMD` unset, or the
  session-spawn/notify modules are absent). Body: `{ error: string }`. The app
  shows a clear "not available" state; nothing partial spawns.
- **`502`** — the spawn command failed (non-zero exit, timeout, or no link
  produced). Body: `{ status: "failed", spawn_id: string }`. A failure push was
  dispatched (no link). The response carries no reason detail beyond the status
  and no link.

The response shapes above are the exact wire contract the app codes against.

### Security — link never in the response or logs

The endpoint returns only the session-spawn service's record fields (`status`,
`spawn_id`) — the record itself never contains the link
(`specs/modules/session-spawn.md` § security). Therefore a screenshot or log of
the app's HTTP exchange can never leak a session handle. The link exists only in
the delivered push, redacted at rest. The endpoint logs only the spawn id and
status, never the link.

### Principles

**Inherited** — [session-spawn](session-spawn.md#principles): the link rides the
push and nothing else; the endpoint spawns but does not reason (the human takes
over under their own human-driven credentials). The endpoint pulls the trigger;
the planning conversation happens after takeover.

## Estimation & model tiering

- One structured-output vision call per estimation attempt: photos + note →
  {label, calories, macros, confidence, portion_basis}; the note-derived
  portion modifier applies server-side.
- **The capture action is the type hint.** Deliberate paths (meal photo,
  receipt scan, label scan) never spend a classification call. Model tier is
  configured per job (env): strongest vision tier for open-ended meal
  estimation; cheap/fast tiers for mechanical extraction jobs (phase 2
  receipts/labels). Unhinted photos (share-intake) get a cheapest-vision
  classify-then-route pass.
- **Printed text in frame is authoritative over visual inference.** When a
  meal photo shows printed text describing the food — an order sticker, a
  packaging label, a menu board, or a nutrition panel in frame — the
  estimator reads and trusts that text for identity, size, and ingredients
  ahead of what the eye alone would infer, and confidence rises when the
  text corroborates the visual read. The estimation prompt carries this
  instruction explicitly; a photo with no legible text behaves exactly as
  before. This is the meal-estimation instance of capture path 1's rule
  (`specs/diet-journal.md` § Capture paths): the lazy shot with the label in
  frame is the *most* accurate technique, not the least.

### Billing artifacts are not ingredients

The rule above makes printed text authoritative, and the text a delivery order or
a store receipt prints is not only food. **Delivery fee, service fee, small order
fee, bag fee, priority fee, sales tax, tip, bottle deposit, promo/coupon/loyalty
credit, rounding, refund, balance** — these appear in the same list as the items,
in the same shape, with a price attached. Read as food they invent calories out of
a service charge.

**The rule: such a line is not food and is excluded rather than estimated.** It
lives in the estimation prompt and in the output contract, not only in the prose
here, because the failure is a plausible-looking number rather than an error.

Three things it must get right:

- **A fee line and an unidentifiable *food* line are different answers.** "MISC
  GROCERY", a store's generic department code, an abbreviation nobody can expand —
  that is food the reader could not identify, and it stays in the estimate with
  lower confidence. A delivery fee is definitely not food. Collapsing the two into
  one "skip it" bucket would silently delete real eating, so the rule is
  asymmetric on purpose: **when unsure which a line is, treat it as food.** Same
  direction the receipt parser's § Conservative non-food skip already resolves in
  (ambiguity resolves toward inventory), for the same reason — a wrongly dropped
  food line is invisible, a wrongly kept one is a question.
- **Exclusions are reported, not silently vanished.** The estimator returns
  `excluded: [{text, kind}]` — the line as printed plus one of
  `fee|tax|tip|deposit|discount|adjustment|other` — and the entry stores it
  (`excluded_lines`, null when nothing was excluded, on the same write as the
  numbers it explains). An exclusion is a *judgement about the source text*, and a
  judgement nobody can see is one nobody can correct. It is also the only way the
  opposite error becomes visible: a real food line reported as a `fee` is a bug
  you can read off the entry, where a silent drop just makes the meal smaller for
  no stated reason.
- **A signed money line is still not food, and never becomes negative
  nutrition.** A discount, a deposit return, and a refund are negative amounts;
  no food has negative calories or negative sodium. So the panel parse **rejects a
  negative as unknown** rather than storing it — the structural backstop under the
  prompt rule. This matters more than the arithmetic suggests: a credit line
  subtracting from a day's total reads as *better* eating, which is the one
  direction an owner never questions.

Out of scope here: the receipt parser's own line handling. It already skips tax,
totals, and payment lines outright and flags the obvious non-groceries
(§ Conservative non-food skip); this rule governs the **estimator**, which reasons
over receipt and order text from a different door.

## Integration seams

- **Ambient remarks**: the capture module's classifier gains a `kitchen_event`
  type; its executor hands remark text to this module's event resolver
  (phase 2). Deliberate diet actions never route through the classifier.
- **Renderings**: briefing/review sources read the module's rollup queries
  read-only, per the server's existing briefing-source pattern.

## Phase 2 — Inventory (receipts, labels, lexicon, stock, events)

Inventory tracks the physical units in the house so meal planning can steer
toward what is aging and waste trends toward zero. Everything here is
directional — a fraction estimate that self-heals at the next event, never a
gram ledger that demands bookkeeping. All state changes are non-blocking:
receipts and labels post immediately and enrich asynchronously, exactly like
phase-1 entries.

### Data model

All tables instance-agnostic empty schema, ULID keys, `kitchen` schema
(migration `002-kitchen-inventory.sql`).

- **`kitchen.products`** — durable facts about a kind of item (not a physical
  unit): `ulid`, `name`, `shelf_life_class` (enum, see below), `aliases`
  (text[] — alternate names for depletion/lexicon matching),
  `nutrition_per_100g` (JSONB `{calories, protein_g, fat_g, sat_fat_g, carbs_g,
  sodium_mg, fiber_g, sugar_g, added_sugar_g}`, any field null = unknown;
  nullable),
  `ingredients` (text — the full ingredients list as printed on the panel, e.g.
  `"Cultured pasteurized milk, salt, enzymes"`; nullable; migration
  `006-kitchen-product-ingredients.sql`), `package_size` (text, e.g. `"16 oz"`;
  nullable), `shelf_life_days_unopened` / `shelf_life_days_opened` (int,
  label-derived precise overrides of the class default; nullable), `created_at`,
  `updated_at`. A label photo enriches the **product**, not the item. The
  `nutrition_per_100g` panel is the full nine-field § Nutrition panel. It is
  a **product-nutrition** shape, distinct from the recipe-component per-100g
  reference (`RecipeComponentMacros` in `types.ts`), which stays on its own
  type — the two are not conflated.

  **Raw serving capture — capture as printed, scale late** (migration
  `009-kitchen-nutrition-panel.sql`): `serving_size_g` (numeric — grams per
  label serving, transcribed verbatim), `nutrition_per_serving` (JSONB, the
  label's per-serving panel exactly as printed; any field null = unreadable),
  `servings_per_container` (numeric — opportunistic package accounting only,
  **never** an input to count-vs-fraction), and `unit_model_hint`
  (`'counted' | 'fraction' | null` — the vision model's *packaging* judgment:
  individually-sealed atomic units each of which opens and starts its own
  clock → counted; a single container drawn down → fraction; a HINT the
  unit-model judgment leans on, never a hard-set quantity). The label prompt
  **never converts units**: per-100g is derived deterministically in code
  (`per_serving ÷ serving_size_g × 100`, `derivePer100gFromServing`), keeping
  the model's own transcribed per-100g column only as a fallback for labels
  printed per-100g. LLM serving arithmetic is the classic extraction error;
  the raw capture makes the conversion auditable and re-derivable. The
  ingredients read is deliberately greedy: whatever ingredient information is
  legible lands — a verbatim panel, a partial list, front-of-pack callouts —
  null only when there is genuinely nothing.

  **Per-unit edible grams and panel provenance.** `unit_edible_g` (numeric,
  nullable) is the **edible mass of ONE physical unit** of a counted product —
  one egg, one can, one link. It is **stated, never derived**, because both
  available derivations are wrong in opposite directions and neither error is
  detectable at read time. `serving_size_g` is the *label's* serving, which
  coincides with one unit only by luck: a large-egg carton declares a 50 g serving
  that happens to be one edible egg, while a 3-can multipack can declare an 85 g
  serving against a ~142 g can — deriving from the serving would log 60% of a can.
  Going the other way, `net_content_g ÷ units_total` includes inedible mass:
  shell for eggs, packing water for cans. The two existing fields answer *how much
  is a serving* and *how much is in the package*; neither answers *how much food is
  one unit*, which is why it gets its own column. Null is honest and simply makes
  the product ineligible for one-tap consume (§ Consume from inventory).

  `nutrition_source` (`'label' | 'reference' | 'estimate'`, nullable) records where
  the panel came from: a scanned label is authoritative for that SKU; a reference
  table is correct for the food but generic for the SKU (the only option for
  unpackaged produce, which carries no label); an estimate is a guess. Without the
  marker a reference-seeded row is indistinguishable from a scanned package, there
  is no safe upgrade rule, and the `needs_nutrition` sweep cannot tell *no data*
  from *generic data*.

  **Supersession guards the automated door, not the owner.** A name-key enrich
  (a receipt re-seed, the label composer's already-linked-item path, a merge
  fold) never lets `nutrition_source` downgrade *away* from `'label'` — those
  writes carry no evidence against a scanned panel's authority, exactly the
  same non-argument an enrich carries against `nutrition_negligible`
  (§ Nutritionally negligible products). An explicit-ulid **replace** or a
  **`PATCH`** is a different act: the owner (or an agent acting on an explicit
  instruction) stating a fact about this product, including a correction
  *away* from `'label'` — a scan that was wrong, a mislabeled SKU, a merge that
  needs undoing by hand. That write applies as stated. Unlike
  `nutrition_negligible`, there is no tracked-ceiling safety hazard on the
  other side of `nutrition_source` to guard against: it is metadata about
  confidence, not a number the daily view treats as a limit, so a stated
  correction needs no guard and no override flag — it simply lands. A silent
  refusal here would be strictly worse than either direction of being wrong:
  the caller believes they corrected the record and did not, which is the
  looks-right-never-questioned failure this whole area of the module exists to
  close.

  Provenance is orthogonal to basis (§ A panel means nothing without its
  basis): a label panel is normally per-serving and a reference panel
  per-100 g, but neither implies the other.

  **Net content (§ Prices' divisor).** The label scan also transcribes the
  package's printed net content as a raw `{value, unit}` pair (e.g. `454 g`,
  `64 fl oz`); **deterministic code** converts to `net_content_g` /
  `net_content_ml` (numeric, nullable — grams for weight-stated packages,
  ml for volume-stated; oz/lb/L conversions in code, never model
  arithmetic). This is the per-gram denominator for cost reads
  (`price_cents ÷ net_content_g`); `package_size` stays the verbatim
  display string it always was. `servings_per_container × serving_size_g`
  remains a directional fallback when no net content was legible.

  **Correction & retirement** (migration `017-kitchen-product-corrections.sql`):
  `nutrition_negligible` (bool, not null, default false — the owner-set
  ~0-at-any-realistic-serving-including-sodium assertion, guarded against salt
  per § Sodium is the exception that breaks the marker), `archived_at`
  (timestamptz, null = live) and `merged_into` (ULID, nullable — set when the row
  was retired *into* a survivor). See § Product corrections for the upsert /
  patch / merge / archive semantics these carry.

  **The needs-nutrition signal**: an inventory item whose *linked product*
  carries no `nutrition_per_100g`, or a panel with any of the nine fields
  null, is flagged `needs_nutrition: true` on every item view (`GET
  /inventory`, CLI list, the app) — a label rescan is the resolving action.
  Distinct from `needs_info` (a scanned line with NO product match); an
  unlinked item is never double-badged. This is the loop that keeps
  recipe/consume macros from going null in the first place. A product marked
  `nutrition_negligible` is **exempt**: the flag stays false however incomplete
  its panel is, because for that category no rescan can ever clear it
  (§ Nutritionally negligible products).

  **Absent line = 0 (so the flag is clearable).** A legible panel that
  simply does not print a nutrient line means ZERO of it, not unknown — US
  labels omit nutrients present in insignificant amounts, and Supplement
  Facts panels routinely omit protein/fat/sugars entirely. The label prompt
  transcribes an omitted line as `0`; `null` is reserved for genuinely
  unreadable/cut-off values or no visible panel. Without this rule a
  supplement can never scan its way out of `needs_nutrition` (the
  2026-07-23 psyllium case). Dual-column panels (two serving sizes) read
  the first/primary column consistently.
- **`kitchen.receipt_lexicon`** — one row per `(store, line_text)`: `ulid`,
  `store`, `line_text` (exact receipt line text, normalized to upper/trim),
  `product_ulid` (**nullable** — null on a non-inventory marker, see below),
  `package_size` (nullable), `shelf_life_class` (nullable override),
  `non_inventory` (bool, default false), `created_at`, `updated_at`.
  `UNIQUE(store, line_text)`. Grows monotonically; once mapped, every future
  receipt carrying the line resolves automatically. A row with
  `non_inventory = true` (and null `product_ulid`) is a **skip marker**: the
  line is a known non-grocery line (housewares etc.) that future receipt parses
  skip rather than stock (see § Non-inventory dismissal). The upsert on
  `(store, line_text)` means a later label scan can overwrite a skip marker with
  a real product mapping, or a dismissal can overwrite a stale product mapping
  with a skip marker — last write wins, monotonic in intent.
  **Seeding a product mapping retro-resolves pending questions**: any
  upsert that carries a non-null `product_ulid` (the label-resolve write, the
  agentic seed path `POST /lexicon`, or any future caller of
  `store.upsertLexicon`) also resolves every `needs_info` item still on hand
  (`stocked`/`open`) sharing the same `(store, normalized line_text)` — attach
  `product_ulid`, clear `needs_info`, re-derive `eat_by` from each item's own
  `acquired_at`/`opened_at` — the identical resolution the label-scan fan-out
  applies to same-batch siblings (§ POST /inventory/:ulid/label), just
  triggered from the lexicon side instead of a scanned item. A skip-marker
  upsert (`product_ulid` null) never triggers this — there is no product to
  attach. Already-resolved, dismissed, or terminal items are untouched (the
  match is scoped to open `needs_info` items only), so the questions queue
  holds only genuinely-unanswered identities, never ones a later mapping
  already answered.

### Receipt-line matching: normalize the key, learn from every resolution

Matching a receipt line is an exact lookup on `(store, line_text)`. Two defects
make that miss lines the system has **already resolved**, and both are silent.

**1. `line_text` is normalized; `store` is not.** The lexicon key uses the store
string verbatim as written by whichever path created the row, while a receipt
carries the store as printed. One retailer routinely appears in three forms —
the receipt header, the shorter name an operator types, and a title-cased
variant — so a mapping written from an item can key on a string no receipt will
ever produce. Observed live: a store with mappings split across two spellings,
including one line duplicated under both because the first entry could never
match.

**Store identity is RESOLVED BY MODEL against the known roster, not computed
from the string.** String normalization cannot do this job and the obvious
fallback is actively dangerous. Case-folding reconciles `SPROUTS FARMERS MARKET`
with `Sprouts Farmers Market`, but not with the bare `Sprouts` an operator
types — different token sets. Reaching for substring or token overlap to close
that gap merges a standalone `Farmers market` into `Sprouts Farmers Market`,
which are unrelated stores, and a small-format `<Chain> <Format> Market` into its
full-size `<Chain>` sibling, which stock different products at different prices.

Receipts are already parsed by a model, so store resolution rides the same
capability: **given the receipt's store text, the optional operator-supplied
store name, and the FULL ROSTER of known stores, the model returns either a match
to an existing store or a normalized name for a new one.** A model distinguishes
"the same retailer written shorter" from "a different retailer sharing a word";
a normalizer cannot.

**The resolution is then LEARNED, so the model is consulted once per novel
string.** A raw store string maps to a resolved store exactly as a receipt line
maps to a product, for the same reason: an unrecorded resolution is re-derived
forever, and re-deriving with a model is both slower and non-deterministic. Every
later receipt carrying that string resolves from the stored mapping without a
model call.

**A wrong store resolution is recoverable and must be correctable**, unlike a
wrong product mapping which corrupts panels and stock. The failure mode is a
fragmented lexicon — mappings stranded under a store nothing matches — which is
visible as unmatched lines rather than as silently wrong numbers. That asymmetry
is why store resolution may lean on a model where product identity still refuses
to guess.

**2. Only the label-scan path teaches the lexicon.** `writeLexiconLine` runs
from a label resolve, and the non-inventory dismissal writes a skip marker.
**Attaching a product any other way — notably `recount --product-ulid`, which is
how an agent resolves an unmatched line — writes nothing.** So a line resolved by
hand stays unmatched on every future receipt, forever. Observed live: an
identical line from the same store, resolved to the same product two weeks
earlier, came back `unmatched`.

**Every path that attaches a product to an item with a `store` and a `raw_label`
therefore upserts the mapping.** The lexicon becomes derived from use rather than
hand-curated, and curation (`POST /lexicon`) becomes a correction surface rather
than the primary one.

**Learning must stay correctable, because it can cement a mistake.** A wrong
resolution teaches a wrong mapping and every later receipt inherits it. The
existing `UNIQUE(store, line_text)` upsert is what makes this safe — re-attaching
a different product overwrites the mapping, so fixing the item fixes the future.
An attachment that is later undone must clear or overwrite the line it taught.

### Near-miss candidates: rank, offer, never silently guess

An exact miss is not evidence the line is unknown — it may be a re-worded line,
a new size, or a sibling SKU. When exact lookup fails, the module ranks candidate
products and returns them **with their scores** rather than choosing.

Three independent signals, none sufficient alone:

- **Line-text similarity** against known lines for that canonical store.
- **Product name / alias similarity** against the catalog.
- **Price proximity** to that product's own price history *at that store*
  (`products prices`, compared on normalized unit price).

**Price corroborates; it never decides.** Prices move, sales exist, and two
unrelated items at the same price say nothing. It is a tie-breaker among
textually plausible candidates and must never promote a candidate the text does
not already support.

**Scores rank the picker. They never decide.** There is no confidence threshold
above which the module attaches a product on its own, because there is no score
at which a guess becomes a fact.

**The ONLY automatic product attachment is an exact lexicon hit — and that is not
a guess, it is replaying a decision a human already made.** Everything else lands
`needs_info` with its ranked candidates exposed, and identity is settled in the
app: a ranked list plus an explicit *none of these — scan it* option.

This is deliberately stricter than store resolution, which does lean on a model
(§ above). The asymmetry is blast radius. A wrong store fragments the lexicon and
shows up as unmatched lines — annoying, visible, recoverable. A wrong product
silently corrupts a nutrition panel, a price series, and — since an eaten sheet
decrements what it names — physical stock counts. Nothing about a plausible
ranking distinguishes those two outcomes, so the ranking is not allowed to cause
the second one.

It also disposes of a problem the threshold design carried: a confidence bar
cannot be tuned without data, and every value chosen before that data exists is
a guess about how often to guess.

**The candidates are a read, not a state.** They are computed on demand from the
line and the catalog, never stored — a stored candidate list would go stale the
moment a product or price changed, and would be indistinguishable from a decision
once written down.

- **`kitchen.inventory_items`** — one physical unit: `ulid`, `product_ulid`
  (nullable — null while `needs_info`), `raw_label` (text — the receipt line or
  display name when no product; nullable), `store` (nullable), `batch_ulid`
  (nullable), `state` (enum `stocked | open | finished | tossed | dismissed`),
  `on_hand_fraction` (numeric 0..1, directional; default 1.0), `units_total` /
  `units_remaining` (integer, both nullable, migration
  `007-kitchen-inventory-units-and-derivations.sql` — the **unit count
  model**, see § count-vs-fraction below; both null (the default) means the
  item is fraction-modeled, unchanged; both set together, never one without the
  other, `0 <= units_remaining <= units_total`), `unit_seal`
  (`'individual' | 'shared'`, nullable — migration
  `020-kitchen-storage-moves-and-unit-seal.sql`; **what the package seals**:
  each unit separately, or one container over all of them. Null on a
  fraction-modeled item (the notion doesn't apply) and read as `individual` on
  a counted one, so existing rows keep their original behavior — see
  § count-vs-fraction), `needs_info`
  (bool), `acquired_at` (date), `opened_at` (date, nullable), `closed_at` (date,
  nullable — finished/tossed/dismissed date), `storage_moved_at` (date, nullable
  — migration `020-kitchen-storage-moves-and-unit-seal.sql`; the date of the most
  recent recorded storage move, and from then on the item's clock anchor —
  § Storage moves), `eat_by` (date, nullable — **derived**,
  materialized for ordering; recomputed on open, on a storage move, and on
  reconcile), `shelf_life_class` (enum
  snapshot, nullable), `notes` (nullable), `merged_into` (ULID, nullable —
  migration `018-kitchen-item-merge.sql`; set when the row was retired *into* a
  surviving item, see § Item corrections), `created_at`, `updated_at`.
- **`kitchen.inventory_derivations`** — one row per derived (prepared) item,
  written by a `convert` event (migration
  `007-kitchen-inventory-units-and-derivations.sql`, see § Conversions):
  `ulid`, `derived_item_ulid` (unique FK into `inventory_items` — 1:1, a
  derived item is always freshly created by exactly one conversion), `sources`
  (JSONB array `[{item_ulid, amount, amount_kind: 'fraction'|'count'}]` — the
  source item(s) consumed and how much of each, in each source's OWN unit),
  `recipe_ulid` (nullable — the recipe/conversion that fixes the derived
  item's macros, when applicable), `created_at`. Deliberately minimal — enough
  for eat-first reasoning and later macro inheritance, not a full lineage
  graph (no chained derivation queries, no cascade beyond the one hop).
- **`kitchen.purchase_batches`** — one shopping event: `ulid` (client-supplied
  for receipt idempotency), `source` (enum `receipt | manual`), `store`
  (nullable), `store_undetermined` (bool, default false — set true when the
  parse completed but neither the scan meta nor the header extraction yielded a
  store, so the null is a recorded gap, not a silent one), `purchased_at`
  (date), `status` (enum `parsing | parsed | failed` — the parse work queue,
  mirrors entry estimation), `parse_attempts`, `last_error`, `last_error_at`,
  `total_cents` (int, nullable — the receipt's printed grand total, transcribed
  as printed; see § Prices), `created_at`, `updated_at`.
- **`kitchen.purchase_batch_lines`** — one parsed receipt line: `ulid`,
  `batch_ulid`, `raw_text`, `quantity` (int, default 1 — the physical-unit
  count the line represents; a multi-quantity/multibuy line records N here and
  fans out to N items), `price_cents` (int, nullable — the line's printed
  extended price; see § Prices), `match_outcome` (enum `matched | unmatched |
  pending | skipped`), `product_ulid` (nullable), `inventory_item_ulid`
  (nullable — the representative item for the line; the earliest of the N
  fanned-out units), `created_at`. `skipped` records a line the parse either
  honored a non-inventory lexicon marker for OR the model judged clearly
  non-food — no inventory item is created, but the line is retained (never
  silently dropped) so the batch stays a faithful record of the receipt.

  **Prices (capture as printed, never computed).** The receipt parser already
  reads every line's price to disambiguate quantities; prices are first-class
  capture, not discard: each line's **printed extended price** (what was paid
  for that line's units, in integer cents; the number physically printed on
  the line) lands as `price_cents`, and the receipt's **printed grand total**
  as `total_cents` — both transcribed verbatim, null when unreadable, never
  invented or arithmetically derived by the model (the serving-size rule
  again). Per-unit price for a multi-quantity line is a *read-time* division,
  never stored. Tax, deposits, and discount adjustment lines are out of
  scope: they ride only insofar as the printed line/total numbers already
  reflect them — the module does no allocation. Lines-sum vs `total_cents`
  disagreement is informational (tax/discounts make exact agreement rare) —
  never a parse failure. **Boundary:** kitchen records the printed facts;
  spend analysis, budgets, and period rollups are consumers (the
  personal-finance domain / agent judgment) — the module keeps no derived
  price tables. Because a product link exists per line via the lexicon,
  per-product per-store price history is derivable at read time for free, and
  the module answers that derivation itself (§ Price history) — still with no
  stored prices beyond the transcribed line.

  **The total as a self-check (re-read, never reconcile).** The parse prompt
  instructs the model to use the printed grand total as a soft checksum on
  its own line extraction: after reading the lines, if their price sum is
  materially off from the total (beyond a tax/deposit-sized margin), that is
  a signal to RE-EXAMINE the photos — specifically for the multibuy failure
  modes (emitting both a `N @ price` marker and its item line, capturing a
  unit price where the extended price was printed, a missed or duplicated
  line). The check may only ever trigger a re-read; the model must NEVER
  adjust any number to force agreement — transcribe-as-printed always wins,
  and a residual mismatch is simply reported (both numbers land; the
  disagreement stays informational).

  **By-weight lines (produce, bulk).** A weighed line prints its measure and
  unit price ("1.42 lb @ 0.79/lb") alongside the extended price; only
  `price_cents` (the extended price) is captured structurally — `raw_text`
  retains the printed measure verbatim, and per-gram cost for weighed goods
  is a read-time parse of `raw_text` (blessed; structured measure capture is
  a follow-up only if that parse proves too flaky across stores).
- **`kitchen.entries.inventory_item_ulid`** — added column (nullable, no FK):
  the item a consumption entry depleted (phase-1 "optional inventory-item
  link").

**Shelf-life classes** (enum `kitchen.shelf_life_class`; code owns the
default day windows in `src/inventory-derive.ts`, `(unopened, opened)`):
`pantry` (365, 180), `frozen` (180, 90), `fridge_long` (60, 21), `fridge_short`
(14, 7), `produce` (7, 4), `very_perishable` (3, 2), `prepared` (4, 4),
`unknown` (null, null — no eat-by until known). `eat_by` = **anchor + window**,
where the window is the `opened` one when the item is opened and the `unopened`
one otherwise, and the anchor is the **latest** of the dates that legitimately
start that window: `opened_at` when opened (else `acquired_at`), and
`storage_moved_at` when a storage move has been recorded (§ Storage moves).
Product-level day overrides win over the class default; `unknown` (and any null
window) yields `eat_by = null`.

**A clock is derived whenever the class is known — `needs_info` is orthogonal.**
`needs_info` means "nobody has established WHAT this is"; the shelf-life class
means "this is how fast it goes bad". They are unrelated facts, and an
unidentified fresh item is precisely the one most worth a clock: an unknown
perishable is a *higher* risk than a known one, not a lower one. So an item
created (or corrected) with a class derives its `eat_by` from that class whether
or not `needs_info` is set, and it enters eat-first ordering like anything else.
A genuinely unknown class already yields a null window, which is the honest way
to have no clock — the flag never needs to do that job a second time.

`prepared` is the class for a **cooked or assembled dish** — an overnight-oats
jar, hard-boiled eggs, cooked grains, a batch of soup — the output of a
`convert` (§ Conversions), not a purchased good. It carries two distinctions
from the grocery classes:

- **It ages from the make date, and opening does not reset the clock.** A
  homemade jar is good ~4 days *from when it was made* whether or not you've
  started it — you don't get a fresh window by cracking it open. So a `prepared`
  item's `eat_by` anchors to `acquired_at + window` regardless of `opened_at`
  (its `unopened`/`opened` windows are equal for exactly this reason), unlike a
  grocery item where opening breaks a seal and starts a shorter clock.
- **It is the default class a `convert` assigns its derived item** when the
  caller names none (see § Conversions) — so a prepared dish always earns an
  honest eat-by and joins eat-first ordering, instead of falling to `unknown`
  (no eat-by, invisible to the planner). ~4 days is a directional central
  estimate; a caller that knows better overrides it to another **made-food
  class** — `produce` for hard-boiled eggs (which keep ~a week) or
  `very_perishable` for cut fruit.

**A `convert` derived item accepts only made-food shelf-life classes.** The valid
set on `POST /inventory/convert`'s `shelf_life_class` is **`prepared` (default),
`produce`, `very_perishable`, and `frozen`** (a batch you freeze). The
**package-durable classes — `pantry`, `fridge_long`, `fridge_short` — are
rejected** with a `400` that names the valid set and points at `prepared`.
Rationale: those classes' clocks anchor to an **unopened** window (a
still-sealed store package: `pantry` 365 d, `fridge_short` 14 d), and a derived
item is `stocked`/unopened by construction — so saddling a homemade jar with one
produces an absurd "lasts 14 days unopened" eat-by. A self-made item has no
sealed-package phase; the guard makes that category error impossible rather than
trusting every caller to know it (AXI: make the mistake hard, not documented). A
caller that genuinely wants a longer honest clock uses the product-level day
overrides, not a grocery class.

**Inventory state machine** (`src/inventory-state.ts`):
`stocked --opened--> open`, `{stocked,open} --finished--> finished`,
`{stocked,open} --tossed--> tossed`, `{stocked,open} --dismissed--> dismissed`,
plus the **state-preserving** `{stocked,open} --moved--> {stocked,open}`
(§ Storage moves — a storage move changes an item's clock, never its open
state). `finished`/`tossed`/`dismissed` are terminal. Opening
stamps `opened_at` and re-derives `eat_by` — always from the **effective**
opened date (the original `opened_at` when one exists: a re-open is an
idempotent no-op and must not extend the window) and always folding in the
linked product's precise day-window overrides (every clock re-derivation —
open, storage move, finished-unit revert, reconcile — goes through one helper so
overrides are never silently dropped). Finishing stamps `closed_at` and
sets `on_hand_fraction` to 0. `finished-unit` (counted items only — see
§ count-vs-fraction below) shares `finished`'s legal preconditions
(`{stocked,open}`, terminal-rejecting), but its CONCRETE next state is
data-dependent (zero remaining → terminal `finished`; otherwise it depends on
the item's `unit_seal` — see § count-vs-fraction) — computed by the pipeline,
not the pure transition table.

`dismissed` is the "this line does not belong in inventory at all" terminal
state (see § Non-inventory dismissal). It is deliberately **not** a food-waste
outcome: unlike `tossed`, dismissing stamps `closed_at` but appends **no**
`tossed …` note and leaves `on_hand_fraction` untouched, so a dismissed soup mug
never enters waste/tossed telemetry. It is reached by its own verb
(`POST /inventory/:ulid/dismiss`), never through the event endpoint — the two
carry different bodies and different response shapes — and it is the terminal an
item **merge** retires its loser into (§ Item corrections). A new terminal state
(rather than a `DELETE`) is chosen because it mirrors the existing
`finished`/`tossed` terminal idiom exactly — the row is retained for provenance
(its batch line still points
at it, a receipt replay stays idempotent), it drops out of the default on-hand
list and the questions queue by the same state-filter mechanics the other
terminals use, and it needs no orphan-cleanup of the referencing batch line.

Tossing takes an optional **amount tossed**
(fraction 0..1): a partial toss decrements `on_hand_fraction` and keeps the
item's state alive (directional — it self-heals at the next event); the item
only transitions to terminal `tossed` (with `closed_at`, fraction 0) when no
fraction is supplied (full toss) or the remainder reaches zero. Every toss
appends `tossed <amount> <date>` to the item's `notes` so waste amounts stay
recoverable for telemetry — and on a **counted** item the sealed units
discarded ride the same line, `tossed <amount> (<n>u) <date>`, because
`on_hand_fraction` does not track a counted item's unit count and the fraction
alone would charge a nearly-empty pack as a whole one (§ Waste costing).
These semantics are shared verbatim by the explicit
event endpoint and the free-text resolver. A full toss or whole-item `finished`
on a counted item also zeroes `units_remaining` — the sealed remainder is gone
too.

### Storage moves — the clock re-anchors from the move

A shelf-life class is a claim about **where an item lives**, and food moves. The
derivation above assumes it never does: an item acquired frozen and later thawed
would resume a fridge clock as though it had never been frozen, and one recorded
as a fridge item that was actually in the freezer ages on paper while sitting
safe. The two errors mislead in opposite directions, and one of them is
dangerous:

- **Recorded as a fridge class, actually frozen** — over-reports urgency. It nags
  from eat-first while months of real life remain, and past the window it reads
  expired. Annoying, and it trains the reader to distrust the whole list.
- **Recorded as frozen, actually thawed days ago** — under-reports urgency, and
  this is the dangerous one. A thawed protein reads as indefinitely safe while
  running a ~1-week fuse. The ledger's whole job is to *not* say that.

So a **storage move** is a first-class event: `moved`, carrying the class the
item moved **into**. It:

- sets `shelf_life_class` to the destination class,
- stamps `storage_moved_at` with the move's date,
- **re-anchors `eat_by` from the move date**, never resuming the prior clock, by
  becoming the derivation's anchor (§ Shelf-life classes: the anchor is the
  latest of `opened_at`/`acquired_at` and `storage_moved_at`, and the window is
  still the opened one iff the item is open — so a sealed pack thawed today gets
  the destination class's *unopened* window from today, and an already-opened tub
  moved to the freezer gets `frozen`'s *opened* window from today),
- leaves the item's **state and `opened_at` untouched** — moving a sealed pack
  between appliances does not open it, and moving an open one does not re-seal it,
- and appends a `moved <from>→<to> <date>` line to `notes`, so the transition
  survives in provenance the way `tossed …` and `reconciled …` do.

Freezer→fridge (starting a clock) is the motivating direction; fridge→freezer
(pausing one) is the same mechanism inverted and works identically — the window
changes with the class and the anchor becomes the move, which is exactly "the
clock you were on is void; here is the new one."

**A move is legal from `stocked` or `open` and rejected on a terminal item**
(`409`), like every other event. Repeated moves simply re-anchor again; only the
most recent `storage_moved_at` is retained, because only the current storage
governs the current clock (the full history lives in `notes`).

**A move into the class the item already carries is legal and still re-anchors.**
That is not a no-op — it is the case where the ledger's class was right and its
*basis* was wrong ("it has been in the fridge all along" is a `recount`; "it
entered the fridge today" is a move). Only `unknown` is refused as a
destination: a move states where the item now lives, and `unknown` is not a
place. An item whose class genuinely isn't known reaches that through
§ Reconcile.

**The reported date is the date of the act, not of the intention.** A caller
supplying `at` is stating when the item physically changed storage, and the
module takes it at face value — a thaw described as "yesterday" anchors to
yesterday even if the decision to thaw was made two days ago. This distinction is
not pedantic: intention and act routinely land on different days (a pack pulled
out a day later than planned), and anchoring to the intention silently shortens
or lengthens a real safety window. Omitted `at` means today, which is the
overwhelmingly common case — the move is usually being logged as it happens.

**A frozen item still carries an `eat_by`, and is not suppressed from eat-first.**
Considered and rejected: `frozen`'s 180-day unopened window is a real quality
boundary (freezer burn, not spoilage), and eat-first orders by `eat_by` ascending
**nulls last** — so a frozen item already sorts below everything perishable
without any special case, while keeping the honest "this has been in there eight
months" signal that a null would throw away. Nulling it would also make the
dangerous direction worse, not better: an item that *is* frozen would be
indistinguishable from one whose class was never established. What makes the
frozen state safe is that leaving it is cheap to record, which is what `moved`
is for.

### Unit counts (§ count-vs-fraction)

A package of discrete units (a can 3-pack, an egg dozen, a yogurt 4-pack, a
4-link sausage pack, a sliced loaf) tracks `units_total`/`units_remaining`
instead of `on_hand_fraction`, as **one row** — no fan-out
per unit (that fan-out mechanism is a different axis: N *bought* units
of a product each already become their own item row per the receipt line's
`quantity`; any one of those rows may itself be a multipack with its own
`units_total`).

**`on_hand_fraction` is DERIVED for a counted item, never stored independently.**
On every read it is `units_remaining ÷ units_total`. The count is the single
source of truth for how much is left; carrying an unrelated stored fraction
alongside it gave two answers to one question, and the stale one won on the wire
— a pack with 1 of 4 links left reported `on_hand_fraction: 1.0`. Two
consequences: any consumer that only understands fractions (a progress bar, the
briefing's eat-first read) gets an honest number for free, and the terminal
zeroing stays consistent by construction (zero units ⇒ `0.0`). Reconcile
therefore refuses `on_hand_fraction` on a counted item and directs the caller to
`units_remaining` — not as a quirk, but because the fraction is not a stored fact
there to correct.

#### Two kinds of counted package — `unit_seal`

A count alone doesn't say what happens when you open the package, and there are
two genuinely different answers. `unit_seal` records which:

- **`unit_seal: 'individual'`** — each unit carries its own seal (a can 3-pack,
  yogurt cups in a sleeve, individually-wrapped bars). Opening the item means
  "I broke *one* unit's seal": only that unit runs the perishable clock, and the
  still-sealed remainder is shelf-stable at the unopened window regardless.
- **`unit_seal: 'shared'`** — one seal encloses all the units, so the package is a
  **container that gets opened** and *also* holds discrete units consumed one at a
  time (a 4-link vacuum pack, a sliced loaf, an egg carton, a tray of prepped
  portions). Opening it puts the **whole remainder** on the opened clock at once.
  Finishing a unit does not re-seal anything.

Null is read as `individual` — the unmarked default and the behavior the count
model shipped with. `unit_seal` is only meaningful on a counted item; it is null
on a fraction-modeled one, where the notion doesn't apply.

Before this distinction existed, opening such a package forced a false choice:
keep counting units and lose the opened clock, or switch to a fraction and lose
the count. Both discard something true. The container and its contents are two
facts, and an opened container with N units remaining on the opened clock is the
state that expresses them together.

The counted sibling of `finished` is the **`finished-unit`** event (`POST
/inventory/:ulid/events` with `type: 'finished-unit'`, no `fraction`) — an
integer decrement of `units_remaining` by exactly one:

- **Counted items only.** A `finished-unit` event against a fraction-modeled
  item (`units_total` null) is rejected (`400`, `NotCountedItemError`) — use
  `finished`/`tossed` there.
- **Reaching zero remaining** transitions the item to terminal `finished`
  (`closed_at` stamped, `on_hand_fraction` therefore `0`) — identical outcome to
  a whole-item `finished`, on either seal.
- **Otherwise, on an `individual` seal**, the item reverts to `stocked`,
  `opened_at` clears, and `eat_by` re-derives from the **unopened** window — the
  unit that was just finished carried the opened clock, but the next-to-open unit
  was never itself opened, so it starts its own (unopened) clock, not a
  continuation of the just-finished unit's.
- **Otherwise, on a `shared` seal**, the item **stays `open`**, keeps its
  `opened_at`, and keeps the opened-window `eat_by`. There is no fresh clock to
  start: the container is open, and every remaining unit has been exposed since it
  was opened. Only the count moves.
- **A `finished-unit` on a still-`stocked` `shared`-seal item implies the open.**
  You cannot eat one link out of a sealed pack, so the event stamps `opened_at`
  (at the event's date) and derives the opened-window clock, exactly as an
  explicit `opened` would have. Inferring a clock from an event is what events are
  for — the alternative leaves the item reading sealed-window-safe while it is
  physically open, which is the under-reporting direction the module refuses.

Depletion follows the same split: `POST /inventory/:ulid/consume`'s counted branch
(an N-unit decrement) reverts an `individual`-seal item to a fresh `stocked`
clock and leaves a `shared`-seal one `open` on its container clock.

Receipt-scan seeding: when a lexicon line's (or its mapped product's)
`package_size` carries a discernible count ("3 ct", "12-pack", "6 pk", "dozen"
→ 12, "half dozen" → 6; a plain size like "16 oz" carries none), each
fanned-out item from that line is seeded `units_total = units_remaining =` the
parsed count instead of the default fraction of 1. A count of 1 ("1 ct")
describes a single unit, not a multipack, and is left fraction-modeled. Receipt
text cannot tell the two seals apart ("4 CT" fits a can pack and a sausage pack
equally), so seeding leaves `unit_seal` null (`individual`) and the seal is
stated by whoever knows the package — at create, at reconcile, or on a `convert`
derived item.

### Stated-weight consumption — eating is not a correction

When a **known weight** of an open divisible item is eaten — a measured pour off a
tub, a weighed portion off a cooked batch — that is a **consumption**: it decrements
`on_hand_fraction` by the stated amount and links the depletion to the journal entry
that consumed it.

It must **not** be recorded as a reconcile. § Reconcile below is an *observation*
asserting the ledger was wrong; it carries no consumption claim by design. Recording
eating through it is a category error with two costs that compound quietly: the
item's history reads as a run of measurement errors instead of a meal log, and waste
telemetry (§ Waste costing) cannot separate food that was eaten from a fraction
adjusted away. Both surfaces then under-report reality in the direction nobody
audits.

The gap this closes is structural rather than hypothetical: one-tap consume
(§ Consume from inventory) requires a *known* portion, which a divisible container
does not have, so a stated weight had no honest verb at all and callers reached for
reconcile because it was the only thing that moved the number.

- **Amount** is grams where a total-mass basis exists (`net_content_g`), or a
  fraction directly where it does not. **Never invent the denominator** — a guessed
  basis silently mis-scales every subsequent decrement on that item, and unlike a
  one-off wrong number it compounds.
- **Reaching zero** goes terminal as `finished` (consumed), never `tossed`. Whether
  arithmetic alone should close an item is genuinely contested — a stated weight is
  an estimate of what left the container, so landing exactly on zero is coincidence
  — so closure fires only on an exact-or-over-zero result, and a positive remainder
  is left alone rather than rounded away.
- **Entry linkage** is optional but atomic when supplied: given the consuming
  entry's ULID, the depletion and the entry link commit together or neither does,
  the same hard requirement § Consume from inventory states.

### Reconcile — corrections are observations, not events

The ledger drifts from reality structurally: `on_hand_fraction` is directional
math over estimated per-use decrements, unit counts get seeded from
assumptions, and reality always wins. **Reconcile** is the first-class
correction affordance — a way to bring an item into line with what the owner
actually observes ("the carton is ¾ full", "this is really 2 of 3 cans",
"this was never opened") without routing through consumption-event semantics
or raw DB edits.

A reconcile is an **observation, not an event**. Its rules:

- **It never touches clocks.** "I looked and it's ¾ full" says nothing about
  *when* the item was opened, so `opened_at` changes only when explicitly
  supplied. Correcting the state to `stocked` clears `opened_at` (stocked
  *means* sealed); a corrected `open` state requires an `opened_at` (supplied,
  or already present). `acquired_at` is untouchable.
- **`eat_by` always re-derives from the corrected truth** — the resulting
  state/`opened_at`, with product-level day-window overrides folded in.
- **It can reclassify the unit model** (§ count-vs-fraction): supplying
  `units_total` (+ optional `units_remaining`, defaulting to the existing
  count or the new total) makes the item **counted**; `units_total: null`
  reverts it to the fraction model. `units_remaining` alone recounts an
  already-counted item. Zero quantities are rejected — "none left" is a
  `finished`/`tossed` *event*, not a correction. `unit_seal` states which kind of
  counted package it is, and is refused on a fraction-modeled item (there is no
  seal to describe).
- **It can resurrect a mis-closed item**: an explicit `state:
  'stocked'|'open'` on a terminal item reopens it and clears `closed_at`. A
  terminal item with no explicit state is rejected (the caller must own the
  resurrection).
- **It reaches every field a correction actually needs** — quantities and state
  are not the only things that come out wrong. `shelf_life_class`, `needs_info`,
  and `product_ulid` are all reconcilable, because each is a fact about the
  physical item that observation can settle, and a verb documented as reconciling
  the ledger to reality that cannot reach them is only half a verb. `eat_by`
  stays **derived and unwritable**: deriving it from the class is the feature, and
  a manual override would quietly make the class stop meaning anything.
  - **`shelf_life_class` is a class correction, NOT a storage move** — the
    distinction is the whole point of having both verbs. A recount says "this was
    always a fridge item; I recorded the wrong class," so it re-derives `eat_by`
    against the item's **existing** anchor and never invents a new one. A move
    (§ Storage moves) says "this entered the fridge on the 8th," which re-anchors.
    Using a recount for a move under-reports urgency by however long the item sat
    in its previous storage; using a move for a mis-class fabricates a transition
    that never happened. Neither is a workaround for the other.
  - **`needs_info`** is settable both ways: `true` re-queues an item as an open
    question, `false` clears it. `POST /inventory/:ulid/label` remains the *good*
    resolution path when a label exists, but it is a dead end when one doesn't —
    a US spice jar carries no Nutrition Facts panel at all (FDA exempts foods with
    insignificant amounts of every nutrient), so no rescan can ever clear the
    flag for it. An identity the owner simply *knows* needs a door that isn't a
    camera.
  - **`product_ulid`** relinks the item to a different product, or `null` unlinks
    it. Included after weighing the alternative: `POST /inventory/:ulid/merge`
    can also move a product link onto an item, but only when a *second item row*
    already carries the right one — with no such row, the only path was to mint a
    decoy item and merge it, which fabricates two records to fix one field.
    Relinking has no dependents to move (the item **is** the dependent), so
    nothing merge does is needed here. Setting it clears `needs_info` unless
    `needs_info` is explicitly supplied (the identity just got established), and
    adopts the product's `shelf_life_class` only when the item carries none of its
    own — an item's class is a snapshot and its own value always wins. The target
    must be a live product: an archived one is refused, naming its `merged_into`
    survivor when it has one, rather than silently linking to a retired identity.
- **Every reconcile appends an audit line** to the item's `notes`
  (`reconciled <date>: <changes>[ — <caller context>]`), mirroring the
  `tossed …` idiom, so corrections stay distinguishable from consumption in
  provenance and telemetry.
- **Never pre-log planned consumption.** The corrections that motivated this
  (a dozen eggs pre-decremented for a batch-day run that never happened) were
  inference ahead of evidence — events record what *happened*; reconcile
  records what *is*.

The free-text resolver participates: a remark that is a pure quantity
observation with a correction cue ("the soymilk is actually 75% full") parses
as a `recount` and routes here (fraction-modeled items only), never to the
event machine. Anything less confident stays unmatched, per the resolver's
conservative principle.

### API

All under `/api/kitchen`. Error envelope `{ error }`, same conventions as
phase 1. Photos are memory-only for the request, never persisted (phase-1 rule).

**Response wrapping is deliberate and contractual, per endpoint** (clients must
not assume one convention): single-resource creates/mutations return the
**bare** row (`POST /receipts` → `PurchaseBatch`; `POST /inventory`,
`PATCH /inventory/:ulid`, and
`POST /inventory/:ulid/events` → `InventoryItem`; `POST /products`,
`PATCH /products/:ulid`, and `DELETE /products/:ulid` → `Product`;
`POST /lexicon` → `LexiconLine`); list reads return a named plural + `count`
(`{ batches, count }`, `{ items, count }`, `{ questions, count }`,
`{ products, count }`, `{ lines, count }`); compound reads/results return named
objects (`GET /receipts/:ulid` → `{ batch, lines }`; label →
`{ item, product }`; free-text resolver → `{ matched, item?, event? }`;
`POST /inventory/convert` → `{ sources, derived, derivation }`;
`POST /inventory/:ulid/consume` → `{ entry, item, created }`;
`POST /inventory/:ulid/consumed` → `{ item, entry, linked }`). The
shape stated on each endpoint below is exact.

Receipts:

- `POST /receipts` — multipart. Meta part **`receipt`** (JSON, accepted as
  either a form field OR a file part, same tolerance as `/entries`):
  `{ ulid (ULID, required), store?, purchased_at? (ISO date) }`. Photo parts
  named **`photo`** or **`photos`** (0..N). Posts a `purchase_batches` row
  immediately (`status: 'parsing'`), idempotent on ULID, and returns the
  **bare** `PurchaseBatch` (`201` created / `200` replay). A detached parse pass
  runs the cheap receipt model (`KITCHEN_RECEIPT_MODEL`) over the photos →
  `{ store, total_cents, lines[] }`. Each `line` carries
  `{ text, quantity, price_cents, non_food }` (§ Prices — printed values
  transcribed verbatim, null when unreadable). The
  resolution of each line, in order:
  1. **Store.** See § Store extraction & precedence — the resolved store is
     written back onto the batch and stamped on every item + used as the lexicon
     key.
  2. **Non-inventory marker.** An exact-string `(store, line)` lexicon hit with
     `non_inventory = true` records the line `skipped`, creates **no** item (the
     parse honors the durable marker).
  3. **Product match.** A `(store, line)` lexicon hit with a `product_ulid`
     creates a `stocked` item stamped with `purchased_at` — this durable mapping
     wins even when the model judged the line `non_food` (owner intent beats the
     first-pass judgment).
  4. **Model non-food.** A `non_food` line with no lexicon hit records the line
     `skipped` and creates **no** item (see § Conservative non-food skip). This
     is a per-receipt judgment only — it never writes a lexicon marker.
  5. **Unknown.** Any other line creates a `needs_info` item (`product_ulid`
     null, `raw_label` = line text).

  A multi-quantity line (`quantity: N`) records `quantity = N` on the batch line
  and creates **one item per physical unit** (N separate open/use lifecycles) —
  matched → N stocked items, unknown → N `needs_info` items; the batch line's
  `inventory_item_ulid` points at the representative (earliest) unit. The dedupe
  is a read-side concern of the questions queue, never a collapse of the
  physical units. Batch → `parsed`.
- `GET /receipts?limit` → `{ batches: PurchaseBatch[], count }`.
- `GET /receipts/:ulid` → `{ batch: PurchaseBatch, lines: BatchLine[] }` (404 if absent).

Inventory reads:

- `GET /inventory?state&limit&include_closed` → `{ items: InventoryItem[], count }`.
  Default: on-hand (`stocked`+`open`) ordered by `eat_by` ascending, nulls last
  (eat-first urgency). `state` filters to one state; `include_closed=true`
  includes finished/tossed.
- `GET /inventory/waste?since&until&limit` → `{ waste: WasteRow[], count,
  totals: { rows, cost_cents, cost_unknown_rows } }` — every recorded toss with
  its cost attributed (§ Waste costing), newest toss first. `since`/`until` are
  ISO dates bounding the toss date. `totals.cost_cents` sums only the rows whose
  cost is known and `totals.cost_unknown_rows` counts the rest — a partial total
  that says how partial it is. Items in the `dismissed` state or carrying
  `merged_into` are excluded (their waste claim was retracted).
- `GET /inventory/:ulid` → bare `InventoryItem` (404 if absent).
- `GET /inventory/questions?limit` → `{ questions: Question[], count }` — open
  `needs_info` items rendered as one-time questions for the digest/chat,
  **deduplicated by `(store, normalized line_text)`**. A multi-quantity receipt
  line yields one item per physical unit but **one question**, carrying the
  `count` of items it covers and the `item_ulids` of all of them (so a label
  scan or dismissal can fan out across the group — see below). `limit` caps the
  number of returned questions (groups), not the underlying item count; `count`
  is `questions.length`. Items with a null `raw_label` are never grouped with
  each other (each is its own question). Ordering is earliest-acquired first,
  and each group's `item_ulid`/`acquired_at` is that of its earliest item.

Item mutation:

- `POST /inventory` — create an item directly (manual/verbal purchase, or the
  agentic seed port). JSON `{ ulid?, product_ulid?, raw_label?, store?,
  batch_ulid?, acquired_at? (ISO date), on_hand_fraction?, units_total?,
  unit_seal?, state?, needs_info?, shelf_life_class?, notes? }`. `units_total`
  makes it a **counted** item (`units_remaining` starts equal to it); omitted
  stays fraction-modeled — see § count-vs-fraction. `unit_seal`
  (`'individual'|'shared'`, default `individual`) states what the package seals
  and is refused without a `units_total`. A supplied `shelf_life_class` derives
  an `eat_by` whether or not `needs_info` is set (§ Shelf-life classes). ULID
  optional (server-generates when absent); idempotent when supplied. Returns the
  **bare** `InventoryItem` (`201`/`200`).
- `POST /inventory/:ulid/events` — explicit state change. JSON
  `{ type: 'opened'|'finished'|'finished-unit'|'tossed'|'moved', fraction? (0..1),
  to? (shelf-life class), at? (ISO date) }`.
  `fraction` semantics per type: `opened` — absolute remaining fraction
  (omitted = unchanged); `tossed` — **amount tossed** (partial toss decrements
  and stays alive; terminal only at zero remainder or when omitted, per the
  state-machine rules above); `finished` ignores it (always terminal + zeroed,
  and zeroes `units_remaining` too on a counted item); `finished-unit` ignores
  it (see § count-vs-fraction — integer one-unit decrement, counted items
  only, with a seal-dependent outcome). `to` applies to `moved` alone and is
  **required** there (§ Storage moves): it names the class the item moved into,
  the event re-anchors `eat_by` from `at`, and the item's state and `opened_at`
  are left untouched. Returns the **bare** updated `InventoryItem`. `404` unknown
  item; `409` `InvalidTransitionError` on a terminal item; `400`
  `NotCountedItemError` for `finished-unit` against a fraction-modeled item;
  `400` `ItemValidationError` for a `moved` with a missing or `unknown` `to`, or
  a `to` supplied with any other event type.
- `PATCH /inventory/:ulid` — **reconcile** (§ Reconcile — correction, not
  consumption). JSON, at least one of `{ on_hand_fraction (0..1, exclusive
  0), units_total (int ≥1 | null), units_remaining (int ≥1 | null), unit_seal
  ('individual'|'shared'), state
  ('stocked'|'open'), opened_at (ISO date | null), shelf_life_class,
  needs_info (bool), product_ulid (ULID | null), notes }`. Applies the
  § Reconcile rules: clocks never inferred, `eat_by` re-derived from
  corrected truth with product overrides, `units_total` reclassifies the
  unit model (null reverts to fraction), explicit `state` may resurrect a
  terminal item (`closed_at` clears), a `shelf_life_class` correction re-derives
  against the item's **existing** anchor rather than re-anchoring (re-anchoring is
  `moved`'s job — § Storage moves), a `product_ulid` clears `needs_info` unless
  `needs_info` is itself supplied, and an audit line is appended to
  `notes`. `eat_by` is deliberately **not** accepted — it is derived. Returns the
  **bare** updated `InventoryItem`. `404` unknown item;
  `400` `ReconcileValidationError` (contradictory or ineligible correction —
  e.g. `stocked` with an `opened_at`, zero quantities, a fraction or a
  `unit_seal` on a
  fraction-modeled item, an unknown or archived `product_ulid`) or
  `NotCountedItemError` (`units_remaining` on a
  fraction-modeled item).
- `POST /inventory/events` — **free-text event resolver**. JSON
  `{ remark (string, required), at? (ISO date) }`. Best-effort matches the
  remark against open/stocked items (string/alias, directional), infers the
  event type (opened/finished/tossed + fraction) — or a `recount` correction
  (§ Reconcile) when the remark is a pure quantity observation with a
  correction cue — from the remark, applies it, and returns
  `{ matched: boolean, item?: InventoryItem, event?: { type, fraction } }`.
  An unmatched remark is `{ matched: false }` — normal, not an error (`200`).
- `POST /inventory/:ulid/label` — multipart. Photo parts (`photo`/`photos`) +
  optional meta part **`label`** (JSON `{ name?, shelf_life_class?,
  package_size?, aliases?, ingredients? }`, field or file part). Runs the label
  model (`KITCHEN_ESTIMATION_MODEL`, the strong tier) over the photos and
  enriches/creates the product. **Legal on any non-terminal item** (`409
  InvalidTransitionError` on a `finished`/`tossed`/`dismissed` item); `404`
  unknown item; `503` no label model configured.

  **Multiple photos are complementary views of one product.** The client may
  send several shots in one scan — a front label (product identity), a
  nutrition-facts panel, an ingredients panel — and the parser treats them as
  one product seen from multiple angles: front for name/aliases/package size,
  panels for `nutrition_per_100g` and `ingredients`. A single shot works exactly
  as before.

  **Per-state behavior:**
  - **`needs_info` item** — the resolve path (unchanged): enrich/create the
    product, link it, clear `needs_info`, re-derive `eat_by`, run the label
    fan-out, and write the `receipt_lexicon` line so the same receipt text
    auto-resolves next time.
  - **already-linked item** (`product_ulid` set, not `needs_info`) — the enrich
    path: merge the parsed facts into the **linked** product under the
    precedence below (never null-clobbering) and update/write the
    `receipt_lexicon` line, but **leave the item untouched** (no state, product
    link, or `eat_by` change). This is how a later nutrition/ingredients scan
    banks the panel onto an already-stocked item. `resolved_count` is `1`.
  - **unlinked, not `needs_info`** (edge) — treated like the resolve path.

  **Label fan-out** (resolve path only): resolving one item also resolves
  **every other open `needs_info` item with the same `(store, normalized
  raw_label)`** — the same product link and `shelf_life_class`, but `eat_by`
  re-derived per each sibling's **own** `acquired_at`/`opened_at` (they are
  distinct physical units with distinct clocks). This clears the whole
  multi-quantity group in one scan; the lexicon write handles *future* receipts,
  the fan-out handles the *current* batch's siblings. Fan-out only applies when
  the scanned item carries both a `store` and a `raw_label` (the grouping key);
  otherwise only the scanned item resolves.

  **Enrichment precedence** (both paths, applied per product field): explicit
  `label` meta > model-parsed > keep existing. A null/absent incoming value
  never clobbers an existing non-null value. `nutrition_per_100g` merges
  **per-field**, not whole-object: a later scan that reads only `fiber_g` fills
  that field and leaves the previously-banked `calories`/`protein_g`/etc.
  intact. `ingredients` follows the same rule (a null parse keeps an existing
  list). `shelf_life_class` only overrides when the incoming class is not
  `unknown`; `aliases` union-merge.

  Returns `{ item: InventoryItem, product: Product, resolved_count }`, where
  `resolved_count` is the total number of items resolved (the scanned item plus
  its siblings on the resolve path, ≥ 1; `1` on the enrich path).
- `POST /inventory/:ulid/dismiss` — remove a line that does not belong in
  inventory (housewares and other non-grocery lines on a grocery receipt). JSON
  `{ non_inventory? (bool, default false), at? (ISO date) }`. Transitions the
  item to the terminal `dismissed` state (stamps `closed_at`; leaves
  `on_hand_fraction` and appends no waste note, so it never enters tossed/waste
  telemetry — § Non-inventory dismissal). `409 InvalidTransitionError` on an
  already-terminal item; `404` unknown item. When `non_inventory` is **true**:
  (a) the same fan-out as the label path dismisses **every other open
  `needs_info` sibling** with the same `(store, normalized raw_label)`, and
  (b) a `receipt_lexicon` skip marker (`non_inventory = true`, null
  `product_ulid`) is upserted for `(store, normalized raw_label)` so future
  receipts skip the line. When `non_inventory` is **false** (or the item lacks a
  `store`/`raw_label`), only the single scanned item is dismissed — siblings and
  future receipts are unaffected. Returns
  `{ item: InventoryItem, dismissed_count, non_inventory }`, where
  `dismissed_count` is the total items dismissed (≥ 1).

  Dismissal is also the retirement path for a **phantom** item — a record that
  was never real stock (§ Item corrections). Nothing about the endpoint is
  receipt-specific: `non_inventory` is what makes a dismissal durable for a
  recurring *receipt line*, and it is simply omitted when retiring a one-off
  record.
- `POST /inventory/:ulid/merge` — fold a duplicate item into a survivor
  (§ Item corrections). JSON `{ into (ULID, required) }`, where `:ulid` is the
  loser. Fills only the survivor's **null** identity fields from the loser
  (`product_ulid`, `store`, `raw_label`, `batch_ulid`, `shelf_life_class`),
  re-deriving `eat_by` off the survivor's own clock when the fill resolved a
  `needs_info` survivor; **never** sums quantities; relinks every dependent; then
  retires the loser as `dismissed` with `merged_into` set. Returns
  `{ item: InventoryItem, merged: InventoryItem, relinked: { entries,
  batch_lines, derivations, derivation_sources } }`. `400` self-merge; `404`
  either ULID unknown; `409` a survivor that was itself merged away, or a loser
  already merged elsewhere. Idempotent on a replay into the same survivor.
- `POST /inventory/convert` — **conversion (prep transform)** event, see
  § Conversions. JSON `{ sources?: [{ item_ulid, amount? }], derived: { name,
  shelf_life_class?, on_hand_fraction?, units_total?, unit_seal?, store?, notes?,
  acquired_at?, recipe_ulid? }, at? (ISO date) }`. `sources` is **optional**
  (`[]` or omitted → a source-less conversion that decrements nothing,
  § Source-less conversions); when present, each
  `amount` is interpreted per that SOURCE's own on-hand model — a whole-unit
  integer for a counted source, a fraction (0..1) for a divisible one; omitted
  fully consumes the source (all remaining units, or the whole remaining
  fraction). `derived`: `name` required; exactly one of `on_hand_fraction` /
  `units_total` describes the new item's quantity model (defaults to a whole
  fraction-modeled item, `on_hand_fraction: 1`, when neither is given), with
  `unit_seal` stating what a counted batch's package seals — `shared` for a tray
  of portions under one lid, `individual` (the default) for separately-lidded
  jars (§ count-vs-fraction); it is refused without a `units_total`.
  `recipe_ulid` is optional provenance only (no macro computation in this
  surface — but it is what makes the derived item consume-eligible, § Consume
  from inventory § Eligibility). Decrements every source given (reaching zero on
  any source terminates it `finished`, mirroring `finished-unit`/full-toss) and
  creates ONE new `stocked` item with its own `eat_by` (derived the same way a
  fresh item's is) and a `kitchen.inventory_derivations` row linking it to its
  sources (empty when source-less). **Atomic** (ONE transaction — see
  § Conversions § Atomicity): all three write phases land or none do, so a failed
  request leaves the ledger untouched. **Not deduplicated by default** — the
  derived ULID is server-minted, so a retry makes a second batch; a caller that
  supplies `derived.ulid` (ULID) makes it the **idempotency key** and a replay
  writes nothing (§ Conversions § Retries).
  Returns `{ sources: InventoryItem[], derived: InventoryItem, derivation:
  InventoryDerivation, created }` — `201` when `created`, `200` on an idempotent
  replay. `400` `ConversionValidationError` — missing `derived.name`, an unknown
  source ULID, a non-integer `amount` against a counted source, a malformed
  `derived.ulid`, or a `derived.ulid` naming an existing item that is not a
  conversion output; `409` `InvalidTransitionError` — a source is already
  terminal (nothing left to spend).
- `POST /inventory/:ulid/consume` — **consume from inventory (one-tap
  known-macro log + deplete)**, see § Consume from inventory. `:ulid` is the
  ITEM. JSON `{ ulid (required — the consumption entry's client-generated
  ULID, the idempotency key), quantity? (integer >= 1), at? (ISO date-time) }`.
  Atomically (ONE transaction — see § Consume from inventory § Atomicity):
  creates a consumption entry carrying the item's EXACT known macros (no
  model call, `source: 'reselect'`, `status: 'estimated'`) and depletes the
  item — an integer decrement of `quantity` units (default 1, finished-unit
  semantics) for a counted item, or a full `finished` for a fraction item
  (which always fully finishes in one tap; `quantity` must be omitted or `1`
  there). Only a **consume-eligible** item qualifies — see § Consume from
  inventory § Eligibility; an ineligible item is rejected, not silently
  estimated. Idempotent on `ulid`: a replay creates no duplicate entry and
  does not deplete the item again, even when the first attempt already drove
  the item terminal. Returns `{ entry: Entry, item: InventoryItem, created }`
  (`201` when `created`, `200` on an idempotent replay). `404` unknown item;
  `409` `InvalidTransitionError` — the item is already terminal; `400`
  `ConsumeValidationError` — a bad `quantity` (exceeds `units_remaining`, or
  anything but `1`/omitted against a fraction item), or nothing on hand;
  `400` `ConsumeIneligibleError` — the item carries no recipe-linked macro
  provenance, or that provenance's recipe can't be resolved / has no
  components; `503` — the instance isn't wired for consume (no
  `consumeStore`/recipe resolver configured).
- `POST /inventory/:ulid/consumed` — **stated-weight consumption**, see
  § Stated-weight consumption. `:ulid` is the ITEM. JSON `{ amount_g?
  (number > 0), fraction? (0..1 exclusive-0), entry_ulid? (ULID), at? (ISO
  date-time) }` — exactly one of `amount_g`/`fraction` required; both name
  the amount EATEN (a decrement), mirroring `POST /inventory/:ulid/events`'
  `tossed` fraction semantics, never `opened`'s absolute-remainder one.
  `amount_g` is converted using the item's linked product's `net_content_g`
  as the mass basis and is refused when that basis is absent (never guessed
  — § Stated-weight consumption); pass `fraction` directly there instead.
  Applies to a **fraction-modeled item only** — `400`
  `StatedConsumeValidationError` on a counted one (`units_total` set; use
  `finished-unit` or `consume` instead). Reaching or passing zero goes
  terminal `finished` (consumed) — never `tossed`; a positive remainder is
  left on hand, unrounded. `entry_ulid`, when supplied, names an
  ALREADY-LOGGED consuming journal entry (this endpoint never creates one):
  the depletion and the link (`kitchen.entries.inventory_item_ulid`) commit
  in ONE transaction (mirroring `consume`'s atomicity requirement, via
  `ConsumeStore.linkConsumption` — a sibling of `ConsumeStore.consume`, not a
  second composed write), and `entry_ulid` doubles as the idempotency key: a
  replay (already linked to this item) neither re-links nor re-depletes.
  Omitted, the depletion still records as consumption via a plain
  single-table write. Returns `{ item: InventoryItem, entry: Entry | null,
  linked: boolean }` (`linked` true only on a fresh link; false when no
  `entry_ulid` was supplied, or on an idempotent replay). `404` unknown item;
  `409` `InvalidTransitionError` — the item is already terminal;
  `409` `StatedConsumeConflictError` — `entry_ulid` is already linked to a
  DIFFERENT item; `400` `StatedConsumeValidationError` — neither/both of
  `amount_g`/`fraction`, an out-of-range amount, an unknown `entry_ulid`, a
  counted item, or `amount_g` with no mass basis on the linked product; `503`
  `StatedConsumeNotConfiguredError` — `entry_ulid` was supplied but the
  instance isn't wired with a `consumeStore` (never required when
  `entry_ulid` is omitted).

Products & lexicon (agentic seed + reads):

- `POST /products` — JSON `{ ulid? (ULID), name (required), shelf_life_class?,
  aliases?, nutrition_per_100g?, nutrition_per_serving?, serving_size_g?,
  servings_per_container?, net_content_g?, net_content_ml?, unit_model_hint?,
  ingredients?, package_size?, shelf_life_days_unopened?,
  shelf_life_days_opened?, nutrition_negligible?,
  nutrition_negligible_override? }` → bare `Product`.
  **Upserts** (§ Product corrections): `201` create, `200`
  replace-on-`ulid`/enrich-on-name, `409` on an ambiguous name key or an
  archived target. `400` when `nutrition_negligible` is asserted on a
  salt-bearing product without `nutrition_negligible_override` (§ Sodium is the
  exception that breaks the marker); the override is a request-level
  instruction, never stored.
- `PATCH /products/:ulid` — JSON, ≥ 1 key, same field set minus `ulid`
  (§ Product corrections). Partial: only supplied keys change; explicit `null`
  clears; the two panels merge per-field. → bare `Product`; `404` unknown;
  `409` on a rename collision with a live product; `400` on a refused negligible
  assertion (including a rename that walks a still-marked product into a
  salt-shaped name) — § Sodium is the exception that breaks the marker.
- `POST /products/:ulid/merge` — JSON `{ into (ULID, required) }` → `{ product,
  merged, relinked: { items, lexicon_lines, batch_lines } }` where `product` is
  the survivor and `merged` the retired loser. `400` self-merge, `404` unknown
  either side, `409` archived survivor or an already-merged loser pointed
  elsewhere.
- `DELETE /products/:ulid` — archives (never destroys); idempotent → bare
  `Product`; `404` unknown.
- `GET /products?q&limit` → `{ products: Product[], count }` (`q` = substring
  over name/aliases). Archived products are excluded.
- `GET /products/:ulid/prices?store&limit` → `{ product_ulid, product_name,
  points: PricePoint[], count }` — the product's recorded purchases, newest
  first, each normalized to a comparable unit price (§ Price history). `404` on
  an unknown ULID; an archived-but-known ULID resolves (history must survive
  retirement), and a product whose lines were merged away reads as an empty
  `points`.
- `POST /lexicon` — JSON `{ store (required), line_text (required),
  product_ulid (required), package_size?, shelf_life_class? }` → `LexiconLine`
  (`201`); upserts on `(store, line_text)`.
- `GET /lexicon?store&limit` → `{ lines: LexiconLine[], count }`.

### JSON shapes (wire contract for the client app)

- **PurchaseBatch**: `{ ulid, source, store, store_undetermined, purchased_at,
  status, parse_attempts, last_error, created_at, updated_at }`.
  `store_undetermined` is true when a completed parse found no store (meta or
  header); false otherwise.
- **BatchLine**: `{ ulid, batch_ulid, raw_text, quantity, match_outcome,
  product_ulid, inventory_item_ulid, created_at }`. `quantity` is the
  physical-unit count the line represents (≥ 1; default 1).
- **InventoryItem**: `{ ulid, product_ulid, product_name, raw_label, store,
  batch_ulid, state, on_hand_fraction, units_total, units_remaining, unit_seal,
  needs_info, acquired_at, opened_at, closed_at, storage_moved_at, eat_by,
  shelf_life_class,
  days_until_eat_by, age_days, notes, merged_into, derived_from, created_at,
  updated_at }`.
  `product_name` is the joined product name (falls back to `raw_label`);
  `merged_into` is null except on a row retired into a surviving item
  (§ Item corrections);
  `days_until_eat_by`/`age_days` are derived integers (null when
  undeterminable). `units_total`/`units_remaining` are both null for a
  fraction-modeled item (§ count-vs-fraction), as is `unit_seal`; on a counted
  item `unit_seal` is always populated (`individual` when unstated) and
  `on_hand_fraction` is **derived** as `units_remaining ÷ units_total` rather
  than read from storage. `storage_moved_at` is null until a storage move is
  recorded, after which it is the item's clock anchor (§ Storage moves).
  `derived_from` is null unless
  the item was created by a `convert` event, in which case it is
  `{ sources: DerivationSource[], recipe_ulid }` (the same shape carried on
  `InventoryDerivation`, joined for read convenience). Dates are ISO date
  strings (`YYYY-MM-DD`); timestamps are ISO date-time.
- **InventoryDerivation**: `{ ulid, derived_item_ulid, sources, recipe_ulid,
  created_at }`. `sources` is `DerivationSource[]` —
  `{ item_ulid, amount, amount_kind: 'fraction'|'count' }` per source consumed,
  `amount` in that source's own unit. `recipe_ulid` is nullable (provenance
  only).
- **Product**: `{ ulid, name, shelf_life_class, aliases, nutrition_per_100g,
  serving_size_g, nutrition_per_serving, servings_per_container,
  unit_model_hint, net_content_g, net_content_ml, ingredients, package_size,
  shelf_life_days_unopened, shelf_life_days_opened, nutrition_negligible,
  archived_at, merged_into, created_at, updated_at }`. `nutrition_per_100g`
  (nullable) is `{ calories, protein_g, fat_g, sat_fat_g, carbs_g, sodium_mg,
  fiber_g, sugar_g, added_sugar_g }` (any field null = unknown);
  `nutrition_per_serving` is the same shape as printed per label serving;
  `ingredients` is the printed ingredients list (nullable text).
  `nutrition_negligible` is the ~0-at-any-realistic-serving assertion (every
  field, sodium included — § Sodium is the exception that breaks the marker);
  `archived_at`/`merged_into` are the retirement stamps (both null while live)
  — § Product corrections.
- **LexiconLine**: `{ ulid, store, line_text, product_ulid, package_size,
  shelf_life_class, non_inventory, created_at, updated_at }`. `product_ulid` is
  null on a non-inventory skip marker (`non_inventory: true`).
- **Question**: `{ item_ulid, item_ulids, count, raw_label, store, acquired_at,
  question }`. `item_ulid` is the representative (earliest-acquired) item to
  target for a label scan or dismissal; `item_ulids` are all items the grouped
  question covers; `count` is `item_ulids.length`. `question` renders the
  count when `count > 1` (e.g. `… ×2`).
- **PricePoint**: `{ line_ulid, batch_ulid, purchased_at, store, raw_text,
  quantity, price_cents, package_price_cents, unit_basis, unit_grams,
  unit_millilitres, cents_per_100g, cents_per_100ml }` (§ Price history).
  `package_price_cents` is `price_cents / quantity` (the per-physical-unit
  price), null when the printed price was unreadable. `unit_basis` is
  `'line' | 'lexicon' | 'product_net_content' | 'product_package_size' | null`
  — which source supplied the normalizing size; null means none did, and then
  both `cents_per_100*` are null. `unit_grams`/`unit_millilitres` are mutually
  exclusive (weight and volume are never cross-converted).
- **WasteRow**: `{ item_ulid, product_ulid, product_name, store, tossed_at,
  amount_fraction, units, terminal, cost_cents, cost_basis, price_line_ulid,
  priced_at }` (§ Waste costing). `amount_fraction` is the package fraction
  discarded and `units` the sealed units discarded (null on a fraction-modeled
  item); both null means the amount was unrecoverable. `terminal` is true when
  the toss closed the item. `cost_cents` is null on an unknown cost — never `0`
  — and `cost_basis` is `'batch_line' | 'product_price' | 'unknown'`.
  `price_line_ulid`/`priced_at` name the batch line the cost came from (both
  null when unknown).
- **Label response**: `{ item: InventoryItem, product: Product, resolved_count }`.
- **Dismiss response**: `{ item: InventoryItem, dismissed_count, non_inventory }`.
- **Convert response**: `{ sources: InventoryItem[], derived: InventoryItem,
  derivation: InventoryDerivation }`.
- **Consume response**: `{ entry: Entry, item: InventoryItem, created }`. The
  `Entry` shape is the phase-1 entry wire shape (`specs/modules/kitchen.md`
  § API — the same shape `POST /entries` returns), stamped
  `source: 'reselect'`, `status: 'estimated'`, and `inventory_item_ulid` set
  to the consumed item. `created` is `false` on an idempotent replay (neither
  table was touched again).

### Store extraction & precedence

A batch and every item it stocks are keyed to a **store**, and the receipt
lexicon is `(store, line_text)` — so a null store is corrosive and silent: the
lexicon write on label-resolve is skipped when the item's store is null, items
resolve but the lexicon learns nothing, and the same lines re-ask on every
future receipt. Two sources fill the store, in strict precedence:

1. **Explicit scan meta.** A `store` on the `POST /receipts` meta always wins
   (the owner naming the store they are standing in).
2. **Header extraction.** Otherwise the receipt model returns the merchant name
   as printed in the receipt header — the logo or first header line — **trimmed
   to just the brand**: street address, city/state/ZIP, phone, store number,
   slogan, and website are stripped; the printed casing is kept. The server
   additionally trims surrounding whitespace and collapses internal whitespace
   runs. The goal is a **short, stable** name so the same physical store keys
   the same lexicon rows across receipts (which is why the store number is
   dropped). Null when no name is discernible.

Resolution is `store = meta.store ?? extracted`. The resolved store is written
back onto the batch (`purchase_batches.store`) and stamped on every item the
parse creates. When **neither** source yields a store, the batch keeps
`store: null` and sets `store_undetermined: true` — the gap is recorded, not
silent, so a client/agent can surface it and the parse still proceeds
(unmatched lines become `needs_info` items with a null store, exactly as
before). A supplied meta store never sets `store_undetermined`.

### Conservative non-food skip

Grocery receipts flag non-food lines with markers (a taxable/non-grocery suffix
code) or obvious non-grocery text. The receipt model returns `non_food: true`
on a line **only when it is clearly non-food** from such a marker or the line
text itself (e.g. `GIFT CARD`, a bag fee, housewares). Effect: a `non_food`
line with no lexicon hit is recorded `skipped` with **no** item minted (step 4
of the resolution order above).

The rule is deliberately conservative — **ambiguity resolves toward
inventory**. Any line the model is unsure about is left un-flagged and becomes a
`needs_info` item, because a wrongly-skipped grocery (silently absent from
inventory) is worse than one extra question. Two further guards:

- A **durable lexicon mapping wins over the model judgment** in both
  directions: a `(store, line)` product mapping still matches and stocks even
  if the model guessed `non_food`, and a `non_inventory` skip marker still
  skips regardless of the model. The model judgment only decides lines the
  lexicon has never seen.
- The judgment is a **per-receipt first pass** — it never writes a
  `receipt_lexicon` row. The durable, per-store skip mechanism remains the
  explicit `non_inventory` dismissal (§ Non-inventory dismissal); the model
  judgment just spares the owner a question on the obvious cases this receipt.

### Depletion matcher

After a consumption entry reaches terminal `estimated`, a conservative,
model-free pass matches its label against on-hand items (exact/alias/substring
string match). A confident single match decrements the item and sets
`entries.inventory_item_ulid`; an ambiguous or absent match is a no-op
(unmatched entries are normal). Wired as an injected `onEntryEstimated` hook so
the estimation pipeline stays inventory-agnostic.

**The decrement follows the matched item's OWN unit model**
(§ count-vs-fraction). This is the load-bearing rule:

- **Fraction-modelled item** — `on_hand_fraction` drops by a fixed directional
  step.
- **Counted item** (`units_total` set) — exactly **one whole sealed unit** comes
  off `units_remaining`, with `finished-unit` semantics (§ Unit counts):
  reaching zero goes terminal `finished`; otherwise the item reverts to
  `stocked` with `opened_at` cleared and `eat_by` re-derived from the unopened
  window. One matched entry is one serving is one unit — the same per-serving
  convention § Consume from inventory settled on.

Decrementing a counted item's *fraction* instead is not a small
mis-attribution, it is a silent no-op: nothing reads `on_hand_fraction` on a
counted item, so the count sits at its purchase value while the shelf empties,
and every consumption is logged in the journal without moving the ledger.
Counting exists precisely to be the EXACT alternative to an eyeballed fraction,
so a count that never moves is worse than a fraction — unlike a fraction it
doesn't look like a guess, and eat-first then nags about items that are gone
while staying quiet about items that aren't.

**One entry depletes at most once.** The matcher is skipped outright when the
entry already carries an `inventory_item_ulid`. An entry can reach `estimated`
more than once — a note/label `PATCH` re-queues estimation, and the hook itself
is best-effort and retried — and without this guard each pass would take another
unit off the shelf. The link column *is* the idempotency key.

The match is label-only and the decrement is a fixed step (a directional
fraction, or one unit) — it consumes no macro quantities, so the portion
multiplier does not enter here. (Were it ever to deplete by consumed amount,
that amount is the **effective** macros, not the base.)

**Deliberately out of scope: recipe-component fan-out.** An entry logged against
a recipe whose components map to several tracked products depletes at most the
ONE item its own label matched — never one item per component. Fanning out needs
a per-(entry, item) link carrying each decrement's quantity: the single
`inventory_item_ulid` column cannot express it, and without a per-pair key the
idempotency guard above has nothing to check. So it is separate work with its own
schema, not an extension of the label matcher — and until it exists the matcher
must not pretend to it. Component-level depletion does have an exact path today:
`POST /inventory/convert` spends the named sources, and
`POST /inventory/:ulid/consume` logs + depletes the derived item atomically.

### Non-inventory dismissal

Grocery receipts carry non-grocery lines (housewares, a soup mug, a gift card).
The parse cannot know these are not food, so they land as `needs_info` items and
clutter the questions queue. Dismissal removes them without pretending they were
food waste:

- **State, not delete.** Dismissing transitions the item to the terminal
  `dismissed` state (§ Inventory state machine). The row survives for provenance
  (its batch line still references it; a receipt replay stays idempotent) and
  drops out of the default on-hand list and the questions queue by the same
  state-filter the other terminals use. `include_closed=true` surfaces it
  alongside finished/tossed.
- **Never waste telemetry.** `dismissed` is distinct from `tossed`: no
  `tossed …` note is appended and `on_hand_fraction` is left untouched, so waste
  rollups never count a dismissed non-food line.
- **The `non_inventory` flag makes it durable.** A bare dismissal clears one
  physical unit. `non_inventory: true` additionally (a) fans out to dismiss every
  open `needs_info` sibling with the same `(store, normalized raw_label)` — the
  same group the label path and questions queue treat as one — and (b) upserts a
  `receipt_lexicon` skip marker so the receipt parser skips the line on every
  future receipt from that store (recording it `skipped` on the batch line, never
  silently dropping it). This is the mirror image of a label scan: a label maps
  the line to a product; a non-inventory dismissal maps it to "not inventory".

### Item corrections — merge a duplicate, retire a phantom

Items are the records most likely to be wrong, because they are created fastest
and from the least information: a receipt line nobody has identified yet, a
one-tap manual seed, a scan target minted before anything is known about what
was scanned. Three correction affordances cover the ways they go wrong, and they
are deliberately distinct:

- **§ Reconcile** (`PATCH /inventory/:ulid`) — the record is real but its
  numbers/state drifted.
- **Dismissal** (`POST /inventory/:ulid/dismiss`, § Non-inventory dismissal) —
  the record should never have been stock at all. This is the correct retirement
  for a **phantom** item as much as for a housewares line: it is the only
  terminal that claims neither consumption nor waste, so a record that was never
  real leaves the ledger without fabricating either. Retiring a phantom with
  `finished` (a consumption that never happened) or `tossed` (waste that never
  happened) pollutes exactly the telemetry someone will later act on.
- **Merge** (`POST /inventory/:ulid/merge`) — **two records, one physical
  package**. Dismissal alone is not enough here: the loser carries links
  (a consumption entry that depleted it, the receipt line that created it, a
  conversion that spent it), and retiring it without moving them strands
  history against a record that is no longer stock.

**`POST /inventory/:ulid/merge` folds a duplicate item into a survivor** — body
`{ into: <survivor ulid> }`, where `:ulid` is the loser. In one operation:

1. **Fill the survivor's gaps from the loser**, never null-clobbering: only
   `product_ulid`, `store`, `raw_label`, `batch_ulid`, and `shelf_life_class`
   participate, and only where the survivor's own value is null. The survivor's
   own values always win. This is what makes merge the correction path for a
   `needs_info` item whose identity was established on the *other* record —
   `product_ulid` is not reachable through `PATCH` (§ Reconcile is about
   quantities and state), so merge is the only door that moves it.
2. **Resolve the survivor when the fill identified it.** If the fill set
   `product_ulid` on a `needs_info` survivor, `needs_info` clears and `eat_by`
   re-derives — from the **survivor's own** `acquired_at`/`opened_at` and the
   linked product's day-window overrides, exactly as the label fan-out does for
   siblings. The clock is a property of the physical package, and the survivor is
   the record the caller chose to keep; a merge must never import the loser's
   clock, which is the very artifact that made the duplicate misreport
   (a phantom minted a day late reads as a day fresher than the food is).
3. **Quantities are never summed.** A merge asserts the two rows are *one*
   package, so adding `on_hand_fraction` or `units_remaining` would manufacture
   stock that does not exist — the same over-reporting the duplicate caused.
   The survivor keeps its own on-hand model untouched; if that count is also
   wrong, a `recount` fixes it, and that is a separate observation.
4. **Relink every dependent** onto the survivor, with per-table counts in the
   response: `entries.inventory_item_ulid` (consumption entries that depleted
   the loser), `purchase_batch_lines.inventory_item_ulid` (the receipt line that
   created it), `inventory_derivations.sources[].item_ulid` (conversions that
   spent it as an input), and `inventory_derivations.derived_item_ulid` — the
   last **only when the survivor has no derivation of its own**, since that link
   is 1:1 by construction; a survivor that already carries provenance keeps it
   and the loser's stays with the loser (reported as `0`).
5. **Retire the loser** — terminal `dismissed`, `closed_at` stamped, and
   `merged_into` set to the survivor. `dismissed` is used from *any* prior
   state, including an already-terminal one: the merge is the assertion that this
   row was never independent stock, so whatever terminal it currently carries is
   a claim about food that does not exist. In particular this **retracts** a
   `finished` that was only ever a workaround for a missing retirement path.

Rules: `into` must differ from `:ulid` (`400`); either ULID unknown → `404`;
`into` pointing at an item that was itself merged away → `409` naming its
`merged_into` (following a chain invites a cycle — the caller retargets);
the loser already merged into a *different* survivor → `409` naming where it
went. **Idempotent**: re-merging an already-merged loser into the same survivor
succeeds with zero relinks and no second retirement stamp. Returns
`{ item, merged, relinked: { entries, batch_lines, derivations,
derivation_sources } }` where `item` is the survivor's view and `merged` the
retired loser's.

**No hard delete, here as everywhere else in the module.** The loser's row
survives every retirement path: its batch line still points at it until relinked,
a receipt replay must stay idempotent, and `merged_into` is how a reader later
learns where the record went.

### Conversions

Meal prep is a **transformation**, not consumption: a `POST /inventory/convert`
event creates a NEW inventory item — the **derived item** — with its own
identity, shelf-life clock, quantity, and provenance, optionally decrementing
one or more source items it was made from. The defining act is **creating the
derived item**; decrementing sources is an optional side effect (see § Source-
less conversions). This is distinct from both halves of the existing model:

- **Not a consumption entry.** `convert` never touches `kitchen.entries` and
  posts no journal entry — no macros, no estimation. One-tap consumption of a
  now-existing derived item (eating the jar) is `POST /inventory/:ulid/consume`
  — see § Consume from inventory, below.
- **Not finished/tossed.** Those are terminal with no replacement; a
  conversion's sources may go terminal as a SIDE EFFECT of being fully spent
  (see below), but the event's defining act is creating the derived item, not
  closing out the source.

**Decrementing sources.** Each source's `amount` is interpreted per that
source's OWN on-hand model (§ count-vs-fraction) — a counted source takes a
whole-unit integer, a divisible source takes a fraction (0..1); omitted fully
consumes the source. A source reaching zero (all units spent, or the fraction
exhausted) transitions to terminal `finished`, exactly mirroring
`finished-unit`/a full toss; otherwise it stays alive at the decremented
quantity with its state/`opened_at`/`eat_by` untouched — spending SOME of a
source doesn't touch which unit (if any) is currently open. A terminal source
(nothing left to spend) is rejected (`409`).

**Source-less conversions (register a prepared item).** `sources` is
**optional** — a conversion may carry zero of them. This is the *"I prepped
this"* path: you hand-built a jar of overnight oats, hard-boiled a batch of
eggs, cooked a pot of quinoa, and you want the prepared item on the shelf, but
the raw inputs were bought loose, already logged, or simply aren't worth
tracking as their own inventory rows. A source-less convert creates the derived
item exactly as above (its own clock, quantity, and — critically — its
`derived.recipe_ulid`) with an **empty provenance** list; nothing is
decremented. This matters because **`convert` is the only path that mints a
consume-eligible item** (§ Consume from inventory § Eligibility): an item's
one-tap `consume` macros come from its conversion's `recipe_ulid`, so a prepared
food that never went through a `convert` can never reach the consume shelf. A
plain `POST /inventory` (`inventory add`) makes an ordinary tracked item with no
recipe provenance — correct for groceries, wrong for a prepared meal you intend
to one-tap-log later. Requiring sources would force that wrong path whenever the
raw inputs aren't tracked; making them optional is what lets *"I made three oat
jars"* land as three shelf-ready items.

**Creating the derived item.** One new `stocked` item, `eat_by` derived the
same way any fresh item's is (from its `shelf_life_class` + `acquired_at`,
defaulting to the conversion's `at`/now). Its `shelf_life_class` defaults to
**`prepared`** (§ Data model § Shelf-life classes — a cooked/assembled dish,
~4 days from the make date) when `derived.shelf_life_class` is omitted, so a
prepped item always earns an honest eat-by and joins eat-first ordering rather
than falling to `unknown` (no eat-by, invisible to the planner); a caller that
knows the dish keeps longer or shorter overrides it (`produce` for hard-boiled
eggs, `very_perishable` for cut fruit). Its quantity is EITHER a fraction
(`on_hand_fraction`, default 1 when neither is given) OR a count
(`units_total`), per the same discriminating test as any other item. It has no
`product_ulid` — a derived item is identified by its own `raw_label` (the
conversion's `derived.name`), not a durable product (a jar of overnight oats
isn't a SKU the lexicon would ever see again).

**Provenance.** A `kitchen.inventory_derivations` row links the derived item to
its sources (`item_ulid` + the exact `amount`/`amount_kind` consumed from
each) and, optionally, a `recipe_ulid` — the recipe/conversion that fixes the
derived item's macros (provenance only in this surface; the derived item
itself carries no STORED macros — `kitchen.inventory_items` has no macro
columns. `recipe_ulid` is the macro-inheritance hook § Consume from inventory
reads: it computes the item's macros on demand from the recipe rather than
persisting them, so nothing here needs to change to support it).
Deliberately **minimal, not a full lineage graph**: one hop back to direct
sources, no chained "what did THIS source come from" queries, no cascading
updates if a source is later corrected. It exists to (a) let the eat-first
planner reason across the transform (aging yogurt "used up" by becoming jars
is visible as the yogurt's depletion plus the jars' existence, and the jars'
provenance explains why) and (b) back the on-demand macro inheritance
§ Consume from inventory uses, not to model a full recipe graph.

**Derived items are first-class eat-first stock.** They carry `eat_by` and
`state` exactly like any other item, so they join the ordinary
`GET /inventory` eat-by ordering with no special-casing — the planner sees a
freshly-made overnight-oats jar sitting at whatever eat-by its own shelf-life
class earns it, right alongside everything else.

**Atomicity is a hard requirement.** A conversion's every write — each source's
decrement, the derived item's insert, the derivation's insert — is ONE atomic
operation: a failure at any point leaves the ledger **exactly as it was**. Never
sources spent with no derived item, never a derived item with no provenance, and
never a partially-decremented source set. Enforced by a single store-level
method (`InventoryStore.applyConversion`) that wraps all three phases in one
Postgres transaction (`sql.begin`), the same requirement and the same mechanism
§ Consume from inventory § Atomicity states for `consume`.

Why this is the load-bearing guarantee here and not a nicety: a prep transform is
precisely where several tracked inputs are spent at once, and a mid-sequence
failure fails in the direction where the ledger claims **less** stock than
reality. Under-reporting is the direction nothing downstream flags — eat-first
simply stops offering food that is really still in the fridge — so it surfaces
much later as unexplained drift rather than as an error anyone can trace. The
second case (a derived item with no derivation row) is quieter but corrupting: it
breaks cost attribution and, because `derived_from.recipe_ulid` is the only
macro-inheritance channel (§ Consume from inventory § Eligibility), it silently
makes a prepared item consume-ineligible.

Unlike `consume`, a conversion crosses no store seam — every table it touches
(`kitchen.inventory_items`, `kitchen.inventory_derivations`) is owned by
`InventoryStore` — so this needs no second store interface; the memory
implementation is the same mirror of the pg one every other store method has.

**Validation precedes the write phase.** The made-food-only shelf-life-class
guard, each source's existence, the terminal-source check, and the counted-source
integer-`amount` check all run — and each source's decrement is *planned* —
before any write is issued. A rejected request therefore never opens a
transaction, and no source is spent on a conversion that was going to be refused
for a later source. A source named twice in one conversion has its second
decrement planned against the state the first leaves behind, so two lines against
one pack spend two lines' worth.

**Retries are not deduplicated by default — but a caller may opt in.** The
derived item's ULID is minted server-side unless the caller supplies
`derived.ulid`, and that default is the correct one for this verb: "I made another
batch" is an ordinary, repeated act, so two identical requests are far more likely
to be two real batches than one double-sent one, and collapsing them would lose a
batch. A caller that did double-send corrects it with `inventory dismiss` /
`merge` (§ Item corrections).

A caller that **knows** a request is a retry rather than a second batch supplies
`derived.ulid`, and it becomes the conversion's **idempotency key** — the same
role `ulid` plays for `consume` (§ Consume from inventory § Idempotency).
A replay then writes **nothing**: no source spent again, no second derived item,
no second derivation. It returns the existing derived item + provenance with
`created: false` (`200` rather than `201`). (Amended 2026-07-29: this was
previously stated as a deliberate non-feature; § Cook mode is the caller that
needs it, because a worksheet resubmitted over a flaky mobile network is
unambiguously one batch.)

Two properties make that safe:

- **The replay check runs BEFORE any validation against current state.** This
  ordering is load-bearing for exactly the reason it is in `consume`: the first
  attempt may already have driven a source terminal (fully spent), so a replay
  validated against today's state would `409` against its own side effect. A
  replay must succeed, having written nothing.
- **The check is repeated inside the transaction**, so near-simultaneous replays
  serialize there rather than racing to spend the sources twice. A server-minted
  ULID never hits it.

A supplied `derived.ulid` that names an existing item with **no** derivation row
is a `400`, not a replay: every conversion output has provenance (that invariant
is what makes it consume-eligible), so such an item is some *other* item and the
caller reused a ULID. Fabricating provenance to paper over that would silently
mint a wrong macro channel.

Examples: 12 raw eggs (counted) → 6 hard-boiled eggs (`sources: [{item_ulid,
amount: 6}]`, `derived: {units_total: 6, shelf_life_class: 'fridge_short'}`) —
the egg carton keeps 6 remaining, sealed and unopened-clocked; 1 divisible bag
of dry quinoa → ~3 cups cooked quinoa (`sources: [{item_ulid, amount: 0.3}]`
— a directional estimate of "about 1 cup out of the whole bag", `derived:
{on_hand_fraction: 1, shelf_life_class: 'fridge_short'}`); oats + yogurt +
soymilk + fruit (four fraction sources, one conversion call each or batched
into one `sources` array) → 3 overnight-oats jars (`derived: {units_total:
3}`).

### Consume from inventory

`POST /inventory/:ulid/consume` (claude-assist#110,
`plans/consume-from-inventory.md`) is the one-tap "eat a prepared item"
action: the re-select strip's inventory-sourced sibling, and the purest case
of *logging must beat not-logging* (`specs/diet-journal.md` § Principles). A
portioned inventory item whose macros are already known — inherited from the
conversion/recipe that made it (§ Conversions) — logs to the journal AND
depletes in one tap: no photo, no model call, no correction.

**Eligibility — one test, two families.** An item qualifies when the module knows
**both its panel and its portion**. There are two independent macro-inheritance
channels, and an already-terminal item is rejected regardless of either (`409`,
checked first, mirroring `convert`'s terminal-source check):

1. **Derived items** — the item's derivation provenance
   (`derived_from.recipe_ulid`, written by the `convert` that created it) resolves
   to a recipe, DB-persisted (`pushed`/`promoted`) or meal-bank sheet-sourced —
   the same merged universe the reselect strip serves — carrying at least one
   component.
2. **Counted purchased items** — the item is counted (`units_total` set) and its
   linked product carries both a nutrition panel and `unit_edible_g`
   (§ Data model § Per-unit edible grams). One tap logs one unit's panel,
   computed as `per_100g × unit_edible_g ÷ 100`, and decrements one unit. A
   `reference` `nutrition_source` **qualifies**: a generic-but-correct panel for a
   whole unit is deterministic, and it beats routing a known food through the
   estimator. **`estimate` does NOT qualify.** The distinction is not pedantry
   about provenance tiers — it is the difference between a number that is *correct
   for the food and generic for the SKU* and a number that was **guessed**.
   Consume logs deterministically, with no confidence score and no estimation
   pass, so admitting an `estimate` panel would launder a stored guess into a
   fact that nothing downstream can question — the exact defect
   § A panel means nothing without its basis exists to prevent. An item whose
   only panel is an `estimate` belongs on the photo/reselect path, where the
   uncertainty stays visible.

**Purchased fraction items never qualify**, regardless of panel completeness. A
divisible container has no natural unit, so "eat one" has no meaning, and finishing
the whole container in one tap is almost never the real act — that is what
§ Stated-weight consumption is for. This follows directly from § count-vs-fraction:
one-tap consume is a whole-sealed-unit action.

An item satisfying neither channel is rejected (`400 ConsumeIneligibleError`) and
simply does not appear on the consume shelf — it needs the normal photo/reselect
path. Ineligibility is an absence, not an error to render.

**Macro inheritance (deterministic, no model call) — the per-unit recipe
contract.** The recipe's total macros are computed exactly as a direct
recipe-logged entry's are (`computeRecipeMacros`, § API `POST /entries`).
What the linked recipe DESCRIBES depends on the item's unit model:

- **Counted item** (`units_total` set): **the recipe describes ONE sealed
  unit**, so the entry carries `recipe × quantity` (default 1). This is the
  system-wide per-serving recipe convention — the reselect strip logs the
  same recipe whole as one serving, and recipe authors naturally write "an
  overnight-oats jar," not "three jars" — so consume and reselect agree on
  what a recipe means. E.g. 3 oat jars, per-jar recipe linked → consuming one
  jar logs exactly the recipe's totals. (Amended 2026-07-22: the original
  contract here was `share = quantity / units_total` — the recipe as the
  whole batch — which collided with the per-serving convention the moment a
  real multipack landed: a per-jar recipe on a 3-jar batch logged ⅓ of a
  jar.)
- **Fraction item**: the recipe describes the **whole batch**, scaled by
  `share = on_hand_fraction` — a fraction consume always fully finishes the
  item in one tap (see § Depletion below), so it accounts for whatever share
  of the original batch is still on hand.

The resulting entry is `source: 'reselect'`, `status: 'estimated'`,
`portion_basis`/`confidence` carried through from the recipe computation
unscaled (a recipe-computed total is exactly confidence `1` regardless of
what share one tap accounts for), `label` = the item's `raw_label`, and
`inventory_item_ulid` = the consumed item — set in the SAME insert, not a
follow-up link (contrast the depletion matcher's best-effort, separate
`linkEntry` call).

**Depletion** reuses the existing state-transition semantics exactly:

- **Counted item** — `finished-unit` semantics generalized to `quantity`
  units: an integer decrement of `units_remaining`. Reaching zero goes
  terminal `finished` (identical outcome to a whole-item finish); otherwise the
  outcome follows the item's `unit_seal`, exactly as `finished-unit`'s does
  (§ count-vs-fraction) — an `individual`-seal item reverts to `stocked` with
  `opened_at` cleared and `eat_by` re-derived from the **unopened** window (the
  unit just consumed carried the opened clock, the next-to-open one never itself
  opened), while a `shared`-seal item stays `open` on its container's clock, and
  a still-`stocked` one has the open implied at the event's date.
- **Fraction item** — `finished` semantics: always fully terminal
  (`closed_at` stamped, `on_hand_fraction` zeroed). A fraction consume is a
  single all-or-nothing tap; `quantity` must be omitted or `1` there
  (`400 ConsumeValidationError` otherwise) — there is no partial consume the
  way there's a partial toss.

**Atomicity is a hard requirement.** The entry-create and the
inventory-depletion are ONE atomic operation: a failure of either side
leaves NEITHER applied — never a logged-but-not-depleted entry, never a
depleted item with no matching entry. This is enforced by a single store-level
method (`ConsumeStore.consume`, `packages/kitchen/src/services/consume-store.ts`)
that wraps both writes in one Postgres transaction (`sql.begin`) rather than
composing two separate store calls at the service layer. **Every multi-write
inventory event in this module holds the same guarantee by the same mechanism** —
see § Conversions § Atomicity for `convert`'s (`InventoryStore.applyConversion`),
which had exactly this gap until it was closed. `kitchen.entries` and
`kitchen.inventory_items` are each owned by their own store interface for
testability everywhere else in the module; this is the one path that
deliberately crosses that boundary, and it exists only for this requirement
(`convert` needs no such crossing — every table it writes is `InventoryStore`'s).

**Idempotency.** `ulid` in the request body is the consumption entry's
client-generated ULID — the idempotency key, mirroring entry-ingest ULID
idempotency (§ API `POST /entries`) so the offline app's queue replay is safe.
A replay is detected BEFORE any terminal/eligibility validation runs against
the item's CURRENT state — this matters because the first successful consume
may already have driven the item terminal (a fraction consume always fully
finishes it), and a replay must still succeed (no duplicate entry, no
double-deplete) rather than 409 against its own side effect. The atomic store
call also idempotency-checks inside its own transaction (`ON CONFLICT
(ulid) DO NOTHING` on the entry insert), as a race-safety net for
near-simultaneous replays.

### Price history (per-product cost reads)

Receipt intake already transcribes what every line cost (§ Prices) and links
most lines to a product through the lexicon, so the module holds a per-product
purchase history that nothing could ask a question of. `GET
/products/:ulid/prices` is that question: **every recorded purchase of one
product, dated, with the store it came from and a per-unit normalization**,
newest purchase first.

**A read-time derivation, never a stored table.** Every field of a price point
is computed from rows that already exist — `purchase_batch_lines` joined to its
`purchase_batches` (for `purchased_at` and `store`), the `receipt_lexicon` line
for the package size that store prints, and the product's label-derived net
content. Nothing is written on the read path and no price is copied anywhere,
so a corrected receipt line or a re-scanned label immediately corrects every
history that quotes it. The § Prices boundary stands as written for **spend
analysis and budgeting** — those remain the personal-finance domain's business,
and this module grows no dashboards, no period rollups, and no budget targets.
What it does own is the *fact* read: which prices are on file for a product,
because only the module knows how a line, a lexicon mapping, and a package size
compose into a comparable unit price.

**Every purchase is a point, priced or not.** A line whose `price_cents` was
unreadable still lands as a point with `price_cents: null` and a null unit
price — the purchase happened, and dropping it would silently shorten the
history. A null price is never rendered as `0`.

**Per-package price is the line price divided by the line's `quantity`.** A
multi-quantity line records one extended price for N physical units, so a point
carries both the printed `price_cents` and the derived
`package_price_cents = price_cents / quantity`. This is the read-time division
§ Prices reserves; it is still never stored.

**Unit normalization — the divisor belongs to the POINT, not the product.** A
12 oz bag and a 16 oz bag of the same product are not comparable at face value,
and package sizes genuinely change between purchases and between stores, so the
size used to normalize a point is resolved per point, most-specific first:

1. **A measure printed in the line's own `raw_text`** ("1.42 LB @ 0.79/LB",
   "OLV OL X-VRG 750ML") — the § Prices by-weight read, now blessed for every
   line, not only weighed ones. It is the most specific because it describes
   *that* purchase.
2. **The `receipt_lexicon` line's `package_size`** for `(store, normalized
   raw_text)` — the size the owner recorded for that store's line text.
3. **The product's `net_content_g` / `net_content_ml`** — the label-derived
   deterministic net content (§ Prices' divisor).
4. **The product's `package_size`** string, parsed the same way a lexicon size
   is.

Whichever wins is reported on the point as `unit_basis` (`line` / `lexicon` /
`product_net_content` / `product_package_size`) alongside the grams or
millilitres it resolved to, so a caller can see *why* two points normalized
differently rather than inferring it. **No size resolves → no normalized
price**: `cents_per_100g` / `cents_per_100ml` stay null. Unit conversion is
deterministic code (the same weight/volume tables the label scan's net-content
conversion uses), never model arithmetic, and a count-stated size ("12 ct")
resolves to neither grams nor millilitres — a count is not a mass.

Weight and volume are **never** cross-converted (no assumed 1 g/ml), so a
product bought sometimes by weight and sometimes by volume yields two
non-comparable series rather than one wrong one. Points carry each basis on its
own field; the caller compares like with like.

**A merge unions the history, by construction.** `POST /products/:ulid/merge`
relinks `purchase_batch_lines.product_ulid` onto the survivor (§ Product
corrections), and this read keys on exactly that column — so the survivor's
history is the union of both records' purchases the moment the merge lands, with
no history-specific relink step to forget. The retired loser resolves by ULID
forever and reads as empty (its lines moved), which is the honest answer.

**`?store=` scopes to one store**, for the "is this cheaper across town"
question; `?limit` caps the points returned (newest kept).

### Waste costing

A toss records what was thrown away (§ Inventory state machine) but never what
it was worth, and "waste trends toward zero" is not a goal anyone can steer by
count of incidents alone. `GET /inventory/waste` attaches the number: **every
recorded toss, with the product, the amount, and what that amount cost**,
newest first — derived, at read time, from the toss record and the price
history above.

**Which price applies, in order:**

1. **The actual batch line the item came from.** An item created by receipt
   intake carries `batch_ulid`; the line for its `(batch_ulid, product_ulid)`
   is what was *actually paid for that package*, and it is what a toss costs
   whenever it is knowable. Preferring it over any average is the same
   transcribe-the-real-thing stance § Prices takes.
2. **The nearest priced purchase of the same product** otherwise — the latest
   priced line at or before the item's `acquired_at` (the price in force when
   it entered the house), falling back to the earliest priced line after it
   when the item predates every recorded price. This covers the manually-seeded
   item, the item whose own line's price was unreadable, and the item acquired
   before receipt scanning began.
3. **Nothing.** No priced line for the product at all → the cost is
   **unknown**.

Every waste row reports `cost_basis` (`batch_line` / `product_price` /
`unknown`) plus the `price_line_ulid` and `priced_at` it used, so the
attribution is auditable per row rather than taken on faith.

**Unknown cost is null, never zero.** A product with no priced purchase reads
`cost_cents: null` and `cost_basis: 'unknown'`. Zero would state that throwing
it away cost nothing, which is precisely the opposite of what the read exists
to say, and it would silently deflate every total that summed it. Totals
therefore report the **sum over rows with a known cost** alongside the count of
rows whose cost is unknown — a partially-known total that says how partial it
is, never a whole-looking total that quietly excludes rows.

**Cost scales to the amount actually discarded**, never to the whole package:

- **Fraction-modeled item** — `cost = package_price × tossed fraction`. A
  partial toss of 0.25 costs a quarter of the package.
- **Counted item** — `cost = per-sealed-unit price × units discarded`, where
  the per-unit price is the package price divided by `units_total`. A toss that
  discards 2 of a 12-pack costs two twelfths, not the pack.

**Waste reads structured state, not free text, for whether a toss counts.** A
row is excluded when the item is `dismissed` or carries `merged_into` —
`dismissed` is the module's "this was never real stock" terminal, and an item
merge retires its loser there precisely to retract a claim about food that does
not exist (§ Item corrections). So the duplicate that was mistakenly `tossed`
and then merged away contributes nothing: its state retraction *is* the
retraction of its waste, with no second bookkeeping step. This is the whole
reason the gate is a state check and not a note check.

**The amount tossed is still read from the item's `notes`, and that is a known
seam.** `on_hand_fraction` is zeroed by a full toss and decremented by a
partial one, so the amount discarded survives only in the `tossed <amount>
<date>` line the toss appends — the note is currently the module's only record
of a waste *quantity*. Waste reads parse those lines and pair each with the
structured state gate above; a `tossed` item with no parseable note reads as an
**unknown amount** (and therefore unknown cost), never an assumed whole
package. A counted item's toss additionally records the sealed units it
discarded (`tossed <fraction> (<n>u) <date>`), because a counted item's
`on_hand_fraction` does not track its unit count and the fraction alone would
charge a full pack for a nearly-empty one. Recording tosses as structured rows
(a waste event table, which would also make a resurrecting reconcile retract
its waste the way a merge does) is the durable fix and deliberately out of
scope here — this read is derivation-only over rows that already exist.

**`?since` / `?until`** bound the window by toss date; `?limit` caps rows
(newest kept).

## Cook mode — a submitted prep worksheet IS the log

The pages module can publish a **worksheet**: weighable components with per-100g
references, whose actual quantities the cook states, yielding a computed panel
(`specs/modules/pages.md` § The worksheet response pattern). Cook mode is this
module's sink for those submissions — the seam that makes **submitting the sheet
the log**, rather than a queue entry an agent later has to notice and transcribe.

That wait is what cook mode removes, and it is not a hypothetical cost: a real
prep sheet was never submitted, no agent ran, and the meal existed nowhere until
it was reconstructed from memory days later. Logging must beat not-logging
(`specs/diet-journal.md` § Principles), and a loop that depends on a *second*
actor showing up is a loop that sometimes doesn't close.

**Cook mode invents no contracts.** Each disposition lands on an endpoint that
already exists, unchanged:

| disposition | maps to | what the ledger gets |
| --- | --- | --- |
| `eaten` | `POST /entries` with a `macros` panel (§ Directly-stated panel entries) | one born-`manual`, terminal entry; **no estimator** |
| `packed` | `POST /inventory/convert` (§ Conversions) | sources decremented, one derived item created with its `recipe_ulid`; **no journal entry** |

**Packing is a conversion; eating is an entry.** This is the load-bearing rule,
not an implementation detail. A packed batch is *stock* that will be eaten later,
possibly not as planned — pre-logging it as consumption makes the journal lie the
moment plans change. The batch becomes a journal fact at eat time, via
`POST /inventory/:ulid/consume` (§ Consume from inventory), at whatever share is
actually eaten then. Attaching `recipe_ulid` on the convert is what keeps that
one-tap path available (§ Consume from inventory § Eligibility).

**The worksheet's per-100 g references are resolved, never transcribed.** A
worksheet's components reference products by ULID and the publisher resolves their
panels from the product records; a literal per-100 g table written into page source
is acceptable **only** for a component with no product record at all, and is marked
as such. This is not stylistic. An eaten worksheet is logged born-`manual` and
**terminal, with no estimation pass** (below), which makes it the highest-trust
input the module accepts — so it must not also be its least-verified: a hand-typed
per-100 g literal is a transcription with no checker between it and a permanent
record, and the composing agent is exactly the actor § A panel means nothing without
its basis shows substituting recall for arithmetic.

A resolution failure must **degrade visibly** rather than submitting zeros or stale
numbers. For a terminal log path a blocked submission is recoverable and a silently
wrong one is not.

**The panel is stated, never re-guessed.** An eaten worksheet has already computed
its numbers from weighed quantities against per-100g references — they are exact
by construction. The directly-stated shape stores them verbatim as a born-`manual`
terminal entry and enqueues **no** estimation, so there is nothing that could
later land and clobber what the cook watched add up on screen (§ Directly-stated
panel entries — the birth-race hole this shape exists to close).

**Totals are validated against the real panel, and an unknown field is an error.**
The worksheet's field keys are arbitrary strings by design (the pages module owns
no nutrition vocabulary), so checking them is this module's job — and it rejects a
key that is not one of the nine panel fields (§ Nutrition panel) rather than
dropping it. A silently-ignored field would log a meal whose numbers quietly
disagree with the displayed totals, which is precisely the defect being removed.
A `null` total is **unknown** and is simply left unstated (never `0`); a stated
`0` is a real zero and is stored.

**Idempotency: one key, one meaning.** The submission's `submission_key` (a ULID)
becomes the identity of whichever write the disposition maps to — the entry's
ULID when eaten, the derived item's ULID when packed. Both writes are idempotent
on it (`POST /entries` already was; `convert` gained the opt-in
`derived.ulid` key for exactly this caller — § Conversions § Retries). A
resubmission over a flaky mobile network therefore cannot double-log or
double-decrement, and reports `created: false`.

**One authoritative write per submission; decrements never roll it back.** Cook
mode does not compose two domain writes as equals, so there is no "entry landed,
decrement failed" half-state to reconcile. The two dispositions reach that
guarantee differently, and the difference is not incidental:

- **`packed` is genuinely one write.** The conversion decrements every source
  and creates the derived item in a single transaction
  (§ Conversions § Atomicity). Nothing is partially applied.
- **`eaten` is one write plus best-effort depletion.** The entry lands first and
  is authoritative (§ Eaten sheets decrement their sources); the bindings then
  decrement, and a binding that cannot apply is *reported*, never allowed to
  fail the entry. A meal that refused to record because a bag lacked a net
  weight would be a strictly worse ledger than one that records and flags the
  gap.

What the caller sees when a write fails, and what the ledger holds, is stated in
`specs/modules/pages.md` § Cook mode § Order of writes.

**Measured weights on a packed batch are provenance, not macros.** The derived
item carries the measured quantities in its `notes`, and the pages response row
retains the full computed record; but its *consume-time* macros still come from
the linked recipe's own quantities, because `derived_from.recipe_ulid` is the only
macro-inheritance channel (§ Consume from inventory § Eligibility). A batch
weighed materially off-recipe therefore logs the recipe's numbers when eaten, not
the batch's. Carrying per-batch measured macros would need either a per-batch
recipe or item-level macros — a real change to the item model, deliberately not
made here.

**The seam.** The module decorates `fastify.kitchenCookMode` (a
`{ cook(request) → { kind, ulid, created } }` surface); the **server** injects it
as the pages module's `worksheetCookSink`. Same pattern as
§ Cross-module seams — the packages never import each other, and with the kitchen
module absent a cook-mode submission reports `unavailable` instead of pretending
it logged.

### Model tiering (phase 2)

- Receipt line extraction uses the **cheap** tier (`KITCHEN_RECEIPT_MODEL`,
  default a Haiku-class id) — mechanical OCR-ish extraction, gather cheap.
- Label extraction reuses the **strong** vision tier (`KITCHEN_ESTIMATION_MODEL`)
  — reading a nutrition/size panel accurately earns the better model. The
  prompt treats multiple photos as complementary views of **one** product (front
  for identity, panels for nutrition + ingredients) and extracts the full
  `nutrition_per_100g` panel plus the `ingredients` list when a photo shows
  them; a partial panel fills only what it shows and leaves the rest null.
- Lexicon resolution and depletion matching are **deterministic** — no model
  call.
- Every model dependency is optional: with no API key, receipts still post but
  the batch stays `parsing` with no lines until a model is configured and the
  client re-posts (photos are never persisted, so there is nothing to OCR
  later); an unknown line from a *successful* parse lands as a `needs_info`
  item; label intake `503`s until configured. The whole inventory surface
  degrades to "roughly right, self-healing".

### Cross-module seams (phase 2 wiring)

Both seams follow one pattern: the kitchen module **decorates** a surface on
the Fastify instance; the **server composes** a minimal, kitchen-type-free
function (types owned by core) from that surface and injects it into the
consuming module's config. Consumer packages never import the kitchen package,
and every seam degrades cleanly when the kitchen module is absent.

- **Ambient remarks** — the capture classifier's `kitchen_event` type routes
  (ROUTING_TABLE → `kitchen-event`) to a `KitchenEventExecutor` whose
  dependency — a `(remark) => Promise<outcome>` resolver — is composed from
  the decorated `fastify.kitchenEvents` surface and injected via
  `captureConfig.kitchenEventResolver`. The executor hands the remark to
  `POST /inventory/events`'s same resolver, so a passing remark from any
  capture surface reaches the same state machine a deliberate event does.
  Absent the wiring, `kitchen_event` captures park in `awaiting_executor`.
  Deliberate inventory actions (the app's tabs) never touch the classifier.
- **Stock-aware suggestions** — the kitchen module decorates
  `fastify.kitchenRecipes` (`listAll()`: the full **merged sheet + pushed +
  promoted** recipe view, the same merge the reselect strip performs). The
  server composes a `KitchenRecipesProvider` (`() =>
  Promise<{name, component_labels[]}[]>`, core-owned type) from it and injects
  it via `briefingConfig.kitchenRecipesProvider`, so meal-bank **sheet**
  recipes participate in the briefing's stock-aware suggestions from day one
  (no cold start). Absent the provider, the briefing source falls back to a
  direct SQL read of DB-persisted recipes only.

## Authoring a prep worksheet — `kitchen-axi prep`

Cook mode is the *submission* half. This is the authoring half, and it belongs
here rather than in the pages CLI: **the domain owns the reference values.**

A worksheet definition for a meal is mostly per-100g panels, one block per
component. Assembling that by hand means transcribing numbers this module already
stores — which is the estimation-by-recall failure the § Nutrition panel rules
exist to prevent, reappearing in the authoring path. A hand-built definition can
also silently disagree with the catalog it was copied from.

- **`kitchen-axi prep publish --slug <slug> --label <label>`**
  - `--component <product-ulid>=<planned grams>` (repeatable) — resolves the
    product, reads its stored panel, and derives `per_basis` **the same way a meal
    is costed** (§ Nutrition panel: scale from the serving basis, per field).
    A product whose panel is missing a field contributes *unknown* to that field,
    never zero. **A product is a catalog row, not stock** — this form does not
    bind to inventory, so on a `--cook` sheet it is marked accordingly
    (§ An unbound component is VISIBLE, never indistinguishable).
  - `--component-item <item-ulid>=<grams>` — same, resolved through an inventory
    item to its linked product, so a sheet can be written against what is actually
    on hand, **and binds the component to that item's stock** for `--cook`
    (§ Eaten sheets decrement their sources).
  - `--component-unit <item-ulid>=<units>` — the counted form: the item is
    quantified in whole UNITS rather than grams (§ Eaten sheets decrement their
    sources § The basis rule), and the panel is scaled per unit rather than per
    gram. Below extends this to items with no linked product.
  - `--recipe <ulid>` — seed components from a recipe's lines.
  - `--cook eaten` | `--cook packed [--units N] [--shelf-life <class>]
    [--source <item-ulid>[:amount]]…` — the domain vocabulary lives **here**,
    where it means something, and is emitted into the definition's `cook_mode`.
  - `--step <text>` (repeatable) — instructions rendered under the table.
- **Output**: the published page URL, plus the definition's derived totals at the
  planned quantities so the author can sanity-check before sending it.
- **Publishing creates nothing in the ledger.** A definition is a form awaiting a
  real event; inventory moves only when the submission lands (§ Cook mode). This
  is the same rule that forbids logging a meal at plan time.

### A derived component resolves through its recipe, not a product

`--component-item` / `--component-unit` first try to resolve through the named
item's linked `product_ulid`, above. An item carrying **no product** is not
automatically unusable: a **derived** item — the output of a `packed` batch
(§ Conversions) — has no product *by construction* (§ Conversions: "It has no
`product_ulid`"), and its macros live instead in its `derived_from.recipe_ulid`
provenance, the same channel § Consume from inventory § Eligibility reads to
make a derived item one-tap consumable. A sheet component resolves through
that channel rather than refusing outright, so the loop this section exists to
close reaches prepped stock too — hard-boiled eggs, a jar from a batch — not
only purchased stock (claude-assist#199).

- **Only a COUNTED derived item resolves this way.** The per-unit recipe
  contract (§ Consume from inventory § Macro inheritance) guarantees a
  counted item's linked recipe describes exactly **one sealed unit** — the
  same basis a counted sheet component needs, computed the identical way
  (`computeRecipeMacros`, no quantity override, so every ingredient
  contributes its own `default_qty_g`) so the sheet and `consume` can never
  disagree about what one unit of the batch costs. A component naming such an
  item must be `--component-unit` (`counted: true`); `--component-item`
  (grams) against a derived item is refused rather than resolved, because a
  derived item carries no product and therefore no `net_content_g` to divide
  a stated gram amount by — the same refusal `consumeStatedAmount` would hit
  at submit time, surfaced earlier, at publish time, instead.
- **A fraction-modeled derived item's recipe describes the WHOLE BATCH**, not
  one unit (§ Consume from inventory § Macro inheritance) — there is no
  absolute per-100g basis to anchor a sheet's stated-grams model to, and a
  sheet has no analog of `consume`'s single all-or-nothing tap. Such an item
  is refused, same as one with no recipe at all: **refuse, never infer**
  extends here exactly as § The basis rule states it for purchased stock.
- The recipe is resolved across the **same merged (sheet + pushed + promoted)
  universe** `consume` reads (§ Consume from inventory § Eligibility) — a
  DB-only lookup here could accept or refuse a recipe differently than
  `consume` does for the very same item, and the two surfaces must agree on
  what counts as a usable one.
- `per_basis` for a resolved unit is the recipe's computed total **× 100**:
  the worksheet's basis is fixed at 100 regardless of what a component
  measures in, so `quantity/100 * per_basis` must equal `quantity * (one
  unit's total)` for `quantity` units — unlike a product's per-100g panel,
  the recipe total needs no further scaling by a per-unit mass, because it
  already *is* one unit's whole macros.

### Where the logic lives: `POST /kitchen/prep`, not the CLI

**The command is a thin veneer over one endpoint**, like every other command in
§ Agent tooling. Resolving products, deriving `per_basis`, and building the
definition happen in the module, because that is where the catalog is and where
the panel semantics are already defined. A CLI that assembled definitions itself
would be a second implementation of the same rules, reachable only from a shell.

The publish goes through **core's `PagePublisher` seam** (`fastify.pages`), read
at request time and 503-ing when the pages module is absent — the same optional
decorator shape the session-spawn seam uses. That interface accepts *either*
authored HTML *or* a worksheet definition, validated and rendered by the pages
module's own single implementation, so a definition built here is treated
identically to one posted over HTTP.

**This is the exact mirror of cook mode.** A submission travels pages → kitchen
through an injected `worksheetCookSink`; an authoring request travels kitchen →
pages through an injected `PagePublisher`. Neither package imports the other, and
the server composes both. Dependencies still point one way in the sense that
matters: **the pages module never learns a domain's vocabulary**, while a domain
may reach a generic publishing interface.

The pages CLI likewise stays generic (`specs/modules/pages.md` § The CLI carries
no domain vocabulary) — `publish-worksheet` remains the floor beneath this
command, for surfaces no domain owns.

## Eaten sheets decrement their sources

**The depletion matcher exists, but it never sees a stated panel.** An earlier
revision of this section claimed no matcher had ever been built. That was wrong:
§ Depletion matcher is real and wired, and it decrements on-hand stock for
entries that reach terminal `estimated` *through the estimation pipeline*.

What it never sees is a **directly-stated** entry. A worksheet submission is born
`manual` and terminal with no estimation pass — deliberately, so nothing can land
later and clobber the numbers the cook watched add up (§ Cook mode). No
estimation job means the `onEntryEstimated` hook never fires, so the one path
that could have depleted stock is the one path a measured meal structurally
cannot take. **The most precisely-known meals were the only ones that subtracted
nothing.**

The consequence is the same either way: quantities drift high at a rate
proportional to how much the owner actually cooks. Two live instances — a
frozen-fruit bag read 24% on the day it was emptied, and a 6-egg batch read 6
after one was eaten.

A cook-mode **`eaten`** submission therefore decrements the stock its components
name. The sheet is the only artifact that knows *both* what was eaten and how
much, at the moment it is known — so it is the only place the loop can close
without asking the owner to remember anything.

### A packed batch's sources follow the submitted weights

`packed` accepts an explicit `sources` list, fixed when the sheet is published.
For a source that is *also* a component — the usual case, since a batch cooks
the very stock it decrements — that is wrong by construction. **The sheet exists
to collect corrected weights, and a publish-time amount cannot see them.** A
sheet whose intro says "correct the dry weight if your cup isn't 200 g" will
faithfully record 220 g in the panel and still decrement 200 g from the bag.

So a packed sheet binds its sources the same way an eaten one does: **a
component-bound source decrements the quantity the human actually submitted.**
Explicit `sources` remain, unchanged, for inputs that are genuinely not
components — water, a splash of oil, anything the sheet does not weigh.

This stays exactly one atomic write. The bindings are resolved into concrete
source amounts *before* the conversion is planned, so the decrement and the
derived item still land in one transaction — unlike `eaten`, where depletion
follows the entry and is best-effort.

**A sheet must declare whether its components describe one unit or the whole
batch.** A farro sheet weighs the whole pot and yields three portions; an
oat-jar sheet weighs one jar and yields three jars. Identical `units: 3`,
opposite decrements — 200 g of farro once, versus 40 g of oats three times.
Nothing in the component quantities distinguishes them, so the sheet states it
(`components_per: 'batch' | 'unit'`, defaulting to `batch`) and the decrement is
`quantity x units` only when the sheet says `unit`.

Inferring this would be the batch-yield failure again: a per-unit sheet silently
read as per-batch under-decrements by exactly the unit count, which is precisely
the drift this whole section removes.

### The basis rule: refuse, never infer

A component decrements only when its item carries an honest basis:

| item model | sheet collects | decrement | basis required |
| --- | --- | --- | --- |
| divisible (fraction) | grams | `grams / net_content_g` -> fraction | product `net_content_g` |
| **counted** | **units** | integer units | product `unit_edible_g` (for the panel) |

**A counted component is stated in UNITS, not grams.** One egg, one can, one
link. That removes the conversion entirely on the decrement side, and it is how
a human describes the food anyway. Its *panel* still needs a mass, which is
`units * unit_edible_g` — the same gate that already governs one-tap consume.

**Never derive a missing basis.** `unit_edible_g` remains STATED-only: a net
weight divided by a count can be wrong in either direction (drained vs packed
weight, shell vs edible), and a plausible wrong denominator is worse than none —
it is the batch-yield failure (§ Conversions) in a new place.

### An unbound component is VISIBLE, never indistinguishable

`--component <product-ulid>` and `--component-item <item-ulid>` accept nearly
identical syntax and render as the same kind of row, but only the second binds
to stock — a product is a catalog row, not stock, so a `--component` row has no
`consumes` binding to decrement in the first place (§ The basis rule above only
governs a binding whose *basis* is missing; this is the row with no binding at
all). Both forms were accepted on a `--cook eaten` sheet with no distinction at
publish time, and the two resulting sheets were **indistinguishable** — same
table, same submit, same "logged" confirmation — which is exactly how a real
sheet logged a correct journal entry and moved no stock at all, an error caught
only days later by hand-counting the physical items (claude-assist#207).

**The gap is made visible, not refused.** Refusing a `--component` row on a
`--cook` sheet would be defensible by the same logic that refuses a product
with no stored panel rather than guessing one (§ Authoring a prep worksheet
above) — except it would also refuse two cases that are not errors:

- **Eating something that genuinely is not tracked as stock** — a restaurant
  meal, a gift, a sample — where the product record exists (so the panel is
  real, not recalled) but there is no item to bind to and never will be.
- **Every `--recipe`-seeded row**, which carries its `per_100g` inline from the
  recipe with no product or item reference at all (§ Authoring a prep worksheet)
  — refusing "no binding" would refuse every recipe-seeded `--cook eaten` sheet
  that has ever worked, not just the one this section is about.

So the module extends the doctrine § An unapplied decrement is VISIBLE, never
silent already establishes for a binding with no basis, one step earlier: a
`--component` row on a `--cook` sheet carries a note — rendered directly under
its label on the page itself, the same place any other component note renders
— stating that it is not tracked in stock and will not decrement. The CLI
reply names the same rows under `untracked_components`, so the author sees it
at publish time, not by hand-counting stock days later. A `--component-item` /
`--component-unit` row, and every recipe-seeded row, carries no such note —
only a component that *could* have bound and didn't gets marked.

### An unapplied decrement is VISIBLE, never silent

When the basis is missing, the decrement does not happen and **the submission
says so**. The intended decrement is recorded against the entry and surfaced
through the same question queue as § Unreviewed entry notes.

This is the module's standing preference: a gap the owner can see beats a gap
papered over. Silently skipping would reproduce exactly the drift this section
exists to remove, while *looking* like it had been fixed.

### The entry is authoritative; decrements are not allowed to block it

Cook mode's one-write-per-disposition rule is relaxed here in one direction
only: the journal entry lands **first and unconditionally**, and decrements are
applied after. A decrement that fails — missing basis, an item since closed, a
concurrent edit — is reported, never rolled back onto the meal.

Rationale is `specs/diet-journal.md` § Principles: **logging must beat
not-logging.** A meal that refused to record because a fruit bag had no net
weight would be a strictly worse ledger than one that records the meal and flags
the unapplied decrement. Inventory is reconcilable after the fact; an unlogged
meal is gone.

## Unreviewed entry notes

A cook-mode submission may carry a free-text note, and that note routinely names
something the computed panel does not account for — a condiment, a splash of oil,
an extra the component list never anticipated. The note is preserved on the entry,
so the *record* is honest, but the **totals silently are not**.

**Structured "extras" input is the wrong fix.** Nobody reaching for a bottle stops
to name and weigh a new component; an input built for that would be ignored, and
the silent gap would persist behind a feature that looks like it closed it.

So the module makes the gap **visible** instead of trying to prevent it:

- Entries carry **`notes_reviewed`** (boolean, default `false`). An entry whose
  note arrived from a human — a submission note, or a note supplied on `log` /
  `patch` — starts unreviewed. An entry with no note is not unreviewed; it has
  nothing to review.
- **`entries questions`** lists unreviewed-note entries, mirroring
  `inventory questions` for needs-info items. One vocabulary for "a human said
  something the ledger hasn't reconciled", not two.
- The **home view's open-question count includes them**, so a session opening cold
  sees the backlog without asking for it — the same mechanism that surfaces
  needs-info stock.
- **`entries review <ulid>`** marks it reviewed. Correcting the panel is a
  *separate* act (`patch` with macro flags): reviewing records that a human looked,
  not that anything changed. Most extras are immaterial and the honest outcome is
  "seen, costs nothing."

This deliberately resolves asynchronously. The eater is not taxed at eat time —
which is the same trade cook mode itself makes, and the reason the loop closes at
all.

## Agent tooling — `kitchen-axi` CLI + `assist-kitchen` skill

The module ships the same agent-facing tooling pair the older modules do
(sessions/gmail/pages): a token-efficient CLI and a hand-authored skill that
bundles it, so any agent session — interactive, chat, or scheduled — can read
and write the kitchen without hand-rolled `curl`.

- **`kitchen-axi`** (`packages/kitchen/src/axi/`, bundled per the repo's axi
  build): TOON-table output, `--json` escape hatch, server resolved from
  `CLAUDE_ASSIST_SERVER` (default localhost) + bearer auth per the sibling
  CLIs' convention. Invoked bare it prints the **home view**: today's entry
  count + effective totals, pending-estimate count, the top eat-first items,
  and the open needs-info question count — the at-a-glance state an agent
  needs before acting.
- **Command surface** (each a thin veneer over one documented endpoint — the
  CLI adds no semantics the API lacks):
  - `entries` — list (since/limit), `show <ulid>`, `log` (note and/or
    `--recipe` + component quantities, optional `--at` to set `logged_at`;
    the deliberate no-model path), `patch <ulid>` (note/label re-queue, macro
    override, portion multiplier, `--at` to backdate `logged_at` — a metadata
    edit like the multiplier: never re-queues estimation, never changes
    source), `resolve`-style close-outs are NOT here (entries have no such
    state); `delete <ulid>`.
    - **`log` and `patch` expose the SAME nine macro flags** — the full panel
      (§ Nutrition panel), one flag per field, documented identically on both.
      A field that can be logged but not corrected has no correction path at
      all: `delete` + re-`log` mints a new ULID and destroys the entry's
      identity for everything referencing it. The flag list and the two usage
      strings derive from one source so the pair cannot drift apart again.
  - `inventory` — list (eat-first order; `--state`, `--closed`),
    `show <ulid>`, `add` (manual/seed create; `--units-total` makes it a
    counted item, `--unit-seal` states what its package seals),
    `event <ulid> <opened|finished|finished-unit|tossed|moved>
    [--fraction] [--to <class>]` (`moved --to` is the storage move —
    § Storage moves), `remark "<free text>"` (the resolver; prints
    matched/unmatched honestly), `questions`, `convert --from
    <ulid>[:amount]… --to '<derived spec json>'` (prep transform — see
    § Conversions), `consume <item-ulid> [--quantity N] [--at DATE]
    [--ulid ENTRY_ULID]` (the one-tap known-macro log + deplete — see
    § Consume from inventory; the agentic path until the app's consume shelf
    ships), `recount <ulid>` (§ Reconcile), `dismiss <ulid>
    [--non-inventory]` (retire a record that was never real stock —
    § Non-inventory dismissal), `merge <ulid> --into <ulid>` (fold a duplicate
    item into a survivor — § Item corrections).
    - **Every state an item can reach is reachable and enumerated from the
      CLI's own help.** The `event` verb covers four transitions and
      `dismissed` is not one of them (it has its own endpoint, its own body,
      and its own response shape), so an agent reading only the event enum
      concludes `dismissed` is not a state at all — and reaches instead for
      `finished`, which *misrepresents* (it claims a consumption) and makes the
      item terminal so the correct verb then `409`s. `inventory --help`
      therefore enumerates all five states with the verb that reaches each,
      including resurrection via `recount --state`, and `event … dismissed` is
      refused with a pointer to `dismiss` rather than an enum error. A
      retirement path that exists but cannot be found is, for an agent, a
      retirement path that does not exist.
    - `waste [--since DATE] [--until DATE]` — the costed toss log
      (§ Waste costing), including its honest unknown-cost rows.
  - `receipts` — list, `show <ulid>` (batch + line outcomes), `scan <photo…>`
    (multipart post; meta as a form field per the module's part-type rule).
  - `recipes` — list (merged view), `push` (agent-authored recipe JSON;
    **upserts**, optional `--ulid` to replace a specific record — § Recipe
    corrections), `delete <ulid>` (archives — the retirement path, not a
    destroy), `promote <entry-ulid> --name`.
  - `products` / `lexicon` — list/search + seed-grade create (the agentic
    seed path), plus `products prices <ulid> [--store S]` — the per-product
    price history with its per-point unit normalization (§ Price history).
- **`assist-kitchen` skill** (`skills/assist-kitchen/`): hand-authored
  SKILL.md with generated command-reference regions (build-skill splice
  targets registered like the others; `check:skills` guards drift). The
  narrative must carry the module's decisive rules an agent needs at write
  time: base-vs-effective multiplier semantics, macro-override terminality,
  partial-toss fraction meaning, the deliberate-action-vs-classifier
  boundary, and photos-are-ephemeral.
- **Boundary**: the CLI and skill are generic toolkit surfaces — no instance
  names, no owner identity; instance wiring (install, hooks, chat command
  lists) is the operator's concern, outside this repo.

## Principles

- **A ballpark now beats precision later.** Single-call estimates, no food-DB
  lookups in v1; the longitudinal record is the value. Don't add friction in
  pursuit of accuracy.
- **Deterministic beats estimated when quantities are known.** Recipe-computed
  macros never go through a model; a kitchen-scale user's numbers are exact by
  construction. The same holds for **time**: `logged_at` comes from a concrete
  source (EXIF capture time, or the owner's explicit pick) and is never
  model-inferred — the model owns PORTION, never the clock (§ Logged-at
  backdating).
- **The owner's correction is terminal.** `manual` overrides survive every
  subsequent automated pass.
- **Store the base; carry the base; consumers multiply.** Macro fields are always
  the base — in the DB and on the wire. Effective is `base × portion_multiplier`,
  computed at every serving surface, never pre-baked into the stored/transmitted
  fields. This keeps the multiplier idempotent (always rescales from base) and the
  wire unambiguous (a macro field never silently means something scaled).
- **Count tracks discrete units; fraction tracks divisible stock.** The
  discriminating test for how an inventory item models its on-hand quantity:
  *can you consume a non-integer amount of it in one sitting?* Yes → it's
  divisible, use a fraction (a tub, bag, jar, bottle). No, it comes as discrete
  units → use an integer count (a can multipack, an egg dozen, a sausage-link
  pack, a sliced loaf). A counted item is still ONE row — the count
  model is not a fan-out — and consumption of it is a whole-unit decrement
  (`finished-unit`). A
  directional fraction is an acceptable stand-in until an item is known to be a
  multipack, but a fraction stored against a counted pack (e.g. `0.67` for "2 of
  3 cans left") is a lossy approximation of "N whole units left," not the
  truth — receipt intake seeds the count model directly whenever the package
  size carries a discernible count, so this shouldn't need correcting after the
  fact. **Counting and being openable are independent axes, not alternatives.**
  Whether the count's units are *individually sealed* (opening one leaves the
  rest at the unopened window) or share *one container seal* (opening puts the
  whole remainder on the opened clock) is a second fact, `unit_seal` — and
  neither answer is the general case, so it is recorded rather than assumed.
  Forcing a choice between "keep the count" and "keep the opened clock" throws
  away something true either way.
- **An item's state must be able to express what is physically the case.** When
  it can't, the ledger doesn't merely lose detail — it asserts something false,
  and the direction of the falsehood matters more than its size. Under-reporting
  urgency (a thawed protein still recorded frozen, a sliced loaf still recorded
  sealed) is the failure this module exists to prevent, so the model gains a fact
  rather than leaning on a note or a plausible-looking workaround. The
  corollary for verbs: **a correction and an event are never substitutes.** An
  event says something changed on a date; a correction says the record was always
  wrong. Reaching for one because the other is unavailable writes a fiction that
  reads as truth — which is why the reconcile surface reaches every field
  observation can settle, and why a storage move is its own event rather than a
  clever `opened_at`.
- **Packing is a conversion; eating is an entry.** Preparing food creates *stock*
  — it belongs in inventory with its own clock and provenance, not in the
  journal. Consumption is recorded when it is consumed, at the share actually
  eaten. Pre-logging a batch at prep time makes the journal lie the moment plans
  change (the batch gets shared, frozen, split across days, or tossed), and it
  lies in the direction nothing flags: the day already looks accounted for. Every
  surface that records prep — the `convert` verb, cook mode, the app's tabs —
  holds this line, so "did I log this?" has exactly one answer per act.
