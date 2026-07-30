/**
 * Single source of truth for the tool description and the command surface. Used
 * by `--help` (`cli.ts`) and the static SKILL.md generator (`skill.ts`), so the
 * skill's command reference can never drift from the CLI.
 *
 * Every command is a thin veneer over one documented `/api/kitchen/*` endpoint
 * (specs/modules/kitchen.md § API) — the CLI adds no semantics the API lacks.
 */

export const DESCRIPTION =
  "Read and write the kitchen consumption journal and inventory — log meals, " +
  "adjust portions, track stock, scan receipts, and seed products/lexicon.";

export interface CommandRef {
  usage: string;
  summary: string;
}

export interface CommandGroup {
  group: string;
  commands: CommandRef[];
}

/**
 * The nine nutrition-panel flags (specs/modules/kitchen.md § Nutrition panel)
 * as `[flag, server field]` pairs — the SINGLE source for both `entries log`
 * (where they build a directly-stated panel) and `entries patch` (where any of
 * them sets a terminal manual override).
 *
 * Single-sourced deliberately: the documented `patch` usage once enumerated six
 * of the then-eight, omitting `--sugar`/`--fiber` even though the parser
 * accepted them. Fiber and added sugar are tracked daily targets, so an agent
 * reading the reference and concluding they can't be corrected falls back to
 * delete + re-log — which mints a new ULID and destroys the entry's identity.
 * A field that can be logged but not corrected has no correction path at all,
 * so the flag list and both usage strings derive from this one array
 * (§ Agent tooling).
 */
export const MACRO_PANEL_FLAGS: readonly (readonly [flag: string, field: string])[] = [
  ["calories", "calories"],
  ["protein", "protein_g"],
  ["fat", "fat_g"],
  ["sat-fat", "sat_fat_g"],
  ["carbs", "carbs_g"],
  ["sugar", "sugar_g"],
  ["added-sugar", "added_sugar_g"],
  ["fiber", "fiber_g"],
  ["sodium", "sodium_mg"],
];

/** Just the flag names, for a command's `parseArgs` value-flag list. */
export const MACRO_PANEL_FLAG_NAMES: readonly string[] = MACRO_PANEL_FLAGS.map(([flag]) => flag);

/** `[--calories N] [--protein N] …` — the panel as it appears in a usage line. */
const MACRO_PANEL_USAGE = MACRO_PANEL_FLAGS.map(([flag]) => `[--${flag} N]`).join(" ");

