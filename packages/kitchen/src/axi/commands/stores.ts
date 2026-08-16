import { api } from "../client.js";
import { AxiError } from "axi-sdk-js";
import { parseArgs, requirePositional } from "../args.js";
import { renderObject, renderOutput, renderHelp } from "../toon.js";

export const STORES_HELP = `kitchen-axi stores <subcommand> [args] [--json]

  list                                  every store string seen, from the
                                          lexicon and inventory items
  merge <from> --into <to>              fold one store string into another:
                                          re-points its lexicon rows and items,
                                          then records the alias

  A store accumulates spellings — the printed receipt header, a shorter name an
  operator types, a title-cased variant — and the lexicon keys on the string, so
  mappings written under one spelling can never match receipts printing another.

  MERGING IS A JUDGMENT AND IT IS NOT REVERSIBLE. Sharing a word is not enough:
  a standalone market and a supermarket whose name contains "market" are
  different merchants, and a chain's small-format store is different from its
  full-size sibling. When unsure, leave them apart — a split history is
  recoverable, a merged one is not.

  A lexicon row already under the target wins; the source's duplicate is dropped
  rather than left stranded under a dead key.

examples:
  kitchen-axi stores list
  kitchen-axi stores merge "SPROUTS FARMERS MARKET" --into "Sprouts Farmers Market"`;

export async function storesCommand(args: string[]): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
    case undefined:
      return listStores(sub === undefined ? args : rest);
    case "merge":
      return mergeStores(rest);
    default:
      throw new AxiError(`Unknown stores subcommand: ${sub}`, "VALIDATION_ERROR", [STORES_HELP]);
  }
}

async function listStores(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"], []);
  const result = await api.get("/api/kitchen/stores");
  if (flags.json) return JSON.stringify(result, null, 2);
  const stores: string[] = result?.stores ?? [];
  return renderOutput([
    renderObject({ stores: stores.length }),
    stores.map((s) => `  ${s}`).join("\n"),
    renderHelp([
      "Spellings of ONE store fragment its lexicon — mappings under one can never match receipts printing another",
      'Run `kitchen-axi stores merge "<from>" --into "<to>"` to fold one in',
      "Merging is not reversible: when unsure whether two names are one merchant, leave them apart",
    ]),
  ]);
}

async function mergeStores(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], ["into"]);
  const from = requirePositional(positionals, 0, "source store", STORES_HELP);
  const to = typeof flags.into === "string" ? flags.into : undefined;
  if (!to) throw new AxiError("stores merge needs --into <store>", "VALIDATION_ERROR", [STORES_HELP]);

  const result = await api.post("/api/kitchen/stores/merge", { from, to });
  if (flags.json) return JSON.stringify(result, null, 2);
  return renderOutput([
    renderObject({
      merged: result.from,
      into: result.to,
      lexicon_rows_moved: result.lexicon,
      items_moved: result.items,
    }),
    renderHelp([
      "The old string now resolves onto the survivor, so a receipt printing it lands on one key",
      "Rows the target already had were dropped rather than left under a dead key",
    ]),
  ]);
}
