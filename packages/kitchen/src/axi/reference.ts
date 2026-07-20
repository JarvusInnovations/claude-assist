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
        usage: 'entries log [note…] [--recipe ULID] [--component "label=grams"]… [--at TIME]',
        summary: "log a deliberate, no-model entry (note and/or recipe + component quantities); recipe-referenced entries are computed deterministically; --at sets logged_at (default now)",
      },
      {
        usage: "entries patch <ulid> [--note T] [--label T] [--calories N] [--protein N] [--fat N] [--sat-fat N] [--carbs N] [--sodium N] [--portion-basis T] [--multiplier M] [--at TIME]",
        summary: "edit an entry: note/label re-queue estimation; any macro sets a terminal manual override; --multiplier rescales the base post-hoc and --at backdates logged_at (neither re-queues, neither changes source)",
      },
      { usage: "entries delete <ulid>", summary: "remove an entry from all rollups" },
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
        usage: "inventory convert --from <ulid>[:amount]… --to '<derived spec json>' [--at DATE]",
        summary: "prep transform: decrement source item(s) (count or fraction) and create a NEW derived item with its own clock + derived-from provenance — distinct from consumption and from finished/tossed",
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
