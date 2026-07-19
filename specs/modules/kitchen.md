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
  duplicate or regress a processed entry). Fields: timestamp, optional free-text
  note, resolved label, nutrition estimate (calories + macros with a
  confidence/portion basis), estimation source (`model` | `reselect` | `manual`),
  portion modifier derived from the note, optional recipe reference with
  per-component quantities, optional inventory-item links (phase 2).
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
  overwrite it). 409 on attempts to model-overwrite a `manual` entry.
- `DELETE /entries/:ulid` — removes the entry from all rollups.
- `GET /reselect` — the strip: recipes (sheet + pushed + promoted) merged with
  recent/frequent logged items.
- `POST /recipes` — agent-pushed one-off or reusable templates.
- `POST /entries/:ulid/promote` — creates a recipe from a logged entry.
- Rollup queries (daily totals, weekly trend) are computed, never stored; they
  feed the instance's briefing/review renderings.

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
  `product_ulid`, `package_size` (nullable), `shelf_life_class` (nullable
  override), `created_at`, `updated_at`. `UNIQUE(store, line_text)`. Grows
  monotonically; once mapped, every future receipt carrying the line resolves
  automatically.
- **`kitchen.inventory_items`** — one physical unit: `ulid`, `product_ulid`
  (nullable — null while `needs_info`), `raw_label` (text — the receipt line or
  display name when no product; nullable), `store` (nullable), `batch_ulid`
  (nullable), `state` (enum `stocked | open | finished | tossed`),
  `on_hand_fraction` (numeric 0..1, directional; default 1.0), `needs_info`
  (bool), `acquired_at` (date), `opened_at` (date, nullable), `closed_at` (date,
  nullable — finished/tossed date), `eat_by` (date, nullable — **derived**,
  materialized for ordering; recomputed on open), `shelf_life_class` (enum
  snapshot, nullable), `notes` (nullable), `created_at`, `updated_at`.
- **`kitchen.purchase_batches`** — one shopping event: `ulid` (client-supplied
  for receipt idempotency), `source` (enum `receipt | manual`), `store`
  (nullable), `purchased_at` (date), `status` (enum `parsing | parsed | failed`
  — the parse work queue, mirrors entry estimation), `parse_attempts`,
  `last_error`, `last_error_at`, `created_at`, `updated_at`.
- **`kitchen.purchase_batch_lines`** — one parsed receipt line: `ulid`,
  `batch_ulid`, `raw_text`, `match_outcome` (enum `matched | unmatched |
  pending`), `product_ulid` (nullable), `inventory_item_ulid` (nullable),
  `created_at`.
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
`{stocked,open} --tossed--> tossed`. `finished`/`tossed` are terminal. Opening
stamps `opened_at` and re-derives `eat_by`; finishing stamps `closed_at` and
sets `on_hand_fraction` to 0. Tossing takes an optional **amount tossed**
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
  exact-string lexicon lookup per store; a match creates a `stocked` inventory
  item stamped with `purchased_at`; an unknown creates a `needs_info` item
  (`product_ulid` null, `raw_label` = line text). Batch → `parsed`.
- `GET /receipts?limit` → `{ batches: PurchaseBatch[], count }`.
- `GET /receipts/:ulid` → `{ batch: PurchaseBatch, lines: BatchLine[] }` (404 if absent).

Inventory reads:

- `GET /inventory?state&limit&include_closed` → `{ items: InventoryItem[], count }`.
  Default: on-hand (`stocked`+`open`) ordered by `eat_by` ascending, nulls last
  (eat-first urgency). `state` filters to one state; `include_closed=true`
  includes finished/tossed.
- `GET /inventory/:ulid` → bare `InventoryItem` (404 if absent).
- `GET /inventory/questions?limit` → `{ questions: Question[], count }` — open
  `needs_info` items rendered as one-time questions for the digest/chat.

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
  Returns `{ item: InventoryItem, product: Product }` (`404` unknown item).

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
  shelf_life_class, created_at, updated_at }`.
- **Question**: `{ item_ulid, raw_label, store, acquired_at, question }`.

### Depletion matcher

After a consumption entry reaches terminal `estimated`, a conservative,
model-free pass matches its label against on-hand items (exact/alias/substring
string match). A confident single match decrements the item's
`on_hand_fraction` by a directional step and sets `entries.inventory_item_ulid`;
an ambiguous or absent match is a no-op (unmatched entries are normal). Wired
as an injected `onEntryEstimated` hook so the estimation pipeline stays
inventory-agnostic.

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

## Principles

- **A ballpark now beats precision later.** Single-call estimates, no food-DB
  lookups in v1; the longitudinal record is the value. Don't add friction in
  pursuit of accuracy.
- **Deterministic beats estimated when quantities are known.** Recipe-computed
  macros never go through a model; a kitchen-scale user's numbers are exact by
  construction.
- **The owner's correction is terminal.** `manual` overrides survive every
  subsequent automated pass.
