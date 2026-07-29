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
  reference with per-component quantities, optional inventory-item links (phase 2).
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
`{ expenditures, count }`, `DELETE /kitchen/expenditures/:ulid`.

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
  the nutrition panel).

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

**Anti-scope.** Unchanged from § Expenditure & net energy: just enough burn
to compute the balance — no routes, laps, splits, gear, or kudos. Strava
remains the exercise system of record; this feed carries numbers, not
activities.

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
  sodium_mg, fiber_g, sugar_g}`, any field null = unknown; nullable),
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

  **Net content (§ Prices' divisor).** The label scan also transcribes the
  package's printed net content as a raw `{value, unit}` pair (e.g. `454 g`,
  `64 fl oz`); **deterministic code** converts to `net_content_g` /
  `net_content_ml` (numeric, nullable — grams for weight-stated packages,
  ml for volume-stated; oz/lb/L conversions in code, never model
  arithmetic). This is the per-gram denominator for cost reads
  (`price_cents ÷ net_content_g`); `package_size` stays the verbatim
  display string it always was. `servings_per_container × serving_size_g`
  remains a directional fallback when no net content was legible.

  **The needs-nutrition signal**: an inventory item whose *linked product*
  carries no `nutrition_per_100g`, or a panel with any of the nine fields
  null, is flagged `needs_nutrition: true` on every item view (`GET
  /inventory`, CLI list, the app) — a label rescan is the resolving action.
  Distinct from `needs_info` (a scanned line with NO product match); an
  unlinked item is never double-badged. This is the loop that keeps
  recipe/consume macros from going null in the first place.

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
- **`kitchen.inventory_items`** — one physical unit: `ulid`, `product_ulid`
  (nullable — null while `needs_info`), `raw_label` (text — the receipt line or
  display name when no product; nullable), `store` (nullable), `batch_ulid`
  (nullable), `state` (enum `stocked | open | finished | tossed | dismissed`),
  `on_hand_fraction` (numeric 0..1, directional; default 1.0), `units_total` /
  `units_remaining` (integer, both nullable, migration
  `007-kitchen-inventory-units-and-derivations.sql` — the **sealed-unit count
  model**, see § count-vs-fraction below; both null (the default) means the
  item is fraction-modeled, unchanged; both set together, never one without the
  other, `0 <= units_remaining <= units_total`), `needs_info`
  (bool), `acquired_at` (date), `opened_at` (date, nullable), `closed_at` (date,
  nullable — finished/tossed/dismissed date), `eat_by` (date, nullable — **derived**,
  materialized for ordering; recomputed on open), `shelf_life_class` (enum
  snapshot, nullable), `notes` (nullable), `created_at`, `updated_at`.
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
  spend analysis, budgets, and price-history reads are consumers (the
  personal-finance domain / agent judgment) — the module keeps no derived
  price tables. Because a product link exists per line via the lexicon,
  per-product per-store price history is derivable at read time for free.

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
`unknown` (null, null — no eat-by until known). `eat_by` =
`opened_at + opened_window` when opened, else `acquired_at + unopened_window`;
product-level day overrides win over the class default; `unknown` (and any null
window) yields `eat_by = null`.

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
`{stocked,open} --tossed--> tossed`, `{stocked,open} --dismissed--> dismissed`.
`finished`/`tossed`/`dismissed` are terminal. Opening
stamps `opened_at` and re-derives `eat_by` — always from the **effective**
opened date (the original `opened_at` when one exists: a re-open is an
idempotent no-op and must not extend the window) and always folding in the
linked product's precise day-window overrides (every clock re-derivation —
open, finished-unit revert, reconcile — goes through one helper so overrides
are never silently dropped). Finishing stamps `closed_at` and
sets `on_hand_fraction` to 0. `finished-unit` (counted items only — see
§ count-vs-fraction below) shares `finished`'s legal preconditions
(`{stocked,open}`, terminal-rejecting), but its CONCRETE next state is
data-dependent (zero remaining → terminal `finished`; otherwise back to
`stocked` with a fresh clock) — computed by the pipeline, not the pure
transition table.

`dismissed` is the "this line does not belong in inventory at all" terminal
state (see § Non-inventory dismissal). It is deliberately **not** a food-waste
outcome: unlike `tossed`, dismissing stamps `closed_at` but appends **no**
`tossed …` note and leaves `on_hand_fraction` untouched, so a dismissed soup mug
never enters waste/tossed telemetry. A new terminal state (rather than a
`DELETE`) is chosen because it mirrors the existing `finished`/`tossed` terminal
idiom exactly — the row is retained for provenance (its batch line still points
at it, a receipt replay stays idempotent), it drops out of the default on-hand
list and the questions queue by the same state-filter mechanics the other
terminals use, and it needs no orphan-cleanup of the referencing batch line.

Tossing takes an optional **amount tossed**
(fraction 0..1): a partial toss decrements `on_hand_fraction` and keeps the
item's state alive (directional — it self-heals at the next event); the item
only transitions to terminal `tossed` (with `closed_at`, fraction 0) when no
fraction is supplied (full toss) or the remainder reaches zero. Every toss
appends `tossed <amount> <date>` to the item's `notes` so waste amounts stay
recoverable for telemetry. These semantics are shared verbatim by the explicit
event endpoint and the free-text resolver. A full toss or whole-item `finished`
on a counted item also zeroes `units_remaining` — the sealed remainder is gone
too.

### Unit counts (§ count-vs-fraction)

A discrete multipack of individually-sealed atomic units (a can 3-pack, an egg
dozen, a sausage-link pack, a yogurt 4-pack) tracks `units_total`/
`units_remaining` instead of `on_hand_fraction`, as **one row** — no fan-out
per sealed unit (that fan-out mechanism is a different axis: N *bought* units
of a product each already become their own item row per the receipt line's
`quantity`; any one of those rows may itself be a multipack with its own
`units_total`). Opening a counted item behaves exactly like opening a
fraction-modeled one — `opened_at` stamps and `eat_by` re-derives from the
opened window — because opening means "I broke the seal and am now consuming
from one unit"; only that one open unit runs the perishable clock, and the
still-sealed remainder is shelf-stable at the unopened window regardless.

The counted sibling of `finished` is the **`finished-unit`** event (`POST
/inventory/:ulid/events` with `type: 'finished-unit'`, no `fraction`) — an
integer decrement of `units_remaining` by exactly one:

- **Counted items only.** A `finished-unit` event against a fraction-modeled
  item (`units_total` null) is rejected (`400`, `NotCountedItemError`) — use
  `finished`/`tossed` there.
- **Reaching zero remaining** transitions the item to terminal `finished`
  (`closed_at` stamped, `on_hand_fraction` zeroed) — identical outcome to a
  whole-item `finished`.
- **Otherwise** the item reverts to `stocked`, `opened_at` clears, and `eat_by`
  re-derives from the **unopened** window off `acquired_at` — the unit that was
  just finished carried the opened clock, but the next-to-open unit was never
  itself opened, so it starts its own (unopened) clock, not a continuation of
  the just-finished unit's.

Receipt-scan seeding: when a lexicon line's (or its mapped product's)
`package_size` carries a discernible count ("3 ct", "12-pack", "6 pk", "dozen"
→ 12, "half dozen" → 6; a plain size like "16 oz" carries none), each
fanned-out item from that line is seeded `units_total = units_remaining =` the
parsed count instead of the default fraction of 1. A count of 1 ("1 ct")
describes a single unit, not a multipack, and is left fraction-modeled.

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
  `finished`/`tossed` *event*, not a correction.
- **It can resurrect a mis-closed item**: an explicit `state:
  'stocked'|'open'` on a terminal item reopens it and clears `closed_at`. A
  terminal item with no explicit state is rejected (the caller must own the
  resurrection).
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
`POST /inventory/:ulid/events` → `InventoryItem`; `POST /products` → `Product`;
`POST /lexicon` → `LexiconLine`); list reads return a named plural + `count`
(`{ batches, count }`, `{ items, count }`, `{ questions, count }`,
`{ products, count }`, `{ lines, count }`); compound reads/results return named
objects (`GET /receipts/:ulid` → `{ batch, lines }`; label →
`{ item, product }`; free-text resolver → `{ matched, item?, event? }`;
`POST /inventory/convert` → `{ sources, derived, derivation }`;
`POST /inventory/:ulid/consume` → `{ entry, item, created }`). The
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
  state?, needs_info?, shelf_life_class?, notes? }`. `units_total` makes it a
  **counted** item (`units_remaining` starts equal to it); omitted stays
  fraction-modeled — see § count-vs-fraction. ULID optional (server-generates
  when absent); idempotent when supplied. Returns the **bare** `InventoryItem`
  (`201`/`200`).
