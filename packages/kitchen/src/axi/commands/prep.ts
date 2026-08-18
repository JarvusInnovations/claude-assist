import { api } from "../client.js";
import { AxiError } from "axi-sdk-js";
import { parseArgs, collectFlag } from "../args.js";
import { renderObject, renderOutput, renderHelp } from "../toon.js";

export const PREP_HELP = `kitchen-axi prep <subcommand> [args] [--json]

  publish --slug S --label T            build a prep WORKSHEET from the catalog and
       [--component <product-ulid>=<g>]…  publish it. Components resolve to the
       [--component-item <item-ulid>=<g>]…  product's stored per-100g panel, so no
       [--component-unit <item-ulid>=<n>]…  COUNTED stock, in whole units
       [--recipe <recipe-ulid>]            seed rows from a recipe's lines; explicit
                                            components are appended after them
       [--step "<text>"]…                  instructions rendered under the table
       [--heading T] [--intro T]
       [--cook eaten|packed]               submitting the sheet IS the write
       [--units N] [--shelf-life C]        (packed only) the derived item's shape
       [--yields-recipe <recipe-ulid>]     (packed only) macro provenance for the
                                            batch. WITHOUT it the derived item can
                                            never be one-tap consumed or named as a
                                            sheet component — its macros live
                                            nowhere
       [--source <item-ulid>[:amount]]…    (packed only) stock the batch consumes
                                            at a FIXED amount — for inputs the
                                            sheet does not weigh. A source that
                                            IS a component binds automatically
                                            and follows the submitted weight
       [--components-per batch|unit]       (packed only) do the component
                                            quantities describe ONE unit or the
                                            whole batch? default batch
       [--title T] [--digest-optin]

  A worksheet's per_basis blocks are reference values this module already stores.
  Assembling them by hand re-derives numbers the catalog holds — the same
  estimation-by-recall failure the nutrition-panel rules exist to prevent, moved
  into the authoring path. So components are named by ULID, never by macros.

  A product with NO stored panel is refused rather than guessed at: seed or scan
  it first. A product missing ONE field contributes 'unknown' to that total, never
  zero — the sheet reports which fields came back unknown.

  On a --cook sheet, --component (a product) does NOT bind to stock — only
  --component-item/--component-unit do, because a product is a catalog row, not
  stock. Submitting will NOT decrement a --component row; the sheet marks it
  "not tracked in stock" so this is visible on the page, not just in the reply
  below. That's fine for food that genuinely isn't tracked stock; for on-hand
  stock, use --component-item/--component-unit so the submission actually moves
  inventory.

  PUBLISHING WRITES NOTHING TO THE LEDGER. A definition is a form awaiting a real
  event; stock moves only when the submission lands.

examples:
  kitchen-axi prep publish --slug lunch-today --label "Grain bowl" \\
    --component 01ABC…=185 --component 01DEF…=120 --cook eaten
  kitchen-axi prep publish --slug oat-jars --label "Overnight oats" \\
    --component-item 01GHI…=240 --cook packed --units 3 --shelf-life prepared`;

export async function prepCommand(args: string[]): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "publish":
      return publishPrep(rest);
    default:
      throw new AxiError(`Unknown prep subcommand: ${sub}`, "VALIDATION_ERROR", [PREP_HELP]);
  }
}

/** Parse `<ulid>=<grams>` into its two halves. */
function parseRef(raw: string, flag: string): { ulid: string; quantity: number } {
  const eq = raw.lastIndexOf("=");
  if (eq <= 0) {
    throw new AxiError(`${flag} must be "<ulid>=<grams>" (got ${raw})`, "VALIDATION_ERROR", [PREP_HELP]);
  }
  const ulid = raw.slice(0, eq).trim();
  const quantity = Number(raw.slice(eq + 1).trim());
  if (!ulid || !Number.isFinite(quantity) || quantity < 0) {
    throw new AxiError(
      `${flag} must be "<ulid>=<grams>" with a non-negative number (got ${raw})`,
      "VALIDATION_ERROR",
      [PREP_HELP]
    );
  }
  return { ulid, quantity };
}

