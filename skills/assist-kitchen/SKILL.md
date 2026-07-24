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
- **Partial toss vs full toss.** On `inventory event <ulid> tossed`, `--fraction` is the
  **amount tossed**, not the amount remaining. A partial toss (`--fraction 0.25`)
  decrements `on_hand_fraction` and keeps the item **alive** (inventory is directional and
  self-heals at the next event). The item only goes terminal `tossed` when `--fraction` is
  omitted (full toss) or the remainder hits zero. Contrast `opened` (where `--fraction` is
  the absolute *remaining* fraction) and `finished` (always terminal, zeroed).
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

## Common workflows

- **"Log what I just ate"** → `scripts/kitchen-axi entries log "<description>"` (the
  deliberate no-model path). For a known recipe, add `--recipe <ulid>` and
  `--component "label=grams"` for exact, deterministic macros.
- **"I only ate half of that"** → `scripts/kitchen-axi entries patch <ulid> --multiplier 0.5`.
- **"Fix the calories on that entry"** → `scripts/kitchen-axi entries patch <ulid> --calories N`
  (terminal manual override — use only when you mean to pin it).
- **"What's today looking like?"** → bare `scripts/kitchen-axi` (home view: effective totals,
  pending estimates, eat-first items, open questions).
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

## Commands

<!-- BEGIN GENERATED: command-reference -->

### Entries

- `scripts/kitchen-axi entries list [--since DATE] [--limit N]` — newest-first consumption entries (base macros + portion_multiplier; effective = base × multiplier)
- `scripts/kitchen-axi entries show <ulid>` — one entry with full nutrition, source, and status
- `scripts/kitchen-axi entries log [note…] [--recipe ULID] [--component "label=grams"]… [--at TIME] [--calories N] [--protein N] [--fat N] [--sat-fat N] [--carbs N] [--sugar N] [--fiber N] [--sodium N] [--label T]` — log a deliberate, no-model entry (note and/or recipe + component quantities); recipe-referenced entries are computed deterministically; --at sets logged_at (default now); a directly-stated panel (--calories/--protein/…, optionally --label) records a born-manual, terminal entry verbatim with NO estimation (mutually exclusive with --recipe/--component)
- `scripts/kitchen-axi entries patch <ulid> [--note T] [--label T] [--calories N] [--protein N] [--fat N] [--sat-fat N] [--carbs N] [--sodium N] [--portion-basis T] [--multiplier M] [--at TIME]` — edit an entry: note/label re-queue estimation; any macro sets a terminal manual override; --multiplier rescales the base post-hoc and --at backdates logged_at (neither re-queues, neither changes source)
- `scripts/kitchen-axi entries delete <ulid>` — remove an entry from all rollups

### Expenditure

- `scripts/kitchen-axi expenditure log "<label>" --kcal N [--duration M] [--avg-hr H] [--at TIME] [--source S] [--ulid U]` — record a stated burn (active calories — a device said it or you did; never model-estimated); feeds the daily net line, which is context, not a spend-it budget
- `scripts/kitchen-axi expenditure list [--since DATE] [--limit N]` — recent expenditures, newest first
- `scripts/kitchen-axi expenditure delete <ulid>` — remove an expenditure from all rollups

### Inventory

- `scripts/kitchen-axi inventory list [--state S] [--closed] [--limit N]` — on-hand items in eat-first (eat_by ascending) order; --state filters, --closed includes finished/tossed
- `scripts/kitchen-axi inventory show <ulid>` — one inventory item with derived eat_by / days-until / age
- `scripts/kitchen-axi inventory add [--raw-label T] [--product-ulid U] [--store S] [--acquired-at DATE] [--fraction F] [--units-total N] [--state S] [--needs-info] [--shelf-life C] [--notes T] [--ulid U]` — create an item directly (manual/verbal purchase or seed); --units-total makes it a counted item (sealed multipack) instead of fraction-modeled; idempotent when --ulid supplied
- `scripts/kitchen-axi inventory event <ulid> <opened|finished|finished-unit|tossed> [--fraction F] [--at DATE]` — explicit state change; for tossed, --fraction is the AMOUNT TOSSED (partial toss decrements + stays alive, terminal only at zero remainder or when omitted); finished-unit is a counted item's integer one-unit decrement
- `scripts/kitchen-axi inventory remark "<free text>" [--at DATE]` — free-text event resolver — matches a remark to an item and infers opened/finished/tossed; prints matched/unmatched honestly (unmatched is normal, not an error)
- `scripts/kitchen-axi inventory questions [--limit N]` — open needs-info items as one-time questions
- `scripts/kitchen-axi inventory convert [--from <ulid>[:amount]…] --to '<derived spec json>' [--at DATE]` — prep transform: create a NEW derived item with its own clock + provenance, optionally decrementing source item(s) (count or fraction); --from is OPTIONAL — with none it is a source-less "I made this" that decrements nothing. Pass --to recipe_ulid to make the item one-tap consume-eligible. THIS is how prepped food reaches the consume shelf — never plain 'inventory add'
- `scripts/kitchen-axi inventory consume <item-ulid> [--quantity N] [--at DATE] [--ulid ENTRY_ULID]` — one-tap: log a consumption entry with the item's EXACT known macros (no model call) and deplete it, in ONE atomic step; only recipe-linked derived items qualify (else 400); idempotent on --ulid

### Receipts

- `scripts/kitchen-axi receipts list [--limit N]` — recent purchase batches with parse status
- `scripts/kitchen-axi receipts show <ulid>` — one batch plus its parsed line outcomes (matched/unmatched/pending)
- `scripts/kitchen-axi receipts scan <photo…> [--store S] [--purchased-at DATE] [--ulid U]` — post a purchase batch from receipt photos (parses asynchronously); meta is sent as a form field per the module's part-type rule

### Recipes

- `scripts/kitchen-axi recipes list [--limit N]` — the reselect strip — merged sheet + pushed + promoted recipes plus recent/frequent logged items
- `scripts/kitchen-axi recipes push '<recipe json>'` — agent-authored template: {"name": "...", "components": [{label, default_qty_g, per_100g:{calories, protein_g, sat_fat_g}}]}
- `scripts/kitchen-axi recipes promote <entry-ulid> --name NAME` — create a reusable recipe from a logged entry

### Products & lexicon

- `scripts/kitchen-axi products list [--q TEXT] [--limit N]` — products (durable item facts); --q substring-matches name/aliases
- `scripts/kitchen-axi products add --name NAME [--shelf-life C] [--aliases a,b] [--package-size S] [--nutrition '<json>'] [--shelf-life-days-unopened N] [--shelf-life-days-opened N]` — seed a product
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