- `POST /inventory/:ulid/events` — explicit state change. JSON
  `{ type: 'opened'|'finished'|'finished-unit'|'tossed', fraction? (0..1), at? (ISO date) }`.
  `fraction` semantics per type: `opened` — absolute remaining fraction
  (omitted = unchanged); `tossed` — **amount tossed** (partial toss decrements
  and stays alive; terminal only at zero remainder or when omitted, per the
  state-machine rules above); `finished` ignores it (always terminal + zeroed,
  and zeroes `units_remaining` too on a counted item); `finished-unit` ignores
  it (see § count-vs-fraction — integer one-unit decrement, counted items
  only). Returns the **bare** updated `InventoryItem`. `404` unknown item;
  `409` `InvalidTransitionError` on a terminal item; `400`
  `NotCountedItemError` for `finished-unit` against a fraction-modeled item.
- `PATCH /inventory/:ulid` — **reconcile** (§ Reconcile — correction, not
  consumption). JSON, at least one of `{ on_hand_fraction (0..1, exclusive
  0), units_total (int ≥1 | null), units_remaining (int ≥1 | null), state
  ('stocked'|'open'), opened_at (ISO date | null), notes }`. Applies the
  § Reconcile rules: clocks never inferred, `eat_by` re-derived from
  corrected truth with product overrides, `units_total` reclassifies the
  unit model (null reverts to fraction), explicit `state` may resurrect a
  terminal item (`closed_at` clears), and an audit line is appended to
  `notes`. Returns the **bare** updated `InventoryItem`. `404` unknown item;
  `400` `ReconcileValidationError` (contradictory or ineligible correction —
  e.g. `stocked` with an `opened_at`, zero quantities, a fraction on a
  counted item) or `NotCountedItemError` (`units_remaining` on a
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
- `POST /inventory/convert` — **conversion (prep transform)** event, see
  § Conversions. JSON `{ sources?: [{ item_ulid, amount? }], derived: { name,
  shelf_life_class?, on_hand_fraction?, units_total?, store?, notes?,
  acquired_at?, recipe_ulid? }, at? (ISO date) }`. `sources` is **optional**
  (`[]` or omitted → a source-less conversion that decrements nothing,
  § Source-less conversions); when present, each
  `amount` is interpreted per that SOURCE's own on-hand model — a whole-unit
  integer for a counted source, a fraction (0..1) for a divisible one; omitted
  fully consumes the source (all remaining units, or the whole remaining
  fraction). `derived`: `name` required; exactly one of `on_hand_fraction` /
  `units_total` describes the new item's quantity model (defaults to a whole
  fraction-modeled item, `on_hand_fraction: 1`, when neither is given);
  `recipe_ulid` is optional provenance only (no macro computation in this
  surface — but it is what makes the derived item consume-eligible, § Consume
  from inventory § Eligibility). Decrements every source given (reaching zero on
  any source terminates it `finished`, mirroring `finished-unit`/full-toss) and
  creates ONE new `stocked` item with its own `eat_by` (derived the same way a
  fresh item's is) and a `kitchen.inventory_derivations` row linking it to its
  sources (empty when source-less).
  Returns `{ sources: InventoryItem[], derived: InventoryItem, derivation:
  InventoryDerivation }` (`201`). `400` `ConversionValidationError` —
  missing `derived.name`, an unknown source ULID, or a non-integer
  `amount` against a counted source; `409` `InvalidTransitionError` — a source
  is already terminal (nothing left to spend).
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

Products & lexicon (agentic seed + reads):

- `POST /products` — JSON `{ name (required), shelf_life_class?, aliases?,
  nutrition_per_100g?, ingredients?, package_size?, shelf_life_days_unopened?,
  shelf_life_days_opened? }` → `Product` (`201`).
- `GET /products?q&limit` → `{ products: Product[], count }` (`q` = substring
  over name/aliases).
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
  batch_ulid, state, on_hand_fraction, units_total, units_remaining,
  needs_info, acquired_at, opened_at, closed_at, eat_by, shelf_life_class,
  days_until_eat_by, age_days, notes, derived_from, created_at, updated_at }`.
  `product_name` is the joined product name (falls back to `raw_label`);
  `days_until_eat_by`/`age_days` are derived integers (null when
  undeterminable). `units_total`/`units_remaining` are both null for a
  fraction-modeled item (§ count-vs-fraction). `derived_from` is null unless
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
  ingredients, package_size, shelf_life_days_unopened, shelf_life_days_opened,
  created_at, updated_at }`. `nutrition_per_100g` (nullable) is `{ calories,
  protein_g, fat_g, sat_fat_g, carbs_g, sodium_mg, fiber_g, sugar_g }` (any
  field null = unknown); `ingredients` is the printed ingredients list (nullable
  text).
