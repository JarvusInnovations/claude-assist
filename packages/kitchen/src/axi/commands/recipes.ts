import { api } from "../client.js";
import { AxiError } from "axi-sdk-js";
import { parseArgs, requirePositional, requireFlag, rawJson, parseNumberFlag, parseJson } from "../args.js";
import { renderList, renderDetail, renderOutput, count, field, custom, type FieldDef } from "../toon.js";

export const RECIPES_HELP = `kitchen-axi recipes <subcommand> [args] [--json]

  list [--limit N]                  the reselect strip: merged sheet + pushed +
                                      promoted recipes, plus recent logged items
  push '<recipe json>'              agent-authored template; body is
                                      {"name": "...", "components": [
                                        {"label": "...", "default_qty_g": N,
                                         "per_100g": {"calories": N, "protein_g": N,
                                                      "sat_fat_g": N}} ]}
  promote <entry-ulid> --name NAME  create a reusable recipe from a logged entry`;

const RECIPE_SCHEMA: FieldDef[] = [
  field("ulid"),
  field("name"),
  field("source"),
  count("components", "n_components"),
];

const RECENT_SCHEMA: FieldDef[] = [
  field("label"),
  field("log_count", "logged"),
  field("calories", "kcal"),
  field("protein_g", "protein"),
  { type: "dateOnly", key: "last_logged_at", as: "last" },
];

export async function recipesCommand(args: string[]): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
    case undefined:
      return listRecipes(sub === undefined ? args : rest);
    case "push":
      return pushRecipe(rest);
    case "promote":
      return promote(rest);
    default:
      throw new AxiError(`Unknown recipes subcommand: ${sub}`, "VALIDATION_ERROR", [RECIPES_HELP]);
  }
}

async function listRecipes(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"], ["limit"]);
  const limit = typeof flags.limit === "string" ? String(parseNumberFlag(flags.limit, "limit", RECIPES_HELP, { min: 1 })) : undefined;
  const strip = await api.get("/api/kitchen/reselect", { limit });
  if (flags.json) return rawJson(strip);
  const recipes = strip?.recipes ?? [];
  const recent = strip?.recent ?? [];
  return renderOutput([
    renderList("recipes", recipes, RECIPE_SCHEMA),
    renderList("recent", recent, RECENT_SCHEMA),
  ]);
}

async function pushRecipe(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], []);
  const jsonArg = positionals[0];
  if (!jsonArg) {
    throw new AxiError("recipes push needs a recipe JSON body", "VALIDATION_ERROR", [RECIPES_HELP]);
  }
  const body = parseJson(jsonArg, "recipe", RECIPES_HELP);
  const recipe = await api.post("/api/kitchen/recipes", body);
  if (flags.json) return rawJson(recipe);
  return renderDetail("recipe", recipe, [...RECIPE_SCHEMA, custom("components", (r) => JSON.stringify(r.components ?? []))]);
}

async function promote(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], ["name"]);
  const ulid = requirePositional(positionals, 0, "entry ulid", RECIPES_HELP);
  const name = requireFlag(flags, "name", RECIPES_HELP);
  const recipe = await api.post(`/api/kitchen/entries/${encodeURIComponent(ulid)}/promote`, { name });
  if (flags.json) return rawJson(recipe);
  return renderDetail("recipe", recipe, RECIPE_SCHEMA);
}