async function publishPrep(args: string[]): Promise<string> {
  // REPEATABLE flags must be read with collectFlag off the raw argv: parseArgs'
  // flag map is last-wins, so `--component a --component b` silently keeps only
  // `b`. This is the same helper `entries log` uses for its own --component.
  const componentArgs = collectFlag(args, "component");
  const componentItemArgs = collectFlag(args, "component-item");
  const componentUnitArgs = collectFlag(args, "component-unit");
  const stepArgs = collectFlag(args, "step");
  const sourceArgs = collectFlag(args, "source");

  const { flags } = parseArgs(
    args,
    ["json", "digest-optin"],
    [
      "slug",
      "label",
      "title",
      "heading",
      "intro",
      "component",
      "component-item",
      "component-unit",
      "recipe",
      "yields-recipe",
      "step",
      "cook",
      "units",
      "shelf-life",
      "source",
      "submit-label",
      "components-per",
    ]
  );

  const slug = typeof flags.slug === "string" ? flags.slug : undefined;
  const label = typeof flags.label === "string" ? flags.label : undefined;
  if (!slug || !label) {
    throw new AxiError("prep publish needs --slug and --label", "VALIDATION_ERROR", [PREP_HELP]);
  }

  const components = [
    ...componentArgs.map((raw) => {
      const { ulid, quantity } = parseRef(raw, "--component");
      return { product_ulid: ulid, quantity };
    }),
    ...componentItemArgs.map((raw) => {
      const { ulid, quantity } = parseRef(raw, "--component-item");
      return { item_ulid: ulid, quantity };
    }),
    // Counted stock is quantified in UNITS — one egg, one can, one link. No
    // grams-to-units conversion on the decrement side, and it is how a person
    // describes the food anyway.
    ...componentUnitArgs.map((raw) => {
      const { ulid, quantity } = parseRef(raw, "--component-unit");
      return { item_ulid: ulid, quantity, counted: true };
    }),
  ];
  const recipeUlid = typeof flags.recipe === "string" ? flags.recipe : undefined;
  if (components.length === 0 && !recipeUlid) {
    throw new AxiError(
      "prep publish needs at least one --component / --component-item, or --recipe to seed them",
      "VALIDATION_ERROR",
      [PREP_HELP]
    );
  }

  const cook = typeof flags.cook === "string" ? flags.cook : undefined;
  if (cook !== undefined && cook !== "eaten" && cook !== "packed") {
    throw new AxiError(`--cook must be 'eaten' or 'packed' (got ${cook})`, "VALIDATION_ERROR", [PREP_HELP]);
  }
  const yieldsRecipe = typeof flags["yields-recipe"] === "string" ? flags["yields-recipe"] : undefined;
  const componentsPer =
    typeof flags["components-per"] === "string" ? flags["components-per"] : undefined;
  if (componentsPer !== undefined && componentsPer !== "batch" && componentsPer !== "unit") {
    throw new AxiError(
      `--components-per must be 'batch' or 'unit' (got ${componentsPer})`,
      "VALIDATION_ERROR",
      [PREP_HELP]
    );
  }
  if (
    cook !== "packed" &&
    (flags.units || flags["shelf-life"] || sourceArgs.length || yieldsRecipe || componentsPer)
  ) {
    throw new AxiError(
      "--units, --shelf-life, --source, --yields-recipe and --components-per apply to --cook packed only: an eaten sheet writes one entry, not stock",
      "VALIDATION_ERROR",
      [PREP_HELP]
    );
  }
  // A per-unit sheet without a unit count has nothing to multiply by, and the
  // silent reading (x1) is exactly the under-decrement this flag exists to stop.
  if (componentsPer === "unit" && !flags.units) {
    throw new AxiError(
      "--components-per unit needs --units: it means each component is ONE unit's worth, so the batch consumes that much times the unit count",
      "VALIDATION_ERROR",
      [PREP_HELP]
    );
  }

  const sources = sourceArgs.map((raw) => {
    const [itemUlid, amount] = raw.split(":");
    return {
      item_ulid: itemUlid!.trim(),
      ...(amount !== undefined ? { amount: Number(amount) } : {}),
    };
  });

  const body = {
    slug,
    label,
    ...(typeof flags.title === "string" ? { title: flags.title } : {}),
    ...(typeof flags.heading === "string" ? { heading: flags.heading } : {}),
    ...(typeof flags.intro === "string" ? { intro: flags.intro } : {}),
    ...(typeof flags["submit-label"] === "string" ? { submit_label: flags["submit-label"] } : {}),
    ...(recipeUlid ? { recipe_ulid: recipeUlid } : {}),
    ...(components.length ? { components } : {}),
    ...(stepArgs.length ? { steps: stepArgs } : {}),
    ...(cook
      ? {
          cook: {
            disposition: cook,
            ...(flags.units ? { units: Number(flags.units) } : {}),
            ...(typeof flags["shelf-life"] === "string" ? { shelf_life_class: flags["shelf-life"] } : {}),
            ...(yieldsRecipe ? { recipe_ulid: yieldsRecipe } : {}),
            ...(sources.length ? { sources } : {}),
            ...(componentsPer ? { components_per: componentsPer } : {}),
          },
        }
      : {}),
    ...(flags["digest-optin"] ? { digest_optin: true } : {}),
  };

  const result = await api.post("/api/kitchen/prep", body);
  if (flags.json) return JSON.stringify(result, null, 2);

  const totals = result?.planned_totals ?? {};
  const unknown: string[] = result?.unknown_fields ?? [];
  const untracked: string[] = result?.untracked_components ?? [];

  return renderOutput([
    renderObject({
      published: result.slug,
      url: result.url,
      created: result.created,
      components: result.components?.length ?? 0,
    }),
    renderObject(
      Object.fromEntries(
        Object.entries(totals).map(([k, v]) => [`planned_${k}`, v === null ? "unknown" : v])
      ) as Record<string, unknown>
    ),
    renderHelp([
      "Planned quantities are DEFAULTS — the submitter's stated weights replace them",
      "Totals above are a preview; the stored numbers are computed server-side from the definition",
      ...(unknown.length
        ? [
            `UNKNOWN (no component carried these): ${unknown.join(", ")} — seed the missing product panels rather than reading the total as 0`,
          ]
        : []),
      ...(untracked.length
        ? [
            `NOT TRACKED IN STOCK (--component, not --component-item/--component-unit): ${untracked.join(", ")} — ` +
              `submitting will NOT decrement these, and the sheet itself now says so. If this food IS on-hand stock, ` +
              `republish with --component-item/--component-unit instead so the submission actually decrements it.`,
          ]
        : []),
      "Nothing was written to the ledger; stock moves when the sheet is submitted",
    ]),
  ]);
}
