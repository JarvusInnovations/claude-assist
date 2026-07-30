import { api } from "../client.js";
import { AxiError } from "axi-sdk-js";
import { parseArgs, requireFlag, requirePositional, rawJson, parseNumberFlag, parseJson, splitCsv } from "../args.js";
import { renderList, renderDetail, renderObject, renderOutput, renderHelp, field, joinArray, type FieldDef } from "../toon.js";
import { SHELF_LIFE_CLASSES } from "../reference.js";

export const PRODUCTS_HELP = `kitchen-axi products <subcommand> [args] [--json]

  list [--q TEXT] [--limit N]       products (durable item facts); --q matches
                                      name/aliases (substring). Archived
                                      (retired/merged) products are excluded
  add --name NAME [flags]           seed a product — UPSERTS (see below)
       [--ulid U] [--shelf-life C] [--aliases a,b] [--package-size S]
       [--nutrition '<json>'] [--nutrition-per-serving '<json>']
       [--serving-size-g N] [--servings-per-container N]
       [--net-content-g N] [--net-content-ml N] [--unit-model counted|fraction]
       [--unit-edible-g N] [--nutrition-source label|reference|estimate]
       [--ingredients TEXT] [--negligible] [--force-negligible]
       [--shelf-life-days-unopened N] [--shelf-life-days-opened N]
  update <ulid> [same flags]        correct a product IN PLACE — partial, so
                                      only the flags you pass change. Also
                                      [--name NAME] to rename, and
                                      [--no-negligible] to un-mark
  prices <ulid> [--store S] [--limit N]
                                    PRICE HISTORY: every recorded purchase of
                                      this product, newest first, normalized to
                                      a comparable unit price
  merge <ulid> --into <ulid>        fold a DUPLICATE into a survivor: relink its
                                      items, receipt-lexicon lines, and batch
                                      lines, then retire it
  archive <ulid>                    retire a product (soft; still resolvable by
                                      ulid so linked items keep working)

  shelf-life classes: ${SHELF_LIFE_CLASSES.join(", ")}
  --nutrition is a JSON object of per-100g macros, e.g.
    '{"calories": 52, "protein_g": 0.3, "carbs_g": 14, "fiber_g": 2.4, "sugar_g": 10, "added_sugar_g": 0}'
  --ingredients is the printed ingredients list as a single string

  --unit-edible-g is the edible mass of ONE physical unit of a counted product
  (one egg, one can, one link) — STATED only, never computed from
  --serving-size-g or from a net weight divided by a count; both of those can
  be wrong for a unit in opposite directions, so enter this only when you know
  the actual per-unit weight. Null leaves the product ineligible for one-tap
  consume.
  --nutrition-source records where the panel came from: label (scanned
  package, authoritative for that SKU), reference (correct for the food but
  generic for the SKU — the only option for unpackaged produce), or estimate
  (a guess). One-directional: nothing can move an existing 'label' to
  'reference'/'estimate' — that write is silently refused, on add and
  update alike.

  add UPSERTS. With --ulid it creates-or-REPLACES that record (a replace states
  the whole record: anything you omit reverts to its default, which is the only
  way to clear a field). Without --ulid the key is the normalized name
  (case/spacing-insensitive) and a single match is ENRICHED — supplied fields
  win, omitted ones keep what was there, so a bare --name re-seed can never
  erase a nutrition panel. Two same-named products are a 409 naming both:
  pass --ulid, or merge them.

  update is the partial door: pass only what changes. It is also the only way to
  CLEAR a field — pass the flag with an empty value (e.g. --package-size '') or
  a null inside --nutrition (e.g. '{"sodium_mg": null}' clears just sodium).

  --negligible asserts every panel field is ~0 at any realistic serving —
  spices, dried herbs, vinegar, black coffee, extracts. It clears the
  needs-nutrition flag HONESTLY and makes the product contribute zeros instead
  of nulls. Use it only for that: a US spice jar carries no Nutrition Facts
  panel at all (FDA exempts insignificant amounts), so there is nothing to
  scan and the flag is otherwise unclearable. Never a shortcut for "I don't
  feel like scanning this".

  SALT IS NOT NEGLIGIBLE. Table salt is ~0 on eight panel fields and ~38,700 mg
  of sodium per 100 g on the ninth — a teaspoon is a whole day's ceiling — so
  marking it would assert zero sodium for the biggest sodium line in the house.
  Garlic powder qualifies; garlic salt does not. --negligible is REFUSED (400)
  for a product whose name, aliases, ingredients, or stated sodium say it
  carries salt; also covered: bouillon, MSG, baking soda/powder, soy and fish
  sauce, and any blend whose ingredients list salt. Pass --force-negligible to
  mark it anyway when a realistic serving really does contribute ~0 sodium
  (flaked finishing salt used a few crystals at a time).

  archive never destroys, and merge never deletes the duplicate — inventory
  items, lexicon lines, and receipt batch lines point at products and must keep
  resolving.

  prices reads what receipts already recorded — nothing is stored for it, so a
  corrected line or a re-scanned label corrects the history immediately. Each
  point carries the printed price, the per-package price (the line price ÷ its
  quantity), and a NORMALIZED unit price with the basis that produced it: a
  measure on the line itself, the lexicon package size for that store's line
  text, the product's label net content, or its package-size string. Compare
  cents_per_100g (or cents_per_100ml) across points, NOT the raw prices — a 12
  oz and a 16 oz package are not comparable at face value. A null unit price
  means no package size could be resolved for that purchase, so nothing was
  guessed; scan the label or set --package-size to fix it. Weight and volume
  are never cross-converted, so a product bought both ways yields two series.`;

