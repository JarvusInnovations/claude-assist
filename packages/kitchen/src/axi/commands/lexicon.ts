import { api } from "../client.js";
import { AxiError } from "axi-sdk-js";
import { parseArgs, requireFlag, rawJson, parseNumberFlag } from "../args.js";
import { renderList, renderDetail, field, type FieldDef } from "../toon.js";
import { SHELF_LIFE_CLASSES } from "../reference.js";

export const LEXICON_HELP = `kitchen-axi lexicon <subcommand> [args] [--json]

  list [--store S] [--limit N]              receipt-line → product mappings
  add --store S --line-text T               map a store's receipt line to a
      --product-ulid U [--package-size S]     product; upserts on (store, line);
      [--shelf-life C]                        future receipts auto-resolve it

  shelf-life classes: ${SHELF_LIFE_CLASSES.join(", ")}`;

const LEXICON_SCHEMA: FieldDef[] = [
  field("store"),
  field("line_text", "line"),
  field("product_ulid"),
  field("package_size", "pkg"),
  field("shelf_life_class", "shelf_life"),
];

export async function lexiconCommand(args: string[]): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
    case undefined:
      return listLexicon(sub === undefined ? args : rest);
    case "add":
      return addLexicon(rest);
    default:
      throw new AxiError(`Unknown lexicon subcommand: ${sub}`, "VALIDATION_ERROR", [LEXICON_HELP]);
  }
}

async function listLexicon(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"], ["store", "limit"]);
  const store = typeof flags.store === "string" ? flags.store : undefined;
  const limit = typeof flags.limit === "string" ? String(parseNumberFlag(flags.limit, "limit", LEXICON_HELP, { min: 1 })) : undefined;
  const result = await api.get("/api/kitchen/lexicon", { store, limit });
  if (flags.json) return rawJson(result);
  const lines = result?.lines ?? [];
  return renderList("lexicon", lines, LEXICON_SCHEMA);
}

async function addLexicon(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"], ["store", "line-text", "product-ulid", "package-size", "shelf-life"]);
  const body: Record<string, unknown> = {
    store: requireFlag(flags, "store", LEXICON_HELP),
    line_text: requireFlag(flags, "line-text", LEXICON_HELP),
    product_ulid: requireFlag(flags, "product-ulid", LEXICON_HELP),
  };
  if (typeof flags["package-size"] === "string") body.package_size = flags["package-size"];
  if (typeof flags["shelf-life"] === "string") body.shelf_life_class = validateShelfLife(flags["shelf-life"]);

  const line = await api.post("/api/kitchen/lexicon", body);
  if (flags.json) return rawJson(line);
  return renderDetail("lexicon", line, LEXICON_SCHEMA);
}

function validateShelfLife(value: string): string {
  if (!(SHELF_LIFE_CLASSES as readonly string[]).includes(value)) {
    throw new AxiError(`--shelf-life must be one of: ${SHELF_LIFE_CLASSES.join(", ")}`, "VALIDATION_ERROR", [LEXICON_HELP]);
  }
  return value;
}
