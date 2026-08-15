import { api } from "../client.js";
import { AxiError } from "axi-sdk-js";
import { parseArgs, requirePositional } from "../args.js";
import { renderObject, renderOutput, renderHelp } from "../toon.js";

export const PREP_HELP = `kitchen-axi prep <subcommand> [args] [--json]

  publish --slug S --label T            build a prep WORKSHEET from the catalog and
       [--component <product-ulid>=<g>]…  publish it. Components resolve to the
       [--component-item <item-ulid>=<g>]…  product's stored per-100g panel, so no
       [--recipe <recipe-ulid>]            seed rows from a recipe's lines; explicit
                                            components are appended after them
       [--step "<text>"]…                  instructions rendered under the table
       [--heading T] [--intro T]
       [--cook eaten|packed]               submitting the sheet IS the write
       [--units N] [--shelf-life C]        (packed only) the derived item's shape
       [--source <item-ulid>[:amount]]…    (packed only) stock the batch consumes
       [--title T] [--digest-optin]

  A worksheet's per_basis blocks are reference values this module already stores.
  Assembling them by hand re-derives numbers the catalog holds — the same
  estimation-by-recall failure the nutrition-panel rules exist to prevent, moved
  into the authoring path. So components are named by ULID, never by macros.

  A product with NO stored panel is refused rather than guessed at: seed or scan
  it first. A product missing ONE field contributes 'unknown' to that total, never
  zero — the sheet reports which fields came back unknown.

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

function asList(value: unknown): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as string[]) : [String(value)];
}

async function publishPrep(args: string[]): Promise<string> {
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
      "recipe",
      "step",
      "cook",
      "units",
      "shelf-life",
      "source",
      "submit-label",
    ]
  );

  const slug = typeof flags.slug === "string" ? flags.slug : undefined;
  const label = typeof flags.label === "string" ? flags.label : undefined;
  if (!slug || !label) {
    throw new AxiError("prep publish needs --slug and --label", "VALIDATION_ERROR", [PREP_HELP]);
  }

  const components = [
    ...asList(flags.component).map((raw) => {
      const { ulid, quantity } = parseRef(raw, "--component");
      return { product_ulid: ulid, quantity };
    }),
    ...asList(flags["component-item"]).map((raw) => {
      const { ulid, quantity } = parseRef(raw, "--component-item");
      return { item_ulid: ulid, quantity };
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
  if (cook !== "packed" && (flags.units || flags["shelf-life"] || flags.source)) {
    throw new AxiError(
      "--units, --shelf-life and --source apply to --cook packed only: an eaten sheet writes one entry, not stock",
      "VALIDATION_ERROR",
      [PREP_HELP]
    );
  }

  const sources = asList(flags.source).map((raw) => {
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
    ...(asList(flags.step).length ? { steps: asList(flags.step) } : {}),
    ...(cook
      ? {
          cook: {
            disposition: cook,
            ...(flags.units ? { units: Number(flags.units) } : {}),
            ...(typeof flags["shelf-life"] === "string" ? { shelf_life_class: flags["shelf-life"] } : {}),
            ...(sources.length ? { sources } : {}),
          },
        }
      : {}),
    ...(flags["digest-optin"] ? { digest_optin: true } : {}),
  };

  const result = await api.post("/api/kitchen/prep", body);
  if (flags.json) return JSON.stringify(result, null, 2);

  const totals = result?.planned_totals ?? {};
  const unknown: string[] = result?.unknown_fields ?? [];

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
      "Nothing was written to the ledger; stock moves when the sheet is submitted",
    ]),
  ]);
}
