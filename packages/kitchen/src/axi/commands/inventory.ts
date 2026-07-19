import { api } from "../client.js";
import { AxiError } from "axi-sdk-js";
import {
  parseArgs,
  requirePositional,
  rawJson,
  validateDate,
  parseNumberFlag,
} from "../args.js";
import { renderList, renderDetail, renderObject, renderOutput, renderHelp, field, type FieldDef } from "../toon.js";
import { cliInvocation } from "../invocation.js";
import { SHELF_LIFE_CLASSES } from "../reference.js";

export const INVENTORY_HELP = `kitchen-axi inventory <subcommand> [args] [--json]

  list [--state S] [--closed] [--limit N]   on-hand items, eat-first (eat_by asc)
  show <ulid>                               one item with derived eat_by/age
  add [flags]                               create an item (manual/verbal/seed)
  event <ulid> <opened|finished|tossed>     explicit state change
       [--fraction F] [--at DATE]
  remark "<free text>" [--at DATE]          free-text event resolver (honest match)
  questions [--limit N]                     open needs-info items as questions

  states: stocked, open, finished, tossed. For 'event … tossed', --fraction is
  the AMOUNT TOSSED — a partial toss decrements on_hand_fraction and keeps the
  item alive (self-heals at the next event); it goes terminal only at zero
  remainder or when --fraction is omitted (full toss). 'opened' --fraction is
  the absolute remaining fraction; 'finished' ignores --fraction (always zeroed).`;

const ITEM_ROW_SCHEMA: FieldDef[] = [
  field("ulid"),
  field("product_name", "name"),
  field("state"),
  field("on_hand_fraction", "on_hand"),
  field("eat_by"),
  field("days_until_eat_by", "days_left"),
  field("store"),
  { type: "boolYesNo", key: "needs_info" },
];

const ITEM_DETAIL_SCHEMA: FieldDef[] = [
  field("ulid"),
  field("product_ulid"),
  field("product_name", "name"),
  field("raw_label"),
  field("store"),
  field("state"),
  field("on_hand_fraction", "on_hand"),
  { type: "boolYesNo", key: "needs_info" },
  field("acquired_at"),
  field("opened_at"),
  field("closed_at"),
  field("eat_by"),
  field("days_until_eat_by", "days_left"),
  field("age_days"),
  field("shelf_life_class", "shelf_life"),
  field("notes"),
];

const QUESTION_SCHEMA: FieldDef[] = [
  field("item_ulid", "ulid"),
  field("raw_label"),
  field("store"),
  field("acquired_at"),
  field("question"),
];

const EVENT_TYPES = ["opened", "finished", "tossed"];

export async function inventoryCommand(args: string[]): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
    case undefined:
      return listItems(sub === undefined ? args : rest);
    case "show":
      return showItem(rest);
    case "add":
      return addItem(rest);
    case "event":
      return itemEvent(rest);
    case "remark":
      return remark(rest);
    case "questions":
      return questions(rest);
    default:
      throw new AxiError(`Unknown inventory subcommand: ${sub}`, "VALIDATION_ERROR", [INVENTORY_HELP]);
  }
}

async function listItems(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json", "closed"]);
  const state = typeof flags.state === "string" ? flags.state : undefined;
  const limit = typeof flags.limit === "string" ? String(parseNumberFlag(flags.limit, "limit", INVENTORY_HELP, { min: 1 })) : undefined;
  const result = await api.get("/api/kitchen/inventory", {
    state,
    limit,
    include_closed: flags.closed ? "true" : undefined,
  });
  if (flags.json) return rawJson(result);
  const items = result?.items ?? [];
  return renderList("items", items, ITEM_ROW_SCHEMA);
}

async function showItem(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"]);
  const ulid = requirePositional(positionals, 0, "item ulid", INVENTORY_HELP);
  const item = await api.get(`/api/kitchen/inventory/${encodeURIComponent(ulid)}`);
  if (flags.json) return rawJson(item);
  return renderDetail("item", item, ITEM_DETAIL_SCHEMA);
}

