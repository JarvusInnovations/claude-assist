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
  (`sheet` | `pushed` | `promoted`), created/updated stamps. Sheet-sourced
  recipes are read-through projections of the configured meal-bank gitsheet —
  the module never writes the sheet.
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

**Base vs effective — the wire rule.** The entry's stored macro fields
(`calories`, `protein_g`, `fat_g`, `sat_fat_g`, `carbs_g`, `sodium_mg`) are the
**base**: the amount as estimated, recipe-computed, or manually overridden. The
entry wire shape (POST / GET / list responses) carries those base fields
**exactly as stored, unscaled**, alongside `portion_multiplier`. **Every consumer
computes effective macros itself: `effective = base × portion_multiplier`.** This
is the one rule, applied everywhere — entry tiles, day-group totals, the briefing
daily totals, and any future macro consumer. The wire never carries pre-multiplied
macros; base-on-the-wire is unambiguous (a macro field always means the base) and
lossless (no division needed to recover the base).

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

## Meal-bank sheet consumption

The module reads a meal-bank gitsheet owned by the instance's own repo:

- Wiring is **instance configuration** — repo path + sheet name via env; no
  source is hardcoded in the toolkit.
- The module **publishes its meal-record contract document** (gitsheets schema
  contract) as its named interface; any sheet satisfying it works. The read
  opens with `contract: { schema, mode: 'verify' }` — rung-1 declared identity
  preferred, structural fallback — and a contract failure is a wiring-time
  refusal, never a mid-read surprise. Until the gitsheets consumer-verify
  surface ships, the module reads plain and flips the option on when available.

## API

All endpoints under `/api/kitchen`. Error envelope and auth follow the server's
existing conventions.

- `POST /entries` — multipart: entry JSON part (ULID, timestamp, note,
  optional recipe ref + component quantities) + 0..N photo parts. Posts
  immediately (`estimating` when photos present and no deterministic source;
  `estimated` when recipe-computed or reselect-cloned). Idempotent on ULID.
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
  recent/frequent logged items.
