import { api } from "../client.js";
import { AxiError } from "axi-sdk-js";
import { parseArgs, requireFlag, rawJson, parseNumberFlag, parseJson, splitCsv } from "../args.js";
import { renderList, renderDetail, field, joinArray, type FieldDef } from "../toon.js";
import { SHELF_LIFE_CLASSES } from "../reference.js";

export const PRODUCTS_HELP = `kitchen-axi products <subcommand> [args] [--json]

  list [--q TEXT] [--limit N]       products (durable item facts); --q matches
                                      name/aliases (substring)
  add --name NAME [flags]           seed a product
       [--shelf-life C] [--aliases a,b] [--package-size S]
       [--nutrition '<json>'] [--ingredients TEXT]
       [--shelf-life-days-unopened N] [--shelf-life-days-opened N]

  shelf-life classes: ${SHELF_LIFE_CLASSES.join(", ")}
  --nutrition is a JSON object of per-100g macros, e.g.
    '{"calories": 52, "protein_g": 0.3, "carbs_g": 14, "fiber_g": 2.4, "sugar_g": 10, "added_sugar_g": 0}'
  --ingredients is the printed ingredients list as a single string`;

const PRODUCT_ROW_SCHEMA: FieldDef[] = [
  field("ulid"),
  field("name"),
  field("shelf_life_class", "shelf_life"),
  joinArray("aliases", undefined, "aliases"),
  field("package_size", "pkg"),
];

const PRODUCT_DETAIL_SCHEMA: FieldDef[] = [
  field("ulid"),
  field("name"),
  field("shelf_life_class", "shelf_life"),
  joinArray("aliases", undefined, "aliases"),
  field("package_size", "pkg"),
  field("shelf_life_days_unopened", "days_unopened"),
  field("shelf_life_days_opened", "days_opened"),
  {
    type: "custom",
    as: "nutrition_per_100g",
    fn: (p) => (p.nutrition_per_100g ? JSON.stringify(p.nutrition_per_100g) : null),
  },
  field("ingredients"),
];

export async function productsCommand(args: string[]): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
    case undefined:
      return listProducts(sub === undefined ? args : rest);
    case "add":
      return addProduct(rest);
    default:
      throw new AxiError(`Unknown products subcommand: ${sub}`, "VALIDATION_ERROR", [PRODUCTS_HELP]);
  }
}

async function listProducts(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"], ["q", "limit"]);
  const q = typeof flags.q === "string" ? flags.q : undefined;
  const limit = typeof flags.limit === "string" ? String(parseNumberFlag(flags.limit, "limit", PRODUCTS_HELP, { min: 1 })) : undefined;
  const result = await api.get("/api/kitchen/products", { q, limit });
  if (flags.json) return rawJson(result);
  const products = result?.products ?? [];
  return renderList("products", products, PRODUCT_ROW_SCHEMA);
}

async function addProduct(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"], ["name", "shelf-life", "aliases", "package-size", "nutrition", "ingredients", "shelf-life-days-unopened", "shelf-life-days-opened"]);
  const name = requireFlag(flags, "name", PRODUCTS_HELP);
  const body: Record<string, unknown> = { name };
  if (typeof flags["shelf-life"] === "string") body.shelf_life_class = validateShelfLife(flags["shelf-life"]);
  if (typeof flags.aliases === "string") body.aliases = splitCsv(flags.aliases);
  if (typeof flags["package-size"] === "string") body.package_size = flags["package-size"];
  if (typeof flags.nutrition === "string") body.nutrition_per_100g = parseJson(flags.nutrition, "--nutrition", PRODUCTS_HELP);
  if (typeof flags.ingredients === "string") body.ingredients = flags.ingredients;
  if (typeof flags["shelf-life-days-unopened"] === "string") body.shelf_life_days_unopened = parseNumberFlag(flags["shelf-life-days-unopened"], "shelf-life-days-unopened", PRODUCTS_HELP, { min: 0 });
  if (typeof flags["shelf-life-days-opened"] === "string") body.shelf_life_days_opened = parseNumberFlag(flags["shelf-life-days-opened"], "shelf-life-days-opened", PRODUCTS_HELP, { min: 0 });

  const product = await api.post("/api/kitchen/products", body);
  if (flags.json) return rawJson(product);
  return renderDetail("product", product, PRODUCT_DETAIL_SCHEMA);
}

function validateShelfLife(value: string): string {
  if (!(SHELF_LIFE_CLASSES as readonly string[]).includes(value)) {
    throw new AxiError(`--shelf-life must be one of: ${SHELF_LIFE_CLASSES.join(", ")}`, "VALIDATION_ERROR", [PRODUCTS_HELP]);
  }
  return value;
}