const PRODUCT_ROW_SCHEMA: FieldDef[] = [
  field("ulid"),
  field("name"),
  field("shelf_life_class", "shelf_life"),
  joinArray("aliases", undefined, "aliases"),
  field("package_size", "pkg"),
  { type: "boolYesNo", key: "nutrition_negligible", as: "negligible" },
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
  field("unit_edible_g"),
  field("nutrition_source"),
  { type: "boolYesNo", key: "nutrition_negligible", as: "negligible" },
  field("ingredients"),
];

/**
 * A price point leads with when/where, then the printed price, then the
 * normalized comparison. `basis` sits beside the per-100 columns because a null
 * there is only readable as "no size resolved" when the basis says so.
 */
const PRICE_POINT_SCHEMA: FieldDef[] = [
  field("purchased_at", "date"),
  field("store"),
  field("raw_text", "line"),
  field("quantity", "qty"),
  field("price_cents", "price¢"),
  field("package_price_cents", "per_pkg¢"),
  field("cents_per_100g", "per_100g¢"),
  field("cents_per_100ml", "per_100ml¢"),
  field("unit_basis", "basis"),
];

/** The write flags shared by `add` and `update` (single-sourced so they can't drift). */
const WRITE_VALUE_FLAGS = [
  "name",
  "ulid",
  "shelf-life",
  "aliases",
  "package-size",
  "nutrition",
  "nutrition-per-serving",
  "serving-size-g",
  "servings-per-container",
  "net-content-g",
  "net-content-ml",
  "unit-model",
  "unit-edible-g",
  "nutrition-source",
  "ingredients",
  "shelf-life-days-unopened",
  "shelf-life-days-opened",
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
    case "update":
      return updateProduct(rest);
    case "prices":
      return productPrices(rest);
    case "merge":
      return mergeProduct(rest);
    case "archive":
      return archiveProduct(rest);
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

/**
 * Build the write body from the flags actually supplied. `update` sends only
 * these keys, which is what makes a PATCH partial — an absent flag means "leave
 * it alone", and an empty-string flag means "clear it" (null on the wire).
 */
export function buildProductWriteBody(flags: Record<string, string | boolean>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const text = (flag: string, key: string) => {
    const v = flags[flag];
    if (typeof v !== "string") return;
    body[key] = v === "" ? null : v;
  };
  const num = (flag: string, key: string) => {
    const v = flags[flag];
    if (typeof v !== "string") return;
    body[key] = v === "" ? null : parseNumberFlag(v, flag, PRODUCTS_HELP, { min: 0 });
  };

  if (typeof flags.name === "string") body.name = flags.name;
  if (typeof flags["shelf-life"] === "string") body.shelf_life_class = validateShelfLife(flags["shelf-life"]);
  if (typeof flags.aliases === "string") body.aliases = splitCsv(flags.aliases);
  text("package-size", "package_size");
  text("ingredients", "ingredients");
  if (typeof flags.nutrition === "string") {
    body.nutrition_per_100g = flags.nutrition === "" ? null : parseJson(flags.nutrition, "--nutrition", PRODUCTS_HELP);
  }
  if (typeof flags["nutrition-per-serving"] === "string") {
    body.nutrition_per_serving =
      flags["nutrition-per-serving"] === ""
        ? null
        : parseJson(flags["nutrition-per-serving"], "--nutrition-per-serving", PRODUCTS_HELP);
  }
  num("serving-size-g", "serving_size_g");
  num("servings-per-container", "servings_per_container");
  num("net-content-g", "net_content_g");
  num("net-content-ml", "net_content_ml");
  num("shelf-life-days-unopened", "shelf_life_days_unopened");
  num("shelf-life-days-opened", "shelf_life_days_opened");
  num("unit-edible-g", "unit_edible_g");
  if (typeof flags["unit-model"] === "string") {
    body.unit_model_hint = flags["unit-model"] === "" ? null : validateUnitModel(flags["unit-model"]);
  }
  if (typeof flags["nutrition-source"] === "string") {
    body.nutrition_source = flags["nutrition-source"] === "" ? null : validateNutritionSource(flags["nutrition-source"]);
  }
  // --force-negligible IMPLIES --negligible: the only reason to reach for the
  // override is to make the assertion the guard just refused, so making it
  // stand alone saves the round trip and removes a way to get it half-right.
  if (flags.negligible || flags["force-negligible"]) body.nutrition_negligible = true;
  if (flags["force-negligible"]) body.nutrition_negligible_override = true;
  if (flags["no-negligible"]) body.nutrition_negligible = false;
  return body;
}

async function addProduct(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json", "negligible", "no-negligible", "force-negligible"], WRITE_VALUE_FLAGS);
  requireFlag(flags, "name", PRODUCTS_HELP);
  const body = buildProductWriteBody(flags);
  if (typeof flags.ulid === "string") body.ulid = flags.ulid;

  const { status, body: product } = await api.postWithStatus("/api/kitchen/products", body);
  if (flags.json) return rawJson(product);
  const created = status === 201;
  return renderOutput([
    renderDetail(created ? "created" : body.ulid ? "replaced" : "enriched", product, PRODUCT_DETAIL_SCHEMA),
    renderHelp([
      created
        ? "New product — adding this same name again ENRICHES this record rather than forking it"
        : body.ulid
          ? `Explicit-ulid replace: ${product?.ulid} now states exactly what you passed (omitted fields reverted)`
          : `Upsert on name: ${product?.ulid} was enriched in place — supplied fields won, the rest were kept`,
    ]),
  ]);
}

async function updateProduct(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json", "negligible", "no-negligible", "force-negligible"], WRITE_VALUE_FLAGS);
  const ulid = requirePositional(positionals, 0, "product ulid", PRODUCTS_HELP);
  const body = buildProductWriteBody(flags);
  if (Object.keys(body).length === 0) {
    throw new AxiError("update needs at least one field flag to change", "VALIDATION_ERROR", [PRODUCTS_HELP]);
  }
  const product = await api.patch(`/api/kitchen/products/${encodeURIComponent(ulid)}`, body);
  if (flags.json) return rawJson(product);
  return renderOutput([
    renderDetail("updated", product, PRODUCT_DETAIL_SCHEMA),
    renderHelp([
      "Only the flags you passed changed; a nutrition panel merges per-field, so filling one field never restates the other eight",
    ]),
  ]);
}

async function productPrices(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], ["store", "limit"]);
  const ulid = requirePositional(positionals, 0, "product ulid", PRODUCTS_HELP);
  const store = typeof flags.store === "string" ? flags.store : undefined;
  const limit = typeof flags.limit === "string" ? String(parseNumberFlag(flags.limit, "limit", PRODUCTS_HELP, { min: 1 })) : undefined;
  const result = await api.get(`/api/kitchen/products/${encodeURIComponent(ulid)}/prices`, { store, limit });
  if (flags.json) return rawJson(result);
  const points = result?.points ?? [];
  return renderOutput([
    renderObject({ product: result?.product_name, ulid: result?.product_ulid, purchases: result?.count ?? 0 }),
    renderList("prices", points, PRICE_POINT_SCHEMA),
    renderHelp([
      "Compare per_100g / per_100ml, not price¢ — package sizes differ between purchases and stores",
      "A null per_100g/per_100ml with basis null means no package size resolved for that purchase; nothing was guessed. Scan the label, or set the size with `products update <ulid> --package-size '16 oz'`",
    ]),
  ]);
}