- `POST /recipes` — agent-pushed one-off or reusable templates.
- `POST /entries/:ulid/promote` — creates a recipe from a logged entry.
- Rollup queries (daily totals, weekly trend) are computed, never stored, over
  **effective** macros (`base × portion_multiplier` per entry); they feed the
  instance's briefing/review renderings.

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
  sodium_mg}`, any field null = unknown; nullable), `package_size` (text, e.g.
  `"16 oz"`; nullable), `shelf_life_days_unopened` / `shelf_life_days_opened`
  (int, label-derived precise overrides of the class default; nullable),
  `created_at`, `updated_at`. A label photo enriches the **product**, not the
  item.
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
- **`kitchen.inventory_items`** — one physical unit: `ulid`, `product_ulid`
  (nullable — null while `needs_info`), `raw_label` (text — the receipt line or
  display name when no product; nullable), `store` (nullable), `batch_ulid`
  (nullable), `state` (enum `stocked | open | finished | tossed | dismissed`),
  `on_hand_fraction` (numeric 0..1, directional; default 1.0), `needs_info`
  (bool), `acquired_at` (date), `opened_at` (date, nullable), `closed_at` (date,
  nullable — finished/tossed/dismissed date), `eat_by` (date, nullable — **derived**,
  materialized for ordering; recomputed on open), `shelf_life_class` (enum
  snapshot, nullable), `notes` (nullable), `created_at`, `updated_at`.
- **`kitchen.purchase_batches`** — one shopping event: `ulid` (client-supplied
  for receipt idempotency), `source` (enum `receipt | manual`), `store`
  (nullable), `purchased_at` (date), `status` (enum `parsing | parsed | failed`
  — the parse work queue, mirrors entry estimation), `parse_attempts`,
  `last_error`, `last_error_at`, `created_at`, `updated_at`.
- **`kitchen.purchase_batch_lines`** — one parsed receipt line: `ulid`,
  `batch_ulid`, `raw_text`, `match_outcome` (enum `matched | unmatched |
  pending | skipped`), `product_ulid` (nullable), `inventory_item_ulid`
  (nullable), `created_at`. `skipped` records a line the parse honored a
  non-inventory lexicon marker for — no inventory item is created, but the line
  is retained (never silently dropped) so the batch stays a faithful record of
  the receipt.
- **`kitchen.entries.inventory_item_ulid`** — added column (nullable, no FK):
  the item a consumption entry depleted (phase-1 "optional inventory-item
  link").

**Shelf-life classes** (enum `kitchen.shelf_life_class`; code owns the
default day windows in `src/inventory-derive.ts`, `(unopened, opened)`):
`pantry` (365, 180), `frozen` (180, 90), `fridge_long` (60, 21), `fridge_short`
(14, 7), `produce` (7, 4), `very_perishable` (3, 2), `unknown` (null, null — no
eat-by until known). `eat_by` = `opened_at + opened_window` when opened, else
`acquired_at + unopened_window`; product-level day overrides win over the class
default; `unknown` (and any null window) yields `eat_by = null`.

**Inventory state machine** (`src/inventory-state.ts`):
`stocked --opened--> open`, `{stocked,open} --finished--> finished`,
`{stocked,open} --tossed--> tossed`, `{stocked,open} --dismissed--> dismissed`.
`finished`/`tossed`/`dismissed` are terminal. Opening
stamps `opened_at` and re-derives `eat_by`; finishing stamps `closed_at` and
sets `on_hand_fraction` to 0.

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
event endpoint and the free-text resolver.

### API

All under `/api/kitchen`. Error envelope `{ error }`, same conventions as
phase 1. Photos are memory-only for the request, never persisted (phase-1 rule).

**Response wrapping is deliberate and contractual, per endpoint** (clients must
not assume one convention): single-resource creates/mutations return the
**bare** row (`POST /receipts` → `PurchaseBatch`; `POST /inventory` and
`POST /inventory/:ulid/events` → `InventoryItem`; `POST /products` → `Product`;
`POST /lexicon` → `LexiconLine`); list reads return a named plural + `count`
(`{ batches, count }`, `{ items, count }`, `{ questions, count }`,
`{ products, count }`, `{ lines, count }`); compound reads/results return named
objects (`GET /receipts/:ulid` → `{ batch, lines }`; label →
`{ item, product }`; free-text resolver → `{ matched, item?, event? }`). The
shape stated on each endpoint below is exact.

Receipts:

- `POST /receipts` — multipart. Meta part **`receipt`** (JSON, accepted as
  either a form field OR a file part, same tolerance as `/entries`):
  `{ ulid (ULID, required), store?, purchased_at? (ISO date) }`. Photo parts
  named **`photo`** or **`photos`** (0..N). Posts a `purchase_batches` row
  immediately (`status: 'parsing'`), idempotent on ULID, and returns the
  **bare** `PurchaseBatch` (`201` created / `200` replay). A detached parse pass runs the cheap receipt
  model (`KITCHEN_RECEIPT_MODEL`) over the photos → line items; each line does
  exact-string lexicon lookup per store; a **non-inventory marker** hit records
  the line `skipped` and creates **no** item (the parse honors the marker); a
  product match creates a `stocked` inventory item stamped with `purchased_at`;
  an unknown creates a `needs_info` item (`product_ulid` null, `raw_label` =
  line text). A multi-quantity line still creates **one item per physical unit**
  (separate open/use lifecycles) — the dedupe is a read-side concern of the
  questions queue, never a collapse of the physical units. Batch → `parsed`.
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
  batch_ulid?, acquired_at? (ISO date), on_hand_fraction?, state?, needs_info?,
  shelf_life_class?, notes? }`. ULID optional (server-generates when absent);
  idempotent when supplied. Returns the **bare** `InventoryItem` (`201`/`200`).
- `POST /inventory/:ulid/events` — explicit state change. JSON
  `{ type: 'opened'|'finished'|'tossed', fraction? (0..1), at? (ISO date) }`.
  `fraction` semantics per type: `opened` — absolute remaining fraction
  (omitted = unchanged); `tossed` — **amount tossed** (partial toss decrements
  and stays alive; terminal only at zero remainder or when omitted, per the
  state-machine rules above); `finished` ignores it (always terminal + zeroed).
  Returns the **bare** updated `InventoryItem`. `404` unknown item; `409`
  `InvalidTransitionError` on a terminal item.
- `POST /inventory/events` — **free-text event resolver**. JSON
  `{ remark (string, required), at? (ISO date) }`. Best-effort matches the
  remark against open/stocked items (string/alias, directional), infers the
  event type (opened/finished/tossed + fraction) from the remark, applies it,
  and returns `{ matched: boolean, item?: InventoryItem, event?: { type,
  fraction } }`. An unmatched remark is `{ matched: false }` — normal, not an
  error (`200`).
