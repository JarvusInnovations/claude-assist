import { api } from "../client.js";
import { AxiError } from "axi-sdk-js";
import { parseArgs, requirePositional, requireFlag, captureJson, parseNumberFlag, parseJson } from "../args.js";
import { renderList, renderDetail, renderObject, renderOutput, renderHelp, count, field, custom, type FieldDef } from "../toon.js";
import { cliInvocation } from "../invocation.js";

export const RECIPES_HELP = `kitchen-axi recipes <subcommand> [args] [--json-out[=path]]

  --json-out[=path] on any subcommand writes the full JSON response to a file
  (bare: an owner-only temp file); stdout stays the TOON view.

  list [--q TEXT] [--limit N]       the reselect strip: merged sheet + pushed +
                                      promoted recipes, plus recent logged items.
                                      --q matches recipe names AND recent labels
                                      (substring), server-side before --limit
  push '<recipe json>' [--ulid U]   agent-authored template; body is
                                      {"name": "...", "components": [
                                        {"label": "...", "default_qty_g": N,
                                         "per_100g": {"calories": N, "protein_g": N,
                                                      "sat_fat_g": N}} ]}
  delete <ulid>                     ARCHIVE a recipe: off the strip for good,
                                      still resolvable for historical entries
  promote <entry-ulid> --name NAME  create a reusable recipe from a logged entry

  push UPSERTS — correcting a recipe replaces it instead of forking. The key is
  the normalized name (case/spacing-insensitive), or --ulid to replace one
  specific record. A name already held by a promoted or sheet-sourced recipe is
  a 409, never a silent clobber: rename, or pass --ulid deliberately. Recipes
  are tapped by NAME on the strip, so two same-named recipes are
  indistinguishable and the stale one keeps logging wrong numbers.

  delete never destroys — it archives. Entries, promotions, and prepped-item
  provenance point at recipes and must keep resolving.`;

const RECIPE_SCHEMA: FieldDef[] = [
  field("ulid"),
  field("name"),
  field("source"),
  count("components"),
];

const RECENT_SCHEMA: FieldDef[] = [
  field("label"),
  field("log_count"),
  field("calories"),
  field("protein_g"),
  { type: "dateOnly", key: "last_logged_at" },
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
    case "delete":
      return deleteRecipe(rest);
    case "promote":
      return promote(rest);
    default:
      throw new AxiError(`Unknown recipes subcommand: ${sub}`, "VALIDATION_ERROR", [RECIPES_HELP]);
  }
}

async function listRecipes(args: string[]): Promise<string> {
  const { flags } = parseArgs("recipes list", args);
  const q = typeof flags.q === "string" ? flags.q : undefined;
  const limit = typeof flags.limit === "string" ? String(parseNumberFlag(flags.limit, "limit", RECIPES_HELP, { min: 1 })) : undefined;
  const strip = await api.get("/api/kitchen/reselect", { q, limit });
  captureJson(strip);
  const recipes = strip?.recipes ?? [];
  const recent = strip?.recent ?? [];
  return renderOutput([
    renderList("recipes", recipes, RECIPE_SCHEMA),
    renderList("recent", recent, RECENT_SCHEMA),
  ]);
}

async function pushRecipe(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs("recipes push", args);
  const jsonArg = positionals[0];
  if (!jsonArg) {
    throw new AxiError("recipes push needs a recipe JSON body", "VALIDATION_ERROR", [RECIPES_HELP]);
  }
  const body = parseJson(jsonArg, "recipe", RECIPES_HELP) as Record<string, unknown>;
  // --ulid wins over a ulid inside the JSON body; both is a contradiction worth
  // failing on rather than silently picking one.
  if (typeof flags.ulid === "string") {
    if (typeof body.ulid === "string" && body.ulid !== flags.ulid) {
      throw new AxiError(
        `recipes push: --ulid (${flags.ulid}) disagrees with the ulid in the JSON body (${body.ulid})`,
        "VALIDATION_ERROR",
        [RECIPES_HELP],
      );
    }
    body.ulid = flags.ulid;
  }

  const { status, body: recipe } = await api.postWithStatus("/api/kitchen/recipes", body);
  captureJson(recipe);
  const created = status === 201;
  const cli = cliInvocation();
  return renderOutput([
    renderDetail(created ? "created" : "replaced", recipe, [
      ...RECIPE_SCHEMA,
      custom("components", (r) => JSON.stringify(r.components ?? [])),
    ]),
    renderHelp([
      created
        ? `New recipe — pushing this same name again REPLACES this record rather than forking it`
        : `Upsert on name: recipe ${recipe?.ulid} was replaced in place, so the strip still shows one pill`,
      `Run \`${cli} recipes delete ${recipe?.ulid}\` to retire it (archives; history keeps resolving)`,
    ]),
  ]);
}

async function deleteRecipe(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs("recipes delete", args);
  const ulid = requirePositional(positionals, 0, "recipe ulid", RECIPES_HELP);
  const archived = await api.delJson(`/api/kitchen/recipes/${encodeURIComponent(ulid)}`);
  captureJson(archived);
  return renderOutput([
    renderObject({ archived: archived?.ulid, name: archived?.name, archived_at: archived?.archived_at }),
    renderHelp([
      "Archived, not deleted — gone from the strip, still resolvable by ulid so entries logged from it (and prepped items derived from it) keep working",
    ]),
  ]);
}

async function promote(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs("recipes promote", args);
  const ulid = requirePositional(positionals, 0, "entry ulid", RECIPES_HELP);
  const name = requireFlag(flags, "name", RECIPES_HELP);
  const recipe = await api.post(`/api/kitchen/entries/${encodeURIComponent(ulid)}/promote`, { name });
  captureJson(recipe);
  return renderDetail("recipe", recipe, RECIPE_SCHEMA);
}