export const COMMAND_GROUPS: CommandGroup[] = [
  {
    group: "Entries",
    commands: [
      { usage: "entries list [--since DATE] [--limit N]", summary: "newest-first consumption entries (base macros + portion_multiplier; effective = base × multiplier)" },
      { usage: "entries show <ulid>", summary: "one entry with full nutrition, source, and status" },
      {
        usage: `entries log [note…] [--recipe ULID] [--component "label=grams"]… [--at TIME] ${MACRO_PANEL_USAGE} [--label T]`,
        summary: "log a deliberate, no-model entry (note and/or recipe + component quantities); recipe-referenced entries are computed deterministically; --at sets logged_at (default now — prefer a full local timestamp with offset; a bare YYYY-MM-DD backstops to local noon that day, never midnight UTC); a directly-stated panel (--calories/--protein/…, optionally --label) records a born-manual, terminal entry verbatim with NO estimation (mutually exclusive with --recipe/--component); --sugar is TOTAL sugar (untargeted context) while --added-sugar is the processed/prepared share that carries the ceiling — whole foods are --added-sugar 0, never omitted",
      },
      {
        usage: `entries patch <ulid> [--note T] [--label T] ${MACRO_PANEL_USAGE} [--portion-basis T] [--multiplier M] [--at TIME]`,
        summary: "edit an entry: note/label re-queue estimation; any of the NINE macro flags sets a terminal manual override (the same panel `log` accepts — every field is correctable in place, so never delete + re-log to fix a number); --multiplier rescales the base post-hoc and --at backdates logged_at (prefer a full local timestamp with offset; a bare YYYY-MM-DD backstops to local noon that day; neither re-queues, neither changes source)",
      },
      { usage: "entries delete <ulid>", summary: "remove an entry from all rollups" },
    ],
  },
  {
    group: "Daily rollup",
    commands: [
      {
        usage: "days [--since <n|date>]",
        summary: "per-owner-local-day rollup: one row per day (nine-field panel + calories + net line when a TDEE base is set), bucketed by the instance's OWNER timezone SERVER-SIDE. --since is a day count (7 / 7d) or a date; default last 7 days. USE THIS for any multi-day or weekly total — never list entries and hand-sum them by timestamp (UTC-vs-local mis-bucketing is the exact footgun this retires; group only by the `day` field)",
      },
    ],
  },
  {
    group: "Expenditure",
    commands: [
      {
        usage: 'expenditure log "<label>" --kcal N [--duration M] [--avg-hr H] [--at TIME] [--source S] [--ulid U]',
        summary: "record a stated burn (active calories — a device said it or you did; never model-estimated); feeds the daily net line, which is context, not a spend-it budget; --at defaults to now — prefer a full local timestamp with offset, a bare YYYY-MM-DD backstops to local noon that day. STRAVA ACTIVITIES SYNC THEMSELVES (a scheduled server feed pulls the trailing week every ~30 min, idempotently) — NEVER manually log or import a Strava/Garmin workout; this verb is only for burns that never reach Strava",
      },
      { usage: "expenditure list [--since DATE] [--limit N]", summary: "recent expenditures, newest first" },
      { usage: "expenditure delete <ulid>", summary: "remove an expenditure from all rollups" },
    ],
  },
  {
    group: "Weigh-ins",
    commands: [
      {
        usage: "weigh-ins log --weight KG [--body-fat PCT] [--at TIME]",
        summary: "record a manual weigh-in (source: manual; --at defaults to now — prefer a full local timestamp, a bare YYYY-MM-DD backstops to local noon that day; a naive time gets this machine's local offset attached because the server refuses to guess a zone)",
      },
      { usage: "weigh-ins list [--since DATE] [--limit N]", summary: "raw readings, newest first — every reading is a row (repeats included); noise collapses at read time, never by rewriting" },
      {
        usage: "weight trend [--days N]",
        summary: "derived view (default 30 days): one line per local day with readings (median weight + median body-fat + count, bucketed by each reading's OWN recorded offset) plus a 7-day rolling mean over existing days — no interpolation; context for the owner's judgment, never an auto-tuner",
      },
    ],
  },
  {
    group: "Inventory",
    commands: [
      { usage: "inventory list [--state S] [--closed] [--limit N]", summary: "on-hand items in eat-first (eat_by ascending) order; --state filters, --closed includes finished/tossed" },
      { usage: "inventory show <ulid>", summary: "one inventory item with derived eat_by / days-until / age" },
      {
        usage: "inventory add [--raw-label T] [--product-ulid U] [--store S] [--acquired-at DATE] [--fraction F] [--units-total N] [--unit-seal individual|shared] [--state S] [--needs-info] [--shelf-life C] [--notes T] [--ulid U]",
        summary: "create an item directly (manual/verbal purchase or seed); --units-total makes it a counted item instead of fraction-modeled, and --unit-seal says what that package seals — shared for one seal over N units (a 4-link pack, a sliced loaf), individual (default) for separately-sealed units (a can 3-pack); a supplied --shelf-life derives an eat_by even with --needs-info; idempotent when --ulid supplied",
      },
      {
        usage: "inventory event <ulid> <opened|finished|finished-unit|tossed|moved> [--fraction F] [--to CLASS] [--at DATE]",
        summary: "explicit event; for tossed, --fraction is the AMOUNT TOSSED (partial toss decrements + stays alive, terminal only at zero remainder or when omitted); finished-unit is a counted item's integer one-unit decrement, whose outcome depends on --unit-seal (individual — back to a fresh sealed clock; shared — stays open on the container's clock). 'moved --to <class>' is the STORAGE MOVE: an item physically changed appliance (freezer to fridge to thaw, fridge to freezer to park a clock), so its clock RESTARTS from the move date on the destination class — state and opened_at are untouched, and --at is the date of the ACT, not of the intention. The consumption/waste verbs never reach the fifth state, dismissed, which has its own verb ('inventory dismiss')",
      },
      {
        usage: "inventory recount <ulid> [--fraction F] [--units-remaining N] [--units-total N] [--uncounted] [--unit-seal individual|shared] [--state stocked|open] [--opened-at DATE] [--shelf-life C] [--needs-info|--no-needs-info] [--product-ulid U|--unlink-product] [--notes T]",
        summary: "RECONCILE the ledger to observed reality (\"it's actually 75% full\", \"really 2 of 3 cans\", \"never opened\", \"this was always a fridge item\", \"this is that product\") — a correction, NOT a consumption event; never invents a clock, re-derives eat_by (never settable), can reclassify the unit model + seal, corrects the class against the EXISTING anchor (a real storage move is 'event ... moved' instead), clears or re-queues needs-info without a label scan, re-points product_ulid, and --state can resurrect a mis-closed item. If you MEASURED an amount you ate, that is 'inventory eat', never this — a recount carries no consumption claim",
      },
      {
        usage: "inventory dismiss <ulid> [--non-inventory]",
        summary: "RETIRE a record that was never real stock — a phantom item, or a non-grocery receipt line (housewares). The ONLY terminal that claims neither consumption nor waste, so it never pollutes either telemetry: never close a phantom with 'event finished' (a consumption that didn't happen) or 'event tossed' (waste that didn't happen). --non-inventory also dismisses same-line siblings and teaches future receipts to skip the line. 409 if the item is already terminal",
      },
      {
        usage: "inventory merge <ulid> --into <ulid>",
        summary: "fold a DUPLICATE item (two records, ONE physical package) into a survivor: fills only the survivor's EMPTY identity fields, relinks its entries/receipt line/conversions, then retires it as dismissed. Quantities are never summed and the survivor keeps its OWN clock — use this, not dismiss, whenever either record has history",
      },
      { usage: 'inventory remark "<free text>" [--at DATE]', summary: "free-text event resolver — matches a remark to an item and infers opened/finished/tossed; prints matched/unmatched honestly (unmatched is normal, not an error)" },
      { usage: "inventory questions [--limit N]", summary: "open needs-info items as one-time questions" },
      {
        usage: "inventory waste [--since DATE] [--until DATE] [--limit N]",
        summary:
          "the COSTED toss log — every recorded toss with the amount discarded and what it cost, scaled to the fraction (or sealed units) actually thrown out, never the whole package. Price comes from the item's OWN receipt line when knowable, else the nearest priced purchase of the product (cost_basis says which). A null cost with basis 'unknown' means no price is on file for that product — NOT that the food was free; totals sum only known costs and report the unknown rows separately. Dismissed/merged-away records never appear (retracting the record retracts its waste)",
      },
      {
        usage: "inventory convert [--from <ulid>[:amount]…] --to '<derived spec json>' [--at DATE]",
        summary: "prep transform: create a NEW derived item with its own clock + provenance (--to takes unit_seal alongside units_total for a counted batch: shared for a tray under one lid, individual for separately-lidded jars), optionally decrementing source item(s) (count or fraction); --from is OPTIONAL — with none it is a source-less \"I made this\" that decrements nothing. Pass --to recipe_ulid to make the item one-tap consume-eligible. THIS is how prepped food reaches the consume shelf — never plain 'inventory add'",
      },
      {
        usage: "inventory consume <item-ulid> [--quantity N] [--at DATE] [--ulid ENTRY_ULID]",
        summary: "one-tap: log a consumption entry with the item's EXACT known macros (no model call) and deplete it, in ONE atomic step; only recipe-linked derived items qualify (else 400); idempotent on --ulid",
      },
      {
        usage: "inventory eat <item-ulid> [--grams N|--fraction F] [--entry-ulid ENTRY_ULID] [--at DATE]",
        summary: "STATED-WEIGHT CONSUMPTION: a KNOWN weight or fraction eaten off an open DIVISIBLE item — a consumption, never a recount. Fraction-modeled items only (400 on a counted one — use finished-unit/consume there). Exactly one of --grams/--fraction; --grams needs the linked product's net_content_g and is REFUSED (400) without one, never guessed — pass --fraction instead. Reaching/passing zero goes terminal 'finished' (consumed, never tossed); a positive remainder stays open. --entry-ulid links an ALREADY-LOGGED consuming entry atomically with the deplete, and doubles as the idempotency key for a retry",
      },
    ],
  },
  {
    group: "Receipts",
    commands: [
      { usage: "receipts list [--limit N]", summary: "recent purchase batches with parse status" },
      { usage: "receipts show <ulid>", summary: "one batch plus its parsed line outcomes (matched/unmatched/pending)" },
      {
        usage: "receipts scan <photo…> [--store S] [--purchased-at DATE] [--ulid U]",
        summary: "post a purchase batch from receipt photos (parses asynchronously); meta is sent as a form field per the module's part-type rule",
      },
    ],
  },
  {
    group: "Recipes",
    commands: [
      { usage: "recipes list [--limit N]", summary: "the reselect strip — merged sheet + pushed + promoted recipes plus recent/frequent logged items" },
      {
        usage: "recipes push '<recipe json>' [--ulid U]",
        summary:
          'agent-authored template: {"name": "...", "components": [{label, default_qty_g, per_100g:{calories, protein_g, sat_fat_g}}]}. UPSERTS — a correction REPLACES rather than forks: the key is the normalized name (case/spacing-insensitive), or --ulid for one specific record. Prints created vs replaced. A name already held by a promoted or sheet-sourced recipe is a 409 naming it (rename, or pass --ulid deliberately) — never a silent clobber and never a second same-named pill on the strip',
      },
      {
        usage: "recipes delete <ulid>",
        summary:
          "ARCHIVE a recipe — off the reselect strip permanently, but still resolvable by ulid, so entries logged from it and prepped items derived from it keep working. Idempotent; 404 for an unknown or sheet-sourced ulid (the meal-bank sheet is never written from here). There is no hard delete",
      },
      { usage: "recipes promote <entry-ulid> --name NAME", summary: "create a reusable recipe from a logged entry" },
    ],
  },
  {
    group: "Products & lexicon",
    commands: [
      { usage: "products list [--q TEXT] [--limit N]", summary: "products (durable item facts); --q substring-matches name/aliases" },
      {
        usage: "products add --name NAME [--ulid U] [--shelf-life C] [--aliases a,b] [--package-size S] [--nutrition '<json>'] [--negligible] [--shelf-life-days-unopened N] [--shelf-life-days-opened N]",
        summary: "seed a product — UPSERTS on --ulid (create/replace) or the normalized name (enrich in place)",
      },
      {
        usage: "products update <ulid> [--name NAME] [--nutrition '<json>'] [--negligible|--no-negligible|--force-negligible] [any add flag]",
        summary: "correct a product in place — partial, only the flags you pass change (the door for adding nutrition later). --negligible is REFUSED for anything salt-bearing (garlic powder qualifies; garlic salt does not) — --force-negligible overrides",
      },
      {
        usage: "products prices <ulid> [--store S] [--limit N]",
        summary:
          "PRICE HISTORY — every recorded purchase of one product, newest first, with the printed price, the per-package price (line price ÷ quantity), and a NORMALIZED per-100g/per-100ml unit price plus the basis that produced it (a measure on the line, the store's lexicon package size, the product's label net content, or its package-size string). Compare the per-100 columns, never the raw prices: a 12 oz and a 16 oz package are not comparable at face value. A null unit price means no package size resolved for that purchase — nothing is guessed. Derived at read time from the receipt lines themselves, so nothing is stored and a corrected line corrects the history",
      },
      {
        usage: "products merge <ulid> --into <ulid>",
        summary: "fold a duplicate into a survivor: relink its items/lexicon/batch lines, then retire it",
      },
      {
        usage: "products archive <ulid>",
        summary: "retire a product (soft — still resolvable by ulid so linked items keep working)",
      },
      {
        usage: "products panel-basis-report",
        summary:
          "READ-ONLY: products whose stored per-100g disagrees with the value derivable from their own serving basis (nutrition_per_serving ÷ serving_size_g × 100) beyond an 8% + 0.6 per-field tolerance. Never rewrites anything — flagged rows need `products update <ulid>` once you know which number is right",
      },
      { usage: "lexicon list [--store S] [--limit N]", summary: "receipt-line → product mappings per store" },
      {
        usage: "lexicon add --store S --line-text T --product-ulid U [--package-size S] [--shelf-life C]",
        summary: "map a store's receipt line to a product (upserts on store+line; future receipts auto-resolve)",
      },
    ],
  },
];