async function addItem(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json", "needs-info"]);
  const body: Record<string, unknown> = {};
  if (typeof flags.ulid === "string") body.ulid = flags.ulid;
  if (typeof flags["product-ulid"] === "string") body.product_ulid = flags["product-ulid"];
  if (typeof flags["raw-label"] === "string") body.raw_label = flags["raw-label"];
  if (typeof flags.store === "string") body.store = flags.store;
  if (typeof flags["batch-ulid"] === "string") body.batch_ulid = flags["batch-ulid"];
  if (typeof flags["acquired-at"] === "string") body.acquired_at = validateDate(flags["acquired-at"], "--acquired-at", INVENTORY_HELP);
  if (typeof flags.fraction === "string") body.on_hand_fraction = parseNumberFlag(flags.fraction, "fraction", INVENTORY_HELP, { min: 0, max: 1 });
  if (typeof flags.state === "string") body.state = flags.state;
  if (flags["needs-info"]) body.needs_info = true;
  if (typeof flags["shelf-life"] === "string") body.shelf_life_class = validateShelfLife(flags["shelf-life"]);
  if (typeof flags.notes === "string") body.notes = flags.notes;

  if (Object.keys(body).length === 0) {
    throw new AxiError("inventory add needs at least one field (e.g. --raw-label)", "VALIDATION_ERROR", [INVENTORY_HELP]);
  }

  const item = await api.post("/api/kitchen/inventory", body);
  if (flags.json) return rawJson(item);
  return renderDetail("item", item, ITEM_DETAIL_SCHEMA);
}

async function itemEvent(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"]);
  const ulid = requirePositional(positionals, 0, "item ulid", INVENTORY_HELP);
  const type = requirePositional(positionals, 1, "event type", INVENTORY_HELP);
  if (!EVENT_TYPES.includes(type)) {
    throw new AxiError(`event type must be one of: ${EVENT_TYPES.join(", ")}`, "VALIDATION_ERROR", [INVENTORY_HELP]);
  }
  const body: Record<string, unknown> = { type };
  if (typeof flags.fraction === "string") body.fraction = parseNumberFlag(flags.fraction, "fraction", INVENTORY_HELP, { min: 0, max: 1 });
  if (typeof flags.at === "string") body.at = validateDate(flags.at, "--at", INVENTORY_HELP);

  const item = await api.post(`/api/kitchen/inventory/${encodeURIComponent(ulid)}/events`, body);
  if (flags.json) return rawJson(item);
  return renderDetail("item", item, ITEM_DETAIL_SCHEMA);
}

async function remark(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"]);
  const text = positionals.join(" ").trim();
  if (!text) throw new AxiError("inventory remark needs free text", "VALIDATION_ERROR", [INVENTORY_HELP]);
  const body: Record<string, unknown> = { remark: text };
  if (typeof flags.at === "string") body.at = validateDate(flags.at, "--at", INVENTORY_HELP);

  const result = await api.post("/api/kitchen/inventory/events", body);
  if (flags.json) return rawJson(result);

  const cli = cliInvocation();
  if (!result?.matched) {
    return renderOutput([
      renderObject({ matched: false }),
      renderHelp([`No open/stocked item matched "${text}" — this is normal; use \`${cli} inventory list\` then \`${cli} inventory event <ulid> …\` to act explicitly`]),
    ]);
  }
  return renderOutput([
    renderObject({
      matched: true,
      event_type: result.event?.type ?? null,
      event_fraction: result.event?.fraction ?? null,
    }),
    renderDetail("item", result.item, ITEM_DETAIL_SCHEMA),
  ]);
}

async function questions(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"]);
  const limit = typeof flags.limit === "string" ? String(parseNumberFlag(flags.limit, "limit", INVENTORY_HELP, { min: 1 })) : undefined;
  const result = await api.get("/api/kitchen/inventory/questions", { limit });
  if (flags.json) return rawJson(result);
  const q = result?.questions ?? [];
  return renderList("questions", q, QUESTION_SCHEMA);
}

function validateShelfLife(value: string): string {
  if (!(SHELF_LIFE_CLASSES as readonly string[]).includes(value)) {
    throw new AxiError(`--shelf-life must be one of: ${SHELF_LIFE_CLASSES.join(", ")}`, "VALIDATION_ERROR", [INVENTORY_HELP]);
  }
  return value;
}
