import type { FlagSpec } from "../../../core/src/axi/flags.js";
import { MACRO_PANEL_FLAG_NAMES } from "./reference.js";

/** The write flags shared by `products add` and `products update` (single-sourced so they can't drift). */
const PRODUCT_WRITE_VALUE_FLAGS = [
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
const PRODUCT_WRITE_SWITCHES = ["negligible", "no-negligible", "force-negligible"];

/**
 * Every command's declared arguments, in one table
 * (specs/behaviors/axi-cli-arguments-and-export.md § Declared arguments). The
 * parser rejects anything not listed here, and the tests walk this table: each
 * command is run with a bogus flag, and each declared flag must appear in that
 * group's `--help`.
 *
 * Keys are the command as typed. Positionals are counted after the subcommand.
 * Every command offers `--json-out`: each one returns an API body.
 */
export const FLAG_SPECS = {
  home: { value: ["eat-first"], jsonOut: true },
  days: { value: ["since"], jsonOut: true },

  "entries list": { value: ["since", "limit"], jsonOut: true },
  "entries questions": { value: ["limit"], jsonOut: true },
  "entries review": { positionals: 1, usage: "kitchen-axi entries review <ulid>", jsonOut: true },
  "entries show": { positionals: 1, usage: "kitchen-axi entries show <ulid>", jsonOut: true },
  "entries log": {
    value: ["recipe", "at", "label", ...MACRO_PANEL_FLAG_NAMES],
    multi: ["component"],
    positionals: "many",
    jsonOut: true,
  },
  "entries patch": {
    value: ["note", "label", "portion-basis", ...MACRO_PANEL_FLAG_NAMES, "multiplier", "at"],
    positionals: 1,
    usage: "kitchen-axi entries patch <ulid> [flags]",
    jsonOut: true,
  },
  "entries delete": { positionals: 1, usage: "kitchen-axi entries delete <ulid>", jsonOut: true },

  "expenditure log": {
    value: ["kcal", "duration", "avg-hr", "at", "source", "ulid"],
    positionals: "many",
    jsonOut: true,
  },
  "expenditure list": { value: ["since", "limit"], boolean: ["include-skipped"], jsonOut: true },
  "expenditure delete": { positionals: 1, usage: "kitchen-axi expenditure delete <ulid>", jsonOut: true },

  "inventory list": { value: ["state", "limit"], boolean: ["closed"], jsonOut: true },
  "inventory show": { positionals: 1, usage: "kitchen-axi inventory show <ulid>", jsonOut: true },
  "inventory add": {
    value: [
      "ulid",
      "product-ulid",
      "raw-label",
      "store",
      "batch-ulid",
      "acquired-at",
      "fraction",
      "units-total",
      "unit-seal",
      "state",
      "shelf-life",
      "notes",
    ],
    boolean: ["needs-info"],
    jsonOut: true,
  },
  "inventory event": {
    value: ["fraction", "to", "at"],
    positionals: 2,
    usage: "kitchen-axi inventory event <ulid> <type> [--fraction F] [--to C] [--at DATE]",
    jsonOut: true,
  },
  "inventory recount": {
    value: ["fraction", "units-remaining", "units-total", "unit-seal", "state", "opened-at", "shelf-life", "product-ulid", "notes"],
    boolean: ["uncounted", "needs-info", "no-needs-info", "unlink-product"],
    positionals: 1,
    usage: "kitchen-axi inventory recount <ulid> [flags]",
    jsonOut: true,
  },
  "inventory dismiss": {
    value: ["at"],
    boolean: ["non-inventory"],
    positionals: 1,
    usage: "kitchen-axi inventory dismiss <ulid> [--non-inventory] [--at DATE]",
    jsonOut: true,
  },
  "inventory merge": {
    value: ["into"],
    positionals: 1,
    usage: "kitchen-axi inventory merge <ulid> --into <ulid>",
    jsonOut: true,
  },
  "inventory remark": { value: ["at"], positionals: "many", jsonOut: true },
  "inventory candidates": {
    value: ["limit"],
    positionals: 1,
    usage: "kitchen-axi inventory candidates <ulid> [--limit N]",
    jsonOut: true,
  },
  "inventory questions": { value: ["limit"], jsonOut: true },
  "inventory waste": { value: ["since", "until", "limit"], jsonOut: true },
  "inventory convert": { value: ["to", "at"], multi: ["from"], jsonOut: true },
  "inventory consume": {
    value: ["quantity", "at", "ulid"],
    positionals: 1,
    usage: "kitchen-axi inventory consume <ulid> [--quantity N] [--at DATE]",
    jsonOut: true,
  },
  "inventory eat": {
    value: ["grams", "fraction", "entry-ulid", "at"],
    positionals: 1,
    usage: "kitchen-axi inventory eat <ulid> --grams N | --fraction F",
    jsonOut: true,
  },

  "lexicon list": { value: ["store", "limit"], jsonOut: true },
  "lexicon add": { value: ["store", "line-text", "product-ulid", "package-size", "shelf-life"], jsonOut: true },

  "prep publish": {
    value: [
      "slug",
      "label",
      "title",
      "heading",
      "intro",
      "recipe",
      "yields-recipe",
      "cook",
      "units",
      "shelf-life",
      "submit-label",
      "components-per",
    ],
    multi: ["component", "component-item", "component-unit", "step", "source"],
    boolean: ["digest-optin"],
    jsonOut: true,
  },

  "products list": { value: ["q", "limit"], jsonOut: true },
  "products add": { value: PRODUCT_WRITE_VALUE_FLAGS, boolean: PRODUCT_WRITE_SWITCHES, jsonOut: true },
  "products update": {
    value: PRODUCT_WRITE_VALUE_FLAGS,
    boolean: PRODUCT_WRITE_SWITCHES,
    positionals: 1,
    usage: "kitchen-axi products update <ulid> [flags]",
    jsonOut: true,
  },
  "products prices": {
    value: ["store", "limit"],
    positionals: 1,
    usage: "kitchen-axi products prices <ulid> [--store S] [--limit N]",
    jsonOut: true,
  },
  "products merge": {
    value: ["into"],
    positionals: 1,
    usage: "kitchen-axi products merge <ulid> --into <ulid>",
    jsonOut: true,
  },
  "products archive": { positionals: 1, usage: "kitchen-axi products archive <ulid>", jsonOut: true },
  "products panel-basis-report": { jsonOut: true },

  "receipts list": { value: ["limit"], jsonOut: true },
  "receipts show": { positionals: 1, usage: "kitchen-axi receipts show <ulid>", jsonOut: true },
  "receipts scan": { value: ["store", "purchased-at", "ulid"], positionals: "many", jsonOut: true },

  "recipes list": { value: ["q", "limit"], jsonOut: true },
  "recipes push": {
    value: ["ulid"],
    positionals: 1,
    usage: "kitchen-axi recipes push '<recipe json>' [--ulid U]",
    jsonOut: true,
  },
  "recipes delete": { positionals: 1, usage: "kitchen-axi recipes delete <ulid>", jsonOut: true },
  "recipes promote": {
    value: ["name"],
    positionals: 1,
    usage: "kitchen-axi recipes promote <entry-ulid> [--name NAME]",
    jsonOut: true,
  },

  "stores list": { jsonOut: true },
  "stores merge": {
    value: ["into"],
    positionals: 1,
    usage: 'kitchen-axi stores merge "<from>" --into "<to>"',
    jsonOut: true,
  },

  "weigh-ins log": { value: ["weight", "body-fat", "at"], jsonOut: true },
  "weigh-ins list": { value: ["since", "limit"], jsonOut: true },
  "weight trend": { value: ["days"], jsonOut: true },
} satisfies Record<string, FlagSpec>;

export type CommandName = keyof typeof FLAG_SPECS;