/**
 * The full grouped command reference (usage + one-line summary per command) as
 * plain text — the canonical surface carried by `kitchen-axi --help`. Derived
 * from `COMMAND_GROUPS`, the same source the SKILL.md reference splices from.
 */
export function commandReferenceText(): string {
  return COMMAND_GROUPS.map((g) => {
    const items = g.commands.map((c) => `  ${c.usage}\n      ${c.summary}`).join("\n");
    return `${g.group}:\n${items}`;
  }).join("\n\n");
}

/** The generic "how to explore the CLI" discovery pointer for `help[]` blocks. */
export function discoveryHelp(invocation: string): string {
  return `Run \`${invocation} --help\` for the full command list, or \`${invocation} <group> --help\` for usage on any command group`;
}

/** Shelf-life class enum (mirrors kitchen.shelf_life_class), for help text. */
export const SHELF_LIFE_CLASSES = [
  "pantry",
  "frozen",
  "fridge_long",
  "fridge_short",
  "produce",
  "very_perishable",
  // A cooked/assembled dish — ages from its make date. It was missing here while
  // being a real member of the enum, so `inventory add --shelf-life prepared` was
  // refused client-side for a class the server accepts.
  "prepared",
  "unknown",
] as const;

/**
 * Classes a **storage move** may name as a destination (§ Storage moves): every
 * real class except `unknown`, because a move states where the item now LIVES and
 * `unknown` is not a place. A genuinely unknown class is a `recount`.
 */
