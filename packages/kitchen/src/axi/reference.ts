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

export const COMMAND_GROUPS: CommandGroup[] = [
  {
    group: "Entries",
    commands: [
      { usage: "entries list [--since DATE] [--limit N]", summary: "newest-first consumption entries (base macros + portion_multiplier; effective = base × multiplier)" },
      { usage: "entries show <ulid>", summary: "one entry with full nutrition, source, and status" },
      {
        usage: 'entries log [note…] [--recipe ULID] [--component "label=grams"]… [--at TIME] [--calories N] [--protein N] [--fat N] [--sat-fat N] [--carbs N] [--sugar N] [--fiber N] [--sodium N] [--label T]',
        summary: "log a deliberate, no-model entry (note and/or recipe + component quantities); recipe-referenced entries are computed deterministically; --at sets logged_at (default now — prefer a full local timestamp with offset; a bare YYYY-MM-DD backstops to local noon that day, never midnight UTC); a directly-stated panel (--calories/--protein/…, optionally --label) records a born-manual, terminal entry verbatim with NO estimation (mutually exclusive with --recipe/--component)",
      },
      {
        usage: "entries patch <ulid> [--note T] [--label T] [--calories N] [--protein N] [--fat N] [--sat-fat N] [--carbs N] [--sodium N] [--portion-basis T] [--multiplier M] [--at TIME]",
        summary: "edit an entry: note/label re-queue estimation; any macro sets a terminal manual override; --multiplier rescales the base post-hoc and --at backdates logged_at (prefer a full local timestamp with offset; a bare YYYY-MM-DD backstops to local noon that day; neither re-queues, neither changes source)",
      },
      { usage: "entries delete <ulid>", summary: "remove an entry from all rollups" },
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
        usage: "inventory add [--raw-label T] [--product-ulid U] [--store S] [--acquired-at DATE] [--fraction F] [--units-total N] [--state S] [--needs-info] [--shelf-life C] [--notes T] [--ulid U]",
        summary: "create an item directly (manual/verbal purchase or seed); --units-total makes it a counted item (sealed multipack) instead of fraction-modeled; idempotent when --ulid supplied",
      },
      {
        usage: "inventory event <ulid> <opened|finished|finished-unit|tossed> [--fraction F] [--at DATE]",
        summary: "explicit state change; for tossed, --fraction is the AMOUNT TOSSED (partial toss decrements + stays alive, terminal only at zero remainder or when omitted); finished-unit is a counted item's integer one-unit decrement",
      },
      { usage: 'inventory remark "<free text>" [--at DATE]', summary: "free-text event resolver — matches a remark to an item and infers opened/finished/tossed; prints matched/unmatched honestly (unmatched is normal, not an error)" },
      { usage: "inventory questions [--limit N]", summary: "open needs-info items as one-time questions" },
      {
        usage: "inventory convert [--from <ulid>[:amount]…] --to '<derived spec json>' [--at DATE]",
        summary: "prep transform: create a NEW derived item with its own clock + provenance, optionally decrementing source item(s) (count or fraction); --from is OPTIONAL — with none it is a source-less \"I made this\" that decrements nothing. Pass --to recipe_ulid to make the item one-tap consume-eligible. THIS is how prepped food reaches the consume shelf — never plain 'inventory add'",
      },
      {
        usage: "inventory consume <item-ulid> [--quantity N] [--at DATE] [--ulid ENTRY_ULID]",
        summary: "one-tap: log a consumption entry with the item's EXACT known macros (no model call) and deplete it, in ONE atomic step; only recipe-linked derived items qualify (else 400); idempotent on --ulid",
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
      { usage: "recipes push '<recipe json>'", summary: 'agent-authored template: {"name": "...", "components": [{label, default_qty_g, per_100g:{calories, protein_g, sat_fat_g}}]}' },
      { usage: "recipes promote <entry-ulid> --name NAME", summary: "create a reusable recipe from a logged entry" },
    ],
  },
  {
    group: "Products & lexicon",
    commands: [
      { usage: "products list [--q TEXT] [--limit N]", summary: "products (durable item facts); --q substring-matches name/aliases" },
      {
        usage: "products add --name NAME [--shelf-life C] [--aliases a,b] [--package-size S] [--nutrition '<json>'] [--shelf-life-days-unopened N] [--shelf-life-days-opened N]",
        summary: "seed a product",
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
  "unknown",
] as const;