- `POST /inventory/:ulid/label` — multipart. Photo parts (`photo`/`photos`) +
  optional meta part **`label`** (JSON `{ name?, shelf_life_class?,
  package_size?, aliases? }`, field or file part). Runs the label model
  (`KITCHEN_ESTIMATION_MODEL`, the strong tier) over the photos, enriches/creates
  the product, links + clears `needs_info` on the item, and writes the
  `receipt_lexicon` line so the same receipt text auto-resolves next time.
  **Label fan-out:** resolving one item also resolves **every other open
  `needs_info` item with the same `(store, normalized raw_label)`** — the same
  product link and `shelf_life_class`, but `eat_by` re-derived per each sibling's
  **own** `acquired_at`/`opened_at` (they are distinct physical units with
  distinct clocks). This clears the whole multi-quantity group in one scan; the
  lexicon write handles *future* receipts, the fan-out handles the *current*
  batch's siblings. Fan-out only applies when the scanned item carries both a
  `store` and a `raw_label` (the grouping key); otherwise only the scanned item
  resolves. Returns `{ item: InventoryItem, product: Product, resolved_count }`,
  where `resolved_count` is the total number of items resolved (the scanned item
  plus its siblings, ≥ 1) (`404` unknown item, `503` no label model configured).
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

Products & lexicon (agentic seed + reads):

- `POST /products` — JSON `{ name (required), shelf_life_class?, aliases?,
  nutrition_per_100g?, package_size?, shelf_life_days_unopened?,
  shelf_life_days_opened? }` → `Product` (`201`).
- `GET /products?q&limit` → `{ products: Product[], count }` (`q` = substring
  over name/aliases).
- `POST /lexicon` — JSON `{ store (required), line_text (required),
  product_ulid (required), package_size?, shelf_life_class? }` → `LexiconLine`
  (`201`); upserts on `(store, line_text)`.
- `GET /lexicon?store&limit` → `{ lines: LexiconLine[], count }`.

### JSON shapes (wire contract for the client app)

- **PurchaseBatch**: `{ ulid, source, store, purchased_at, status,
  parse_attempts, last_error, created_at, updated_at }`.
- **BatchLine**: `{ ulid, batch_ulid, raw_text, match_outcome, product_ulid,
  inventory_item_ulid, created_at }`.
- **InventoryItem**: `{ ulid, product_ulid, product_name, raw_label, store,
  batch_ulid, state, on_hand_fraction, needs_info, acquired_at, opened_at,
  closed_at, eat_by, shelf_life_class, days_until_eat_by, age_days, notes,
  created_at, updated_at }`. `product_name` is the joined product name (falls
  back to `raw_label`); `days_until_eat_by`/`age_days` are derived integers
  (null when undeterminable). Dates are ISO date strings (`YYYY-MM-DD`);
  timestamps are ISO date-time.
- **Product**: `{ ulid, name, shelf_life_class, aliases, nutrition_per_100g,
  package_size, shelf_life_days_unopened, shelf_life_days_opened, created_at,
  updated_at }`.
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

### Depletion matcher

After a consumption entry reaches terminal `estimated`, a conservative,
model-free pass matches its label against on-hand items (exact/alias/substring
string match). A confident single match decrements the item's
`on_hand_fraction` by a directional step and sets `entries.inventory_item_ulid`;
an ambiguous or absent match is a no-op (unmatched entries are normal). Wired
as an injected `onEntryEstimated` hook so the estimation pipeline stays
inventory-agnostic. The match is label-only and the decrement is a fixed
directional step — it consumes no macro quantities, so the portion multiplier
does not enter here. (Were it ever to deplete by consumed amount, that amount is
the **effective** macros, not the base.)

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

### Model tiering (phase 2)

- Receipt line extraction uses the **cheap** tier (`KITCHEN_RECEIPT_MODEL`,
  default a Haiku-class id) — mechanical OCR-ish extraction, gather cheap.
- Label extraction reuses the **strong** vision tier (`KITCHEN_ESTIMATION_MODEL`)
  — reading a nutrition/size panel accurately earns the better model.
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
    `--recipe` + component quantities; the deliberate no-model path),
    `patch <ulid>` (note/label re-queue, macro override, portion multiplier),
    `resolve`-style close-outs are NOT here (entries have no such state);
    `delete <ulid>`.
  - `inventory` — list (eat-first order; `--state`, `--closed`),
    `show <ulid>`, `add` (manual/seed create), `event <ulid> <opened|finished|
    tossed> [--fraction]`, `remark "<free text>"` (the resolver; prints
    matched/unmatched honestly), `questions`.
  - `receipts` — list, `show <ulid>` (batch + line outcomes), `scan <photo…>`
    (multipart post; meta as a form field per the module's part-type rule).
  - `recipes` — list (merged view), `push` (agent-authored recipe JSON),
    `promote <entry-ulid> --name`.
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