export const STORAGE_MOVE_SHELF_LIFE_CLASSES = SHELF_LIFE_CLASSES.filter(
  (cls) => cls !== "unknown"
);

/**
 * What a counted package's seal encloses (§ count-vs-fraction): `individual` —
 * each unit separately sealed (a can 3-pack), so opening one leaves the rest at
 * the unopened window; `shared` — one seal over all the units (a 4-link vacuum
 * pack, a sliced loaf), so opening puts the whole remainder on the opened clock.
 */
export const UNIT_SEALS = ["individual", "shared"] as const;

/**
 * Made-food shelf-life classes a `convert` derived item may take (§ Shelf-life
 * classes — "A `convert` derived item accepts only made-food shelf-life
 * classes"). `prepared` is the default when a caller names none.
 */
export const CONVERT_SHELF_LIFE_CLASSES = [
  "prepared",
  "produce",
  "very_perishable",
  "frozen",
] as const;

/**
 * Package-durable classes a `convert` derived item may NOT take — their clock
 * anchors to a sealed store package's unopened window, absurd on a homemade
 * item. `convert` rejects them with a `400`; the CLI blocks them before the call.
 */
export const PACKAGE_DURABLE_SHELF_LIFE_CLASSES = [
  "pantry",
  "fridge_long",
  "fridge_short",
] as const;