- **LexiconLine**: `{ ulid, store, line_text, product_ulid, package_size,
  shelf_life_class, non_inventory, created_at, updated_at }`. `product_ulid` is
  null on a non-inventory skip marker (`non_inventory: true`).
- **Question**: `{ item_ulid, item_ulids, count, raw_label, store, acquired_at,
  question }`. `item_ulid` is the representative (earliest-acquired) item to
  target for a label scan or dismissal; `item_ulids` are all items the grouped
  question covers; `count` is `item_ulids.length`. `question` renders the
  count when `count > 1` (e.g. `… ×2`).
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

**Eligibility.** An item qualifies only when its derivation provenance
(`derived_from.recipe_ulid`, written by the `convert` that created it) resolves
to a recipe — DB-persisted (`pushed`/`promoted`) or meal-bank sheet-sourced,
the same merged universe the reselect strip serves — carrying at least one
component. This is the ONLY macro-inheritance channel today: a raw item with
no recipe-linked derivation has no deterministically-known macros and is
rejected (`400 ConsumeIneligibleError`) — it needs the normal photo/reselect
path, not one-tap consume. An already-terminal item is rejected regardless of
eligibility (`409`, checked first, mirroring `convert`'s terminal-source
check).

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
  terminal `finished` (identical outcome to a whole-item finish); otherwise
  the item reverts to `stocked` with `opened_at` cleared and `eat_by`
  re-derived from the **unopened** window off `acquired_at` — same rule as
  `finished-unit`, since the unit just consumed carried the opened clock but
  the next-to-open unit never itself opened.
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
composing two separate store calls at the service layer — the gap `convert`
still has (three separate, non-transactional writes: each source's decrement,
the derived item's insert, and the derivation's insert), flagged in its own
review and deliberately NOT repeated here. `kitchen.entries` and
`kitchen.inventory_items` are each owned by their own store interface for
testability everywhere else in the module; this is the one path that
deliberately crosses that boundary, and it exists only for this requirement.

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
    counted item), `event <ulid> <opened|finished|finished-unit|tossed>
    [--fraction]`, `remark "<free text>"` (the resolver; prints
    matched/unmatched honestly), `questions`, `convert --from
    <ulid>[:amount]… --to '<derived spec json>'` (prep transform — see
    § Conversions), `consume <item-ulid> [--quantity N] [--at DATE]
    [--ulid ENTRY_ULID]` (the one-tap known-macro log + deplete — see
    § Consume from inventory; the agentic path until the app's consume shelf
    ships).
  - `receipts` — list, `show <ulid>` (batch + line outcomes), `scan <photo…>`
    (multipart post; meta as a form field per the module's part-type rule).
  - `recipes` — list (merged view), `push` (agent-authored recipe JSON;
    **upserts**, optional `--ulid` to replace a specific record — § Recipe
    corrections), `delete <ulid>` (archives — the retirement path, not a
    destroy), `promote <entry-ulid> --name`.
  - `products` / `lexicon` — list/search + seed-grade create (the agentic
    seed path).
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
- **Count tracks sealed units; fraction tracks divisible stock.** The
  discriminating test for how an inventory item models its on-hand quantity:
  *can you consume a non-integer amount of it in one sitting?* Yes → it's
  divisible, use a fraction (a tub, bag, jar, bottle). No, it comes as
  individually-sealed atomic units → use an integer count (a can multipack, an
  egg dozen, a sausage-link pack). A counted item is still ONE row — the count
  model is not a fan-out — and consumption of it is a whole-unit decrement
  (`finished-unit`); only the currently-opened unit runs the perishable clock,
  the sealed remainder is still shelf-stable at the unopened window. A
  directional fraction is an acceptable stand-in until an item is known to be a
  multipack, but a fraction stored against a sealed pack (e.g. `0.67` for "2 of
  3 cans left") is a lossy approximation of "N whole units left," not the
  truth — receipt intake seeds the count model directly whenever the package
  size carries a discernible count, so this shouldn't need correcting after the
  fact.
