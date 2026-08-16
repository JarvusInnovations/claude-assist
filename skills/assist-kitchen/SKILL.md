---
name: assist-kitchen
description: >-
  Read and write the kitchen consumption journal and inventory via the bundled
  kitchen-axi CLI. Use to log meals or snacks, adjust a portion after the fact,
  check today's calorie/macro totals, see what food is on hand or aging (eat-first),
  scan a grocery receipt, record opening/finishing/tossing an item, answer
  needs-info questions, or seed products and the receipt lexicon. Triggers:
  "log this meal", "what did I eat today", "I only ate half", "what's about to
  expire", "what's in the fridge", "scan this receipt", "I opened/finished/tossed
  the X", "kitchen inventory".
---

# assist-kitchen

Read and write the kitchen module (consumption journal + inventory), via the bundled
**`kitchen-axi`** CLI — a script in this skill's `scripts/` directory (not on `PATH`).
Invoke it by its path relative to this skill's base directory:

```bash
scripts/kitchen-axi                     # home: today's totals + eat-first + questions
scripts/kitchen-axi --help              # full command list
scripts/kitchen-axi <group> --help      # usage for any command group
```

Output is [TOON](https://toonformat.dev) (compact tables); pass `--json` for raw API
JSON. The server defaults to `http://localhost:2529`; override with the
`CLAUDE_ASSIST_SERVER` environment variable. The full behavioral contract is
`specs/modules/kitchen.md` — the rules below are the ones that decide a write; when
in doubt, read the spec.

## Decisive rules (read before writing)

- **Base vs effective macros.** Every entry stores and returns **base** macros
  (`calories`, `protein_g`, …) plus a `portion_multiplier`. The wire never carries
  pre-scaled numbers. Effective is always `base × portion_multiplier`, computed by the
  consumer — the CLI's `entries show`/`list` and the home totals already do this. When
  you report what someone actually ate, use the effective value, not the base field.
- **`--multiplier` is the post-hoc "I only ate half" knob.** It rescales the base and
  nothing else: it never re-queues estimation, never changes `source`, and never 409s.
  It always rescales **from the base**, so it's idempotent — `--multiplier 0.5` then
  `--multiplier 0.75` yields `0.75 × base`, not `0.375 × base`. Reach for it whenever the
  amount eaten differs from what was logged; do **not** hand-edit macro fields for that.
- **A macro override is terminal.** Setting any macro on `entries patch` (`--calories`,
  `--protein`, …) marks the entry `source: manual` — the owner's correction, which no
  later model pass may overwrite (a model re-estimate attempt 409s). Only override when
  you mean to pin the number; use `--note`/`--label` (which re-queue estimation) or
  `--multiplier` (which rescales) otherwise. An override sets the base; a multiplier still
  scales it.
- **Backdating a meal? Supply a specific local time — a bare date is only a backstop.**
  `--at` sets `logged_at`, the moment the meal actually happened (a gallery photo logged
  hours later belongs on the meal's day, not the logging day). When you know the time,
  send a **full local timestamp with offset** (`--at 2026-04-29T14:30:00-04:00`) so it
  buckets exactly. A **bare `YYYY-MM-DD`** is accepted as a fallback and coerces to **noon
  in the machine's local timezone** — never midnight UTC, which is the previous evening
  across US zones and would land the entry a day early. Same rule applies to `entries
  patch --at` and `expenditure log --at`. Omit `--at` entirely to default to now.
- **The `day` field is authoritative for bucketing — never derive a day from a timestamp.**
  Every entry, expenditure, and weigh-in row carries a `day` (`YYYY-MM-DD`) computed by the
  server in the **instance owner's timezone**, and displayed instants render in that zone
  (e.g. `2026-07-25T20:47:00-04:00`), never a bare `…Z`. When you group, filter, or ask
  "what did I eat on <date>", key off `day`. Do **not** parse `logged_at`/`occurred_at` (the
  raw UTC instant, kept only for ordering) and slice a date off it — a meal logged at
  `00:47Z` is the *previous* evening across US zones, and hand-bucketing by the UTC date is
  the recurring error this field exists to kill. You never supply or compute a timezone; the
  module owns it.
- **Multi-day or weekly totals? Call `days` once — never list entries and hand-sum them.**
  `kitchen-axi days [--since <n|date>]` returns one pre-computed row per owner-local day (the
  eight-field panel + calories + the net line), bucketed server-side. Reach for it for any
  "how did the week go", weekly-review, or per-day-trend question. Summing `entries list`
  rows yourself is both the expensive way and the exact operation that mis-buckets by UTC —
  `days` is the correct, single-call aggregate. The home view already reports **today's**
  owner-local totals; `days` extends that across the window.
- **Already have the exact macros? State them at log time — never log-then-patch.** When
  a caller has *already computed* the full panel (a page/UI totalled it, a resolved label
  scan, an import), pass the fields on `entries log` (`--calories`/`--protein`/… `--label`).
  That records a born-`manual`, terminal entry **verbatim, with no estimation ever
  enqueued** — mutually exclusive with `--recipe`/`--component`. Do **not** log the raw
  inputs (`--component`) and then `patch` the totals: that path re-derives numbers you
  already hold (lossy) *and* is racy — the estimation job it kicks off can land after your
  patch and clobber it. If you know the answer, state it; the module won't re-guess it.
- **Partial toss vs full toss.** On `inventory event <ulid> tossed`, `--fraction` is the
  **amount tossed**, not the amount remaining. A partial toss (`--fraction 0.25`)
  decrements `on_hand_fraction` and keeps the item **alive** (inventory is directional and
  self-heals at the next event). The item only goes terminal `tossed` when `--fraction` is
  omitted (full toss) or the remainder hits zero. Contrast `opened` (where `--fraction` is
  the absolute *remaining* fraction) and `finished` (always terminal, zeroed).
- **Never retire a record with `finished` or `tossed` just to get it out of the way.** Those
  are claims about food: `finished` says it was eaten, `tossed` says it was wasted and feeds
  waste telemetry someone will later act on. For a record that was never real stock — a
  phantom, a mis-scan, a housewares line — use `inventory dismiss <ulid>`, the one terminal
  that claims neither. If **two records describe one physical package**, use `inventory merge
  <dupe> --into <survivor>` instead: dismiss retires a row but relinks nothing, so the
  duplicate's consumption entries, receipt line, and conversions would be stranded. Pick the
  survivor by whose clock is honest (usually the earlier `acquired_at`) — merge fills only
  its *empty* fields and never sums quantities. If you have already closed something wrongly,
  `inventory recount <ulid> --state stocked` resurrects it first.
- **Fixing a recipe? Push it again under the same name — never push a variant.** `recipes
  push` **upserts**: the key is the normalized name (case- and spacing-insensitive), or
  `--ulid` for one specific record, and the output says whether it created or replaced.
  Recipes are tapped from the strip by **name**, so a second same-named recipe is
  indistinguishable from the first and the stale one keeps logging wrong numbers on every
  tap. Never work around a collision by appending "v2" or "(fixed)" to the name. A name
  already held by a `promoted` or `sheet` recipe is a `409` naming the record — rename, or
  pass `--ulid` if you really mean to replace that one. To retire a recipe, `recipes
  delete <ulid>`: it **archives** (off the strip permanently, still resolvable so entries
  logged from it and prepped items derived from it keep working). There is no hard delete.
- **Never fix a logged entry by deleting and re-logging it.** All nine panel fields are
  correctable in place with `entries patch` (`--calories --protein --fat --sat-fat --carbs
  --sugar --added-sugar --fiber --sodium`). `entries delete` + `entries log` mints a **new ULID**, which
  breaks the inventory link, the reselect strip's `entry_ulid`, and anything else pointing
  at the entry. Delete is for an entry that shouldn't exist, not for a wrong number.
- **Total sugar and added sugar are two different numbers, and only one has a line.**
  `--sugar` is TOTAL sugar (intrinsic + added) and carries **no target** — there is no
  established guideline for it, so it is context, never a breach. `--added-sugar` is the
  share added in processing or preparation and is the one with a ceiling. Unprocessed whole
  foods (fruit, vegetables, plain dairy, eggs, meat, fish, plain grains) are
  `--added-sugar 0` — a **0 you state**, not a field you omit: an omitted field is `null`
  (unknown) and silently drops the day's added-sugar total. Fruit juice counts as added
  even when it's "100% juice". Don't read a big `sugar` number as a problem; read
  `added_sugar`.
- **Deliberate actions never go through the ambient classifier.** These commands are the
  deliberate paths — logging a meal, scanning a receipt, an explicit `inventory event` —
  and they hit the module directly. The free-text `inventory remark` resolver is for
  *passing* remarks ("opened the oat milk"); it best-effort matches an item and infers the
  event, and an unmatched remark returns `{matched:false}` — that's normal, not an error.
  Don't escalate an unmatched remark; fall back to `inventory list` + an explicit `event`.
- **Photos are ephemeral.** Meal and receipt/label photos are held in memory only for the
  model call and discarded on every outcome — never persisted. Records carry no image data,
  and there's nothing to re-OCR later. If a scan needs retrying, re-post the photo files.
- **Prepped food is a `convert`, never a plain `inventory add`.** When the owner has
  *prepared* something — overnight-oats jars, hard-boiled eggs, cooked quinoa, a batch of
  anything — record it with `inventory convert`, not `inventory add`. Only a `convert` that
  carries a `--to` `recipe_ulid` mints a **consume-eligible** item (the one-tap
  `inventory consume` / the app's "Ready in your kitchen" shelf reads its macros from that
  recipe). A plain `inventory add` makes an ordinary grocery-style item with no recipe
  provenance — it can *never* reach the shelf, so a jar added that way is a dead end the
  owner has to log the slow way forever. `--from` is **optional**: pass the raw sources to
  decrement them, or omit it entirely for a source-less "I made this" when the inputs
  weren't tracked. So: raw groceries → `inventory add`; anything you *made* → `inventory
  convert --to '{…,"recipe_ulid":"…"}'`. If no recipe exists yet, `recipes push` one first
  (its components fix the macros), then convert against it.

- **A cost of `null` means unknown, and never zero.** Both money reads — `products prices`
  and `inventory waste` — are derived from the prices receipts already recorded, so they are
  honest about gaps. An unreadable line price, a manually-seeded item, or a product bought
  before receipt scanning has **no price on file**: the row reads `cost null` / `basis
  unknown`, and the waste totals sum only the known rows and count the unknown ones
  separately. Never report a null as free or fold it in as a 0 — that would make waste look
  costless, which is the opposite of what the read is for. Same rule on the price side: a
  null `per_100g` means no package size resolved for that purchase, not a free package, and
  it is fixed by scanning the label or setting `--package-size`, never by assuming a size.

## Common workflows

- **"Log what I just ate"** → `scripts/kitchen-axi entries log "<description>"` (the
  deliberate no-model path). For a known recipe, add `--recipe <ulid>` and
  `--component "label=grams"` for exact, deterministic macros.
- **"I only ate half of that"** → `scripts/kitchen-axi entries patch <ulid> --multiplier 0.5`.
- **"Fix the calories on that entry"** → `scripts/kitchen-axi entries patch <ulid> --calories N`
  (terminal manual override — use only when you mean to pin it).
- **"Log a meal whose macros I already computed"** (a page/UI totalled it) →
  `scripts/kitchen-axi entries log --calories N --protein N --sat-fat N --sugar N --added-sugar N --fiber N --sodium N --label "<meal>"`
  (directly-stated panel: born-`manual`, terminal, no estimation, no race — not `--component` + `patch`).
- **"What's today looking like?"** → bare `scripts/kitchen-axi` (home view: effective totals,
  pending estimates, eat-first items, open questions). Fields with an owner-set daily target
  render as `logged / target` with remaining — a `max` counts down what's left, a `min` counts
  up to met; never derived from the day's burn.
- **"What should I use up?"** → `scripts/kitchen-axi inventory list` (eat-first order).
- **"I made a batch of X" (meal prep)** → record it as a **conversion** so it lands
  consume-eligible, not a plain add. First ensure a recipe exists (`recipes list`; if not,
  `recipes push '{"name":"…","components":[{"label":"…","default_qty_g":N,"per_100g":{"calories":N,"protein_g":N,"sat_fat_g":N}}]}'` — components fix the macros).
  Then `scripts/kitchen-axi inventory convert --to '{"name":"<prepared item>","units_total":<N jars/portions>,"recipe_ulid":"<recipe>"}'`,
  adding `--from <ulid>[:amount]…` for each raw source you want decremented (omit `--from`
  entirely if the inputs weren't tracked). The derived dish defaults to the **`prepared`**
  shelf-life class (~4 days from when it was made); pass `"shelf_life_class":"produce"` for
  something that keeps ~a week (hard-boiled eggs) or `"very_perishable"` for a 2-3-day item
  (cut fruit). The result is on the "Ready in your kitchen" shelf for one-tap
  `inventory consume` later.
- **"I opened / finished / tossed X"** → `scripts/kitchen-axi inventory remark "<what happened>"`,
  or `inventory event <ulid> <type>` when you have the item.
- **"Scan this receipt"** → `scripts/kitchen-axi receipts scan <photo…> --store "<store>"`, then
  `receipts show <ulid>` to see extracted lines (parses asynchronously).
- **"What has this cost me / is it cheaper at the other store?"** →
  `scripts/kitchen-axi products prices <ulid>` (add `--store "<store>"` to scope). Compare
  the `per_100g` / `per_100ml` columns, never the raw prices — packages differ in size
  between purchases and stores, which is exactly what the normalization is for.
- **"How much food am I throwing away?"** → `scripts/kitchen-axi inventory waste
  [--since DATE]`. Each row is one toss with the amount discarded and its cost, scaled to
  the fraction (or sealed units) actually thrown out. Read the totals as
  known-cost-plus-unknown-rows, not as one number.

## Commands

<!-- BEGIN GENERATED: command-reference -->

### Entries

- `scripts/kitchen-axi entries list [--since DATE] [--limit N]` — newest-first consumption entries (base macros + portion_multiplier; effective = base × multiplier)
- `scripts/kitchen-axi entries show <ulid>` — one entry with full nutrition, source, and status
- `scripts/kitchen-axi entries log [note…] [--recipe ULID] [--component "label=grams"]… [--at TIME] [--calories N] [--protein N] [--fat N] [--sat-fat N] [--carbs N] [--sugar N] [--added-sugar N] [--fiber N] [--sodium N] [--label T]` — log a deliberate, no-model entry (note and/or recipe + component quantities); recipe-referenced entries are computed deterministically; --at sets logged_at (default now — prefer a full local timestamp with offset; a bare YYYY-MM-DD backstops to local noon that day, never midnight UTC); a directly-stated panel (--calories/--protein/…, optionally --label) records a born-manual, terminal entry verbatim with NO estimation (mutually exclusive with --recipe/--component); --sugar is TOTAL sugar (untargeted context) while --added-sugar is the processed/prepared share that carries the ceiling — whole foods are --added-sugar 0, never omitted
- `scripts/kitchen-axi entries patch <ulid> [--note T] [--label T] [--calories N] [--protein N] [--fat N] [--sat-fat N] [--carbs N] [--sugar N] [--added-sugar N] [--fiber N] [--sodium N] [--portion-basis T] [--multiplier M] [--at TIME]` — edit an entry: note/label re-queue estimation; any of the NINE macro flags sets a terminal manual override (the same panel `log` accepts — every field is correctable in place, so never delete + re-log to fix a number); --multiplier rescales the base post-hoc and --at backdates logged_at (prefer a full local timestamp with offset; a bare YYYY-MM-DD backstops to local noon that day; neither re-queues, neither changes source)
- `scripts/kitchen-axi entries questions [--limit N]` — entries whose HUMAN-supplied note nobody has reconciled against the computed panel — a condiment, a splash of oil, an extra the component list never covered. The entries-side twin of `inventory questions`, and part of the home view's open-question count
- `scripts/kitchen-axi entries review <ulid>` — mark one note looked at. Records that a human READ it, NOT that anything changed — most extras are immaterial and "seen, costs nothing" is the honest outcome. If it DOES move the numbers, `patch` them first, then review
- `scripts/kitchen-axi entries delete <ulid>` — remove an entry from all rollups

### Stores

- `scripts/kitchen-axi stores list` — every store string seen, from the lexicon and inventory items
- `scripts/kitchen-axi stores merge <from> --into <to>` — fold one store spelling into another: re-points its lexicon rows and items, then records the alias so the old string resolves onto the survivor. A store accumulates spellings and the lexicon keys on the string, so mappings under one can never match receipts printing another. NOT REVERSIBLE — sharing a word is not enough, and when unsure leave them apart

### Prep worksheets

- `scripts/kitchen-axi prep publish --slug S --label T [--recipe <recipe-ulid>] [--component <product-ulid>=<g>]… [--component-item <item-ulid>=<g>]… [--component-unit <item-ulid>=<n>]… [--step T]… [--cook eaten|packed] [--units N] [--shelf-life C] [--yields-recipe <recipe-ulid>] [--source <item-ulid>[:amount]]…` — build a prep WORKSHEET from the catalog and publish it. Components are named by ULID and resolve to the product's stored per-100g panel, so no reference number is transcribed by hand; a product with no panel is refused rather than guessed at, and a missing field contributes 'unknown' rather than zero. An EATEN sheet decrements the items its components name when submitted, so name stock with --component-item (grams) or --component-unit (whole units for counted stock). --recipe seeds rows from a recipe's lines (which carry their own per-100g inline, so they need no catalog lookup). --cook makes submitting the sheet the write itself (eaten → one entry; packed → one conversion). On a packed sheet, --yields-recipe sets the batch's macro provenance — WITHOUT it the derived item can never be one-tap consumed or named as a component, because its macros live nowhere. Publishing writes NOTHING to the ledger

### Daily rollup

- `scripts/kitchen-axi days [--since <n|date>]` — per-owner-local-day rollup: one row per day (nine-field panel + calories + net line when a TDEE base is set), bucketed by the instance's OWNER timezone SERVER-SIDE. --since is a day count (7 / 7d) or a date; default last 7 days. USE THIS for any multi-day or weekly total — never list entries and hand-sum them by timestamp (UTC-vs-local mis-bucketing is the exact footgun this retires; group only by the `day` field)

### Expenditure

- `scripts/kitchen-axi expenditure log "<label>" --kcal N [--duration M] [--avg-hr H] [--at TIME] [--source S] [--ulid U]` — record a stated burn (active calories — a device said it or you did; never model-estimated); feeds the daily net line, which is context, not a spend-it budget; --at defaults to now — prefer a full local timestamp with offset, a bare YYYY-MM-DD backstops to local noon that day. STRAVA ACTIVITIES SYNC THEMSELVES (a scheduled server feed pulls the trailing week every ~30 min, idempotently) — NEVER manually log or import a Strava/Garmin workout; this verb is only for burns that never reach Strava
- `scripts/kitchen-axi expenditure list [--since DATE] [--limit N]` — recent expenditures, newest first
- `scripts/kitchen-axi expenditure delete <ulid>` — remove an expenditure from all rollups

### Weigh-ins

- `scripts/kitchen-axi weigh-ins log --weight KG [--body-fat PCT] [--at TIME]` — record a manual weigh-in (source: manual; --at defaults to now — prefer a full local timestamp, a bare YYYY-MM-DD backstops to local noon that day; a naive time gets this machine's local offset attached because the server refuses to guess a zone)
- `scripts/kitchen-axi weigh-ins list [--since DATE] [--limit N]` — raw readings, newest first — every reading is a row (repeats included); noise collapses at read time, never by rewriting
- `scripts/kitchen-axi weight trend [--days N]` — derived view (default 30 days): one line per local day with readings (median weight + median body-fat + count, bucketed by each reading's OWN recorded offset) plus a 7-day rolling mean over existing days — no interpolation; context for the owner's judgment, never an auto-tuner

### Inventory

- `scripts/kitchen-axi inventory list [--state S] [--closed] [--limit N]` — on-hand items in eat-first (eat_by ascending) order; --state filters, --closed includes finished/tossed
- `scripts/kitchen-axi inventory show <ulid>` — one inventory item with derived eat_by / days-until / age
- `scripts/kitchen-axi inventory add [--raw-label T] [--product-ulid U] [--store S] [--acquired-at DATE] [--fraction F] [--units-total N] [--unit-seal individual|shared] [--state S] [--needs-info] [--shelf-life C] [--notes T] [--ulid U]` — create an item directly (manual/verbal purchase or seed); --units-total makes it a counted item instead of fraction-modeled, and --unit-seal says what that package seals — shared for one seal over N units (a 4-link pack, a sliced loaf), individual (default) for separately-sealed units (a can 3-pack); a supplied --shelf-life derives an eat_by even with --needs-info; idempotent when --ulid supplied
- `scripts/kitchen-axi inventory event <ulid> <opened|finished|finished-unit|tossed|moved> [--fraction F] [--to CLASS] [--at DATE]` — explicit event; for tossed, --fraction is the AMOUNT TOSSED (partial toss decrements + stays alive, terminal only at zero remainder or when omitted); finished-unit is a counted item's integer one-unit decrement, whose outcome depends on --unit-seal (individual — back to a fresh sealed clock; shared — stays open on the container's clock). 'moved --to <class>' is the STORAGE MOVE: an item physically changed appliance (freezer to fridge to thaw, fridge to freezer to park a clock), so its clock RESTARTS from the move date on the destination class — state and opened_at are untouched, and --at is the date of the ACT, not of the intention. --at (here and on every inventory verb) is a CALENDAR DAY resolved in the instance's own timezone: omitted it is today where the food is, never today in UTC, so an evening event and the meal entry it depletes agree on the day; a bare YYYY-MM-DD is taken verbatim, so you never compute an offset. The consumption/waste verbs never reach the fifth state, dismissed, which has its own verb ('inventory dismiss')
- `scripts/kitchen-axi inventory recount <ulid> [--fraction F] [--units-remaining N] [--units-total N] [--uncounted] [--unit-seal individual|shared] [--state stocked|open] [--opened-at DATE] [--shelf-life C] [--needs-info|--no-needs-info] [--product-ulid U|--unlink-product] [--notes T]` — RECONCILE the ledger to observed reality ("it's actually 75% full", "really 2 of 3 cans", "never opened", "this was always a fridge item", "this is that product") — a correction, NOT a consumption event; never invents a clock, re-derives eat_by (never settable), can reclassify the unit model + seal, corrects the class against the EXISTING anchor (a real storage move is 'event ... moved' instead), clears or re-queues needs-info without a label scan, re-points product_ulid, and --state can resurrect a mis-closed item. If you MEASURED an amount you ate, that is 'inventory eat', never this — a recount carries no consumption claim
- `scripts/kitchen-axi inventory dismiss <ulid> [--non-inventory]` — RETIRE a record that was never real stock — a phantom item, or a non-grocery receipt line (housewares). The ONLY terminal that claims neither consumption nor waste, so it never pollutes either telemetry: never close a phantom with 'event finished' (a consumption that didn't happen) or 'event tossed' (waste that didn't happen). --non-inventory also dismisses same-line siblings and teaches future receipts to skip the line. 409 if the item is already terminal
- `scripts/kitchen-axi inventory merge <ulid> --into <ulid>` — fold a DUPLICATE item (two records, ONE physical package) into a survivor: fills only the survivor's EMPTY identity fields, relinks its entries/receipt line/conversions, then retires it as dismissed. Quantities are never summed and the survivor keeps its OWN clock — use this, not dismiss, whenever either record has history
- `scripts/kitchen-axi inventory remark "<free text>" [--at DATE]` — free-text event resolver — matches a remark to an item and infers opened/finished/tossed; prints matched/unmatched honestly (unmatched is normal, not an error)
- `scripts/kitchen-axi inventory candidates <ulid> [--limit N]` — ranked candidate products for an item whose receipt line never matched exactly, scored on line-text similarity, product-name similarity and price agreement. SUGGESTIONS ONLY — nothing is attached by a score; the only automatic attachment is an exact lexicon hit, which replays a human decision rather than making one. A null price signal means there was nothing to compare, not that the prices disagree
- `scripts/kitchen-axi inventory questions [--limit N]` — open needs-info items as one-time questions
- `scripts/kitchen-axi inventory waste [--since DATE] [--until DATE] [--limit N]` — the COSTED toss log — every recorded toss with the amount discarded and what it cost, scaled to the fraction (or sealed units) actually thrown out, never the whole package. Price comes from the item's OWN receipt line when knowable, else the nearest priced purchase of the product (cost_basis says which). A null cost with basis 'unknown' means no price is on file for that product — NOT that the food was free; totals sum only known costs and report the unknown rows separately. Dismissed/merged-away records never appear (retracting the record retracts its waste)
- `scripts/kitchen-axi inventory convert [--from <ulid>[:amount]…] --to '<derived spec json>' [--at DATE]` — prep transform: create a NEW derived item with its own clock + provenance (--to takes unit_seal alongside units_total for a counted batch: shared for a tray under one lid, individual for separately-lidded jars), optionally decrementing source item(s) (count or fraction); --from is OPTIONAL — with none it is a source-less "I made this" that decrements nothing. Pass --to recipe_ulid to make the item one-tap consume-eligible. THIS is how prepped food reaches the consume shelf — never plain 'inventory add'
- `scripts/kitchen-axi inventory consume <item-ulid> [--quantity N] [--at DATE] [--ulid ENTRY_ULID]` — one-tap: log a consumption entry with the item's EXACT known macros (no model call) and deplete it, in ONE atomic step; qualifies via EITHER of two channels — a recipe-linked derived item, or a counted purchased item whose linked product has a complete nutrition panel + unit_edible_g (neither channel covers a fraction/divisible item — use 'eat' there); else 400; idempotent on --ulid
- `scripts/kitchen-axi inventory eat <item-ulid> [--grams N|--fraction F] [--entry-ulid ENTRY_ULID] [--at DATE]` — STATED-WEIGHT CONSUMPTION: a KNOWN weight or fraction eaten off an open DIVISIBLE item — a consumption, never a recount. Fraction-modeled items only (400 on a counted one — use finished-unit/consume there). Exactly one of --grams/--fraction; --grams needs the linked product's net_content_g and is REFUSED (400) without one, never guessed — pass --fraction instead. Reaching/passing zero goes terminal 'finished' (consumed, never tossed); a positive remainder stays open. --entry-ulid links an ALREADY-LOGGED consuming entry atomically with the deplete, and doubles as the idempotency key for a retry

### Receipts

- `scripts/kitchen-axi receipts list [--limit N]` — recent purchase batches with parse status
- `scripts/kitchen-axi receipts show <ulid>` — one batch plus its parsed line outcomes (matched/unmatched/pending)
- `scripts/kitchen-axi receipts scan <photo…> [--store S] [--purchased-at DATE] [--ulid U]` — post a purchase batch from receipt photos (parses asynchronously); meta is sent as a form field per the module's part-type rule

### Recipes

- `scripts/kitchen-axi recipes list [--limit N]` — the reselect strip — merged sheet + pushed + promoted recipes plus recent/frequent logged items
- `scripts/kitchen-axi recipes push '<recipe json>' [--ulid U]` — agent-authored template: {"name": "...", "components": [{label, default_qty_g, per_100g:{calories, protein_g, sat_fat_g}}]}. UPSERTS — a correction REPLACES rather than forks: the key is the normalized name (case/spacing-insensitive), or --ulid for one specific record. Prints created vs replaced. A name already held by a promoted or sheet-sourced recipe is a 409 naming it (rename, or pass --ulid deliberately) — never a silent clobber and never a second same-named pill on the strip
- `scripts/kitchen-axi recipes delete <ulid>` — ARCHIVE a recipe — off the reselect strip permanently, but still resolvable by ulid, so entries logged from it and prepped items derived from it keep working. Idempotent; 404 for an unknown or sheet-sourced ulid (the meal-bank sheet is never written from here). There is no hard delete
- `scripts/kitchen-axi recipes promote <entry-ulid> --name NAME` — create a reusable recipe from a logged entry

### Products & lexicon

- `scripts/kitchen-axi products list [--q TEXT] [--limit N]` — products (durable item facts); --q substring-matches name/aliases
- `scripts/kitchen-axi products add --name NAME [--ulid U] [--shelf-life C] [--aliases a,b] [--package-size S] [--nutrition '<json>'] [--negligible] [--shelf-life-days-unopened N] [--shelf-life-days-opened N]` — seed a product — UPSERTS on --ulid (create/replace) or the normalized name (enrich in place)
- `scripts/kitchen-axi products update <ulid> [--name NAME] [--nutrition '<json>'] [--negligible|--no-negligible|--force-negligible] [any add flag]` — correct a product in place — partial, only the flags you pass change (the door for adding nutrition later). --negligible is REFUSED for anything salt-bearing (garlic powder qualifies; garlic salt does not) — --force-negligible overrides
- `scripts/kitchen-axi products prices <ulid> [--store S] [--limit N]` — PRICE HISTORY — every recorded purchase of one product, newest first, with the printed price, the per-package price (line price ÷ quantity), and a NORMALIZED per-100g/per-100ml unit price plus the basis that produced it (a measure on the line, the store's lexicon package size, the product's label net content, or its package-size string). Compare the per-100 columns, never the raw prices: a 12 oz and a 16 oz package are not comparable at face value. A null unit price means no package size resolved for that purchase — nothing is guessed. Derived at read time from the receipt lines themselves, so nothing is stored and a corrected line corrects the history
- `scripts/kitchen-axi products merge <ulid> --into <ulid>` — fold a duplicate into a survivor: relink its items/lexicon/batch lines, then retire it
- `scripts/kitchen-axi products archive <ulid>` — retire a product (soft — still resolvable by ulid so linked items keep working)
- `scripts/kitchen-axi products panel-basis-report` — READ-ONLY: products whose stored per-100g disagrees with the value derivable from their own serving basis (nutrition_per_serving ÷ serving_size_g × 100) beyond an 8% + 0.6 per-field tolerance. Never rewrites anything — flagged rows need `products update <ulid>` once you know which number is right
- `scripts/kitchen-axi lexicon list [--store S] [--limit N]` — receipt-line → product mappings per store
- `scripts/kitchen-axi lexicon add --store S --line-text T --product-ulid U [--package-size S] [--shelf-life C]` — map a store's receipt line to a product (upserts on store+line; future receipts auto-resolve)

<!-- END GENERATED: command-reference -->

## Notes

- Every command is a thin veneer over one documented `/api/kitchen/*` endpoint; the CLI
  adds no semantics the API lacks. 4xx responses surface as a non-zero exit with the
  server's error message.
- Model-backed steps degrade gracefully: with no model key configured, receipts still post
  (batch stays `parsing`) and label intake returns 503 — the inventory surface stays
  "roughly right, self-healing".
- This skill is a generic toolkit surface — no instance identity. Installation, hooks, and
  which commands a chat surface exposes are the operator's concern.