async function mergeProduct(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], ["into"]);
  const ulid = requirePositional(positionals, 0, "duplicate product ulid", PRODUCTS_HELP);
  const into = requireFlag(flags, "into", PRODUCTS_HELP);
  const result = await api.post(`/api/kitchen/products/${encodeURIComponent(ulid)}/merge`, { into });
  if (flags.json) return rawJson(result);
  return renderOutput([
    renderDetail("survivor", result?.product ?? {}, PRODUCT_DETAIL_SCHEMA),
    renderObject({
      retired: result?.merged?.ulid,
      retired_name: result?.merged?.name,
      relinked_items: result?.relinked?.items,
      relinked_lexicon_lines: result?.relinked?.lexicon_lines,
      relinked_batch_lines: result?.relinked?.batch_lines,
    }),
    renderHelp([
      "The duplicate's items, lexicon lines, and batch lines now point at the survivor; its facts filled whatever the survivor lacked and its old name became an alias",
      "The duplicate is archived, not deleted — off every listing, still resolvable by ulid",
    ]),
  ]);
}

async function archiveProduct(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], []);
  const ulid = requirePositional(positionals, 0, "product ulid", PRODUCTS_HELP);
  const archived = await api.delJson(`/api/kitchen/products/${encodeURIComponent(ulid)}`);
  if (flags.json) return rawJson(archived);
  return renderOutput([
    renderObject({ archived: archived?.ulid, name: archived?.name, archived_at: archived?.archived_at }),
    renderHelp([
      "Archived, not deleted — off every listing and no longer a name-match candidate, still resolvable by ulid so linked items keep rendering",
      "For a duplicate, prefer `products merge <dupe> --into <survivor>` so its items and lexicon mappings move rather than being stranded",
    ]),
  ]);
}

function validateShelfLife(value: string): string {
  if (!(SHELF_LIFE_CLASSES as readonly string[]).includes(value)) {
    throw new AxiError(`--shelf-life must be one of: ${SHELF_LIFE_CLASSES.join(", ")}`, "VALIDATION_ERROR", [PRODUCTS_HELP]);
  }
  return value;
}

function validateUnitModel(value: string): string {
  if (value !== "counted" && value !== "fraction") {
    throw new AxiError("--unit-model must be counted or fraction", "VALIDATION_ERROR", [PRODUCTS_HELP]);
  }
  return value;
}

function validateNutritionSource(value: string): string {
  if (value !== "label" && value !== "reference" && value !== "estimate") {
    throw new AxiError("--nutrition-source must be label, reference, or estimate", "VALIDATION_ERROR", [PRODUCTS_HELP]);
  }
  return value;
}
