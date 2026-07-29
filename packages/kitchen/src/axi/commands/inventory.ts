import { api } from "../client.js";
import { generateUlid } from "../../ulid.js";
import { AxiError } from "axi-sdk-js";
import {
  parseArgs,
  collectFlag,
  requirePositional,
  rawJson,
  parseJson,
  validateDate,
  parseNumberFlag,
} from "../args.js";
import { renderList, renderDetail, renderObject, renderOutput, renderHelp, field, type FieldDef } from "../toon.js";
import { ENTRY_ROW_SCHEMA } from "../format.js";
import { cliInvocation } from "../invocation.js";
import { CONVERT_SHELF_LIFE_CLASSES, PACKAGE_DURABLE_SHELF_LIFE_CLASSES, SHELF_LIFE_CLASSES } from "../reference.js";

export const INVENTORY_HELP = `kitchen-axi inventory <subcommand> [args] [--json]

  list [--state S] [--closed] [--limit N]   on-hand items, eat-first (eat_by asc)
  show <ulid>                               one item with derived eat_by/age
  add [flags]                               create an item (manual/verbal/seed)
       [--units-total N] makes it a COUNTED item (sealed multipack); omitted stays fraction-modeled
  event <ulid> <opened|finished|finished-unit|tossed>   explicit state change
       [--fraction F] [--at DATE]
  recount <ulid> [--fraction F] [--units-remaining N] [--units-total N]
       [--uncounted] [--state stocked|open] [--opened-at DATE] [--notes T]
                                             RECONCILE the ledger to observed reality —
                                             a correction, NOT a consumption event
  dismiss <ulid> [--non-inventory]          RETIRE a record that was never real
                                             stock (phantom item, non-grocery
                                             receipt line) — no consumption, no waste
  merge <ulid> --into <ulid>                fold a DUPLICATE item into a survivor:
                                             relink its dependents, then retire it
  remark "<free text>" [--at DATE]          free-text event resolver (honest match)
  questions [--limit N]                     open needs-info items as questions
  convert [--from <ulid>[:amount]…] --to '<json>' [--at DATE]
                                             prep transform: create a derived item, optionally decrementing source(s)
  consume <item-ulid> [--quantity N] [--at DATE] [--ulid ENTRY_ULID]
                                             one-tap: log + deplete a known-macro item, ONE atomic step

  EVERY STATE AN ITEM CAN REACH, and the verb that reaches it:

    stocked    'add' (or 'convert' for a made item) creates one; also where a
               counted item lands after 'event … finished-unit' leaves units,
               and where 'recount --state stocked' puts a mis-opened item
    open       'event <ulid> opened'
    finished   'event <ulid> finished' (whole item) or 'event … finished-unit'
               on the LAST unit of a counted item. Terminal. Means CONSUMED —
               never use it to get a record out of the way
    tossed     'event <ulid> tossed' (full toss, or a partial that reaches
               zero). Terminal. Means WASTED — it feeds waste telemetry, so
               never use it for food that never existed
    dismissed  'inventory dismiss <ulid>' — its OWN verb, not an event type
               (different body, different response). Terminal, and the only
               terminal that claims neither consumption nor waste: the honest
               retirement for a record that was never real stock. Also where an
               item merge puts the loser
  resurrection 'recount --state stocked|open' reopens a mis-closed item (the
               only way back out of a terminal state)

  For 'event … tossed', --fraction is
  the AMOUNT TOSSED — a partial toss decrements on_hand_fraction and keeps the
  item alive (self-heals at the next event); it goes terminal only at zero
  remainder or when --fraction is omitted (full toss). 'opened' --fraction is
  the absolute remaining fraction; 'finished' ignores --fraction (always zeroed).
  'finished-unit' is for a COUNTED item only (units_total set): integer
  decrement of one sealed unit — reaching zero goes terminal, otherwise the
  item reverts to a fresh unopened clock for the next unit.

  'convert' creates a NEW derived item from meal prep (not consumption).
  --from is OPTIONAL and repeatable: with sources it decrements each (an
  omitted amount fully consumes that source — all remaining units for a
  counted item, the whole remaining fraction for a divisible one; an integer
  amount for a counted source, a fraction 0..1 for a divisible one); with NO
  --from it is a source-less "I made this" — it registers the prepared item
  without decrementing any tracked stock (use when the raw inputs were loose,
  already logged, or not worth tracking). PREFER --from whenever the inputs
  ARE tracked — a sourceless convert leaves provenance empty, blocking cost
  attribution and cross-transform eat-first reasoning. Pass
  --to '{…,"recipe_ulid":"…"}'
  to make the derived item one-tap consume-eligible (see 'consume'). --to is
  a JSON object: {"name": "...",
  "shelf_life_class": "...", "units_total": N} for a counted derived item, or
  {"name": "...", "shelf_life_class": "...", "on_hand_fraction": 1} for a
  divisible one (fields: shelf_life_class?, on_hand_fraction?, units_total?,
  store?, notes?, acquired_at?, recipe_ulid?). PER-UNIT RECIPE CONTRACT: for
  a counted derived item the linked recipe must describe ONE unit (one jar),
  not the whole batch — consume logs recipe × quantity. A converted (made)
  item accepts ONLY the made-food classes — prepared (default), produce,
  very_perishable, frozen. The package-durable grocery classes (pantry,
  fridge_long, fridge_short) are REJECTED with a 400: their clock assumes a
  sealed store package, absurd on a homemade item. For prepped food, OMIT
  shelf_life_class and let the 'prepared' default apply (or 'produce' for
  hard-boiled eggs); use the product-level day overrides for a genuinely
  longer honest clock, never a grocery class.

  'recount' is THE way to fix a ledger that disagrees with the fridge ("it's
  actually 75% full", "this is really 2 of 3 cans", "this carton was never
  opened"). It never touches clocks: opened_at moves only via an explicit
  --opened-at, and --state stocked clears it (stocked means sealed) with
  eat_by re-derived from the true state + product overrides. --units-total N
  (with optional --units-remaining) reclassifies a fraction item as a COUNTED
  multipack; --uncounted reverts a counted item to the fraction model.
  --state can also resurrect a mis-finished/mis-tossed item — including one
  closed by mistake before 'dismiss' was reached for. Do NOT fix the
  ledger by re-firing 'event … opened --fraction' — that stamps a bogus
  opened clock. Never pre-log planned consumption (e.g. a batch-day run that
  hasn't happened); log events when they actually happen and recount when
  reality disagrees.

  'consume' is the one-tap "eat a prepared item" action: it creates a
  consumption entry with the item's EXACT known macros (no model call,
  source reselect) AND depletes the item, in ONE atomic step — a failure of
  either side leaves neither applied. Only items with known macros qualify
  (a derived item whose conversion carried a --to recipe_ulid that resolves
  to a recipe with components); anything else 400s — use the normal
  photo/reselect path there. --quantity is whole sealed units for a COUNTED
  item (default 1); a fraction-modeled item always fully finishes in one
  tap, so --quantity must be omitted or 1 there. --ulid supplies the
  consumption entry's ULID explicitly (idempotency key for a retry); omitted,
  the CLI generates one. Replaying the same --ulid is a safe no-op: no
  duplicate entry, no double-deplete.

  'dismiss' is how a record LEAVES inventory without a claim about food.
  Reach for it whenever the record should never have been stock: a phantom
  seeded twice, a housewares line on a grocery receipt, a mis-scanned line.
  It stamps closed_at, leaves on_hand_fraction alone, and appends no waste
  note, so it enters neither consumption nor waste rollups. --non-inventory
  makes the decision durable for a recurring RECEIPT LINE: it also dismisses
  every same-line sibling still open and writes a skip marker so future
  receipts from that store skip the line. Omit it for a one-off record. 409
  if the item is already terminal — resurrect it with 'recount --state
  stocked' first, then dismiss.

  'merge' is for TWO RECORDS, ONE PHYSICAL PACKAGE. Prefer it over dismiss
  whenever either side has history: dismiss retires a row but relinks
  nothing, so a consumption entry that depleted the loser, the receipt line
  that created it, and any conversion that spent it are left pointing at a
  record that is no longer stock. Merge fills ONLY the survivor's EMPTY
  identity fields from the loser (product_ulid, store, raw_label,
  batch_ulid, shelf_life_class — the survivor's own values always win), which
  is the ONLY way to attach a product to an existing item; relinks every
  dependent and reports the counts; then retires the loser as dismissed with
  merged_into set. Quantities are NEVER summed and the survivor keeps its own
  clock — merging is not "add these together", it is "these were always one
  thing". Pick the survivor by whose clock is honest (usually the earlier
  acquired_at), not by which one has the product. A replay into the same
  survivor is a safe no-op; re-pointing an already-merged item elsewhere is a
  409 naming where it went.`;

const ITEM_ROW_SCHEMA: FieldDef[] = [
  field("ulid"),
  field("product_name", "name"),
  field("state"),
  field("on_hand_fraction", "on_hand"),
  field("units_remaining"),
  field("units_total"),
  field("eat_by"),
  field("days_until_eat_by", "days_left"),
  field("store"),
  { type: "boolYesNo", key: "needs_info" },
  { type: "boolYesNo", key: "needs_nutrition" },
];

const ITEM_DETAIL_SCHEMA: FieldDef[] = [
  field("ulid"),
  field("product_ulid"),
  field("product_name", "name"),
  field("raw_label"),
  field("store"),
  field("state"),
  field("on_hand_fraction", "on_hand"),
  field("units_remaining"),
  field("units_total"),
  { type: "boolYesNo", key: "needs_info" },
  { type: "boolYesNo", key: "needs_nutrition" },
  field("acquired_at"),
  field("opened_at"),
  field("closed_at"),
  field("eat_by"),
  field("days_until_eat_by", "days_left"),
  field("age_days"),
  field("shelf_life_class", "shelf_life"),
  field("notes"),
  field("merged_into"),
];

const QUESTION_SCHEMA: FieldDef[] = [
  field("item_ulid", "ulid"),
  field("raw_label"),
  field("store"),
  field("acquired_at"),
  field("question"),
];

const EVENT_TYPES = ["opened", "finished", "finished-unit", "tossed"];

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
    case "recount":
      return recountItem(rest);
    case "dismiss":
      return dismissItem(rest);
    case "merge":
      return mergeItem(rest);
    case "remark":
      return remark(rest);
    case "questions":
      return questions(rest);
    case "convert":
      return convert(rest);
    case "consume":
      return consumeItem(rest);
    default:
      throw new AxiError(`Unknown inventory subcommand: ${sub}`, "VALIDATION_ERROR", [INVENTORY_HELP]);
  }
}

async function listItems(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json", "closed"], ["state", "limit"]);
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
  const { positionals, flags } = parseArgs(args, ["json"], []);
  const ulid = requirePositional(positionals, 0, "item ulid", INVENTORY_HELP);
  const item = await api.get(`/api/kitchen/inventory/${encodeURIComponent(ulid)}`);
  if (flags.json) return rawJson(item);
  return renderDetail("item", item, ITEM_DETAIL_SCHEMA);
}

async function addItem(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json", "needs-info"], ["ulid", "product-ulid", "raw-label", "store", "batch-ulid", "acquired-at", "fraction", "units-total", "state", "shelf-life", "notes"]);
  const body: Record<string, unknown> = {};
  if (typeof flags.ulid === "string") body.ulid = flags.ulid;
  if (typeof flags["product-ulid"] === "string") body.product_ulid = flags["product-ulid"];
  if (typeof flags["raw-label"] === "string") body.raw_label = flags["raw-label"];
  if (typeof flags.store === "string") body.store = flags.store;
  if (typeof flags["batch-ulid"] === "string") body.batch_ulid = flags["batch-ulid"];
  if (typeof flags["acquired-at"] === "string") body.acquired_at = validateDate(flags["acquired-at"], "--acquired-at", INVENTORY_HELP);
  if (typeof flags.fraction === "string") body.on_hand_fraction = parseNumberFlag(flags.fraction, "fraction", INVENTORY_HELP, { min: 0, max: 1 });
  if (typeof flags["units-total"] === "string") body.units_total = parseNumberFlag(flags["units-total"], "units-total", INVENTORY_HELP, { min: 1 });
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

/**
 * Guard an `event` type client-side, and — the load-bearing half — REDIRECT the
 * fifth state rather than refusing it flatly. `dismissed` is a real state
 * reached by a real verb, just not through this endpoint; an agent that reads a
 * bare enum error concludes it is not a state at all and settles for
 * `finished`, which claims a consumption that never happened AND makes the item
 * terminal so the correct verb then 409s. A verb that exists but cannot be found
 * is, for an agent, a verb that does not exist.
 */
export function assertEventType(type: string, ulid = "<ulid>"): void {
  if (type === "dismissed" || type === "dismiss") {
    throw new AxiError(
      "dismissed is a state, but not an event type — it has its own verb",
      "VALIDATION_ERROR",
      [
        `Run \`${cliInvocation()} inventory dismiss ${ulid}\` (add --non-inventory for a recurring non-grocery receipt line)`,
        "Never use `event finished`/`event tossed` to retire a record that was never real stock — those claim a consumption or waste that did not happen",
      ]
    );
  }
  if (!EVENT_TYPES.includes(type)) {
    throw new AxiError(
      `event type must be one of: ${EVENT_TYPES.join(", ")} (to RETIRE a record that was never real stock, use \`inventory dismiss\`)`,
      "VALIDATION_ERROR",
      [INVENTORY_HELP]
    );
  }
}

/**
 * Build the `dismiss` request body. `--non-inventory` is sent ONLY when asked:
 * it is what makes the dismissal durable for a recurring receipt LINE (fan-out
 * plus a skip marker), which is the wrong thing to do to a one-off phantom.
 */
export function buildDismissBody(flags: Record<string, string | boolean | undefined>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (flags["non-inventory"]) body.non_inventory = true;
  if (typeof flags.at === "string") body.at = validateDate(flags.at, "--at", INVENTORY_HELP);
  return body;
}

async function itemEvent(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], ["fraction", "at"]);
  const ulid = requirePositional(positionals, 0, "item ulid", INVENTORY_HELP);
  const type = requirePositional(positionals, 1, "event type", INVENTORY_HELP);
  assertEventType(type, ulid);
  const body: Record<string, unknown> = { type };
  if (typeof flags.fraction === "string") body.fraction = parseNumberFlag(flags.fraction, "fraction", INVENTORY_HELP, { min: 0, max: 1 });
  if (typeof flags.at === "string") body.at = validateDate(flags.at, "--at", INVENTORY_HELP);

  const item = await api.post(`/api/kitchen/inventory/${encodeURIComponent(ulid)}/events`, body);
  if (flags.json) return rawJson(item);
  return renderDetail("item", item, ITEM_DETAIL_SCHEMA);
}

async function recountItem(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json", "uncounted"], ["fraction", "units-remaining", "units-total", "state", "opened-at", "notes"]);
  const ulid = requirePositional(positionals, 0, "item ulid", INVENTORY_HELP);
  const body: Record<string, unknown> = {};
  if (typeof flags.fraction === "string") body.on_hand_fraction = parseNumberFlag(flags.fraction, "fraction", INVENTORY_HELP, { min: 0, max: 1 });
  if (typeof flags["units-remaining"] === "string") body.units_remaining = parseNumberFlag(flags["units-remaining"], "units-remaining", INVENTORY_HELP, { min: 1 });
  if (typeof flags["units-total"] === "string") body.units_total = parseNumberFlag(flags["units-total"], "units-total", INVENTORY_HELP, { min: 1 });
  if (flags.uncounted) {
    body.units_total = null;
    body.units_remaining = null;
  }
  if (typeof flags.state === "string") {
    if (flags.state !== "stocked" && flags.state !== "open") {
      throw new AxiError("recount --state must be stocked or open (a correction never closes an item — use events for that)", "VALIDATION_ERROR", [INVENTORY_HELP]);
    }
    body.state = flags.state;
  }
  if (typeof flags["opened-at"] === "string") body.opened_at = validateDate(flags["opened-at"], "--opened-at", INVENTORY_HELP);
  if (typeof flags.notes === "string") body.notes = flags.notes;
  if (Object.keys(body).length === 0) {
    throw new AxiError("recount needs at least one correction (e.g. --fraction 0.75)", "VALIDATION_ERROR", [INVENTORY_HELP]);
  }

  const item = await api.patch(`/api/kitchen/inventory/${encodeURIComponent(ulid)}`, body);
  if (flags.json) return rawJson(item);
  return renderDetail("item", item, ITEM_DETAIL_SCHEMA);
}

/**
 * `inventory dismiss` — its own subcommand rather than a member of the `event`
 * enum, matching the endpoint it wraps (`POST /inventory/:ulid/dismiss`): it
 * carries a flag the event body has no room for and answers with a compound
 * `{ item, dismissed_count, non_inventory }` rather than the bare item `event`
 * renders. Folding it in would make one verb's output shape depend on its
 * argument.
 */
async function dismissItem(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json", "non-inventory"], ["at"]);
  const ulid = requirePositional(positionals, 0, "item ulid", INVENTORY_HELP);
  const body = buildDismissBody(flags);

  const result = await api.post(`/api/kitchen/inventory/${encodeURIComponent(ulid)}/dismiss`, body);
  if (flags.json) return rawJson(result);

  const cli = cliInvocation();
  return renderOutput([
    renderObject({
      dismissed_count: result?.dismissed_count ?? null,
      non_inventory: result?.non_inventory ?? false,
    }),
    renderDetail("item", result?.item, ITEM_DETAIL_SCHEMA),
    renderHelp([
      "Retired without claiming consumption or waste — neither rollup counts it",
      result?.non_inventory
        ? "Same-line siblings were dismissed too, and future receipts from that store will skip the line"
        : `If another record covers the same physical package, prefer \`${cli} inventory merge <dupe> --into <survivor>\` so its entries and receipt line move instead of being stranded`,
    ]),
  ]);
}

async function mergeItem(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], ["into"]);
  const ulid = requirePositional(positionals, 0, "item ulid (the duplicate to retire)", INVENTORY_HELP);
  const into = typeof flags.into === "string" ? flags.into : undefined;
  if (!into) {
    throw new AxiError("inventory merge needs --into <survivor ulid>", "VALIDATION_ERROR", [INVENTORY_HELP]);
  }

  const result = await api.post(`/api/kitchen/inventory/${encodeURIComponent(ulid)}/merge`, { into });
  if (flags.json) return rawJson(result);

  const relinked = result?.relinked ?? {};
  return renderOutput([
    renderObject({
      retired: result?.merged?.ulid,
      entries_relinked: relinked.entries ?? 0,
      batch_lines_relinked: relinked.batch_lines ?? 0,
      derivations_relinked: relinked.derivations ?? 0,
      derivation_sources_relinked: relinked.derivation_sources ?? 0,
    }),
    renderDetail("survivor", result?.item, ITEM_DETAIL_SCHEMA),
    renderHelp([
      "The duplicate is dismissed, not deleted — off every on-hand listing, still resolvable by ulid, with merged_into pointing here",
      "Quantities were NOT summed (one physical package): if the survivor's on-hand count is also wrong, that is a separate `inventory recount`",
    ]),
  ]);
}

async function remark(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], ["at"]);
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
  const { flags } = parseArgs(args, ["json"], ["limit"]);
  const limit = typeof flags.limit === "string" ? String(parseNumberFlag(flags.limit, "limit", INVENTORY_HELP, { min: 1 })) : undefined;
  const result = await api.get("/api/kitchen/inventory/questions", { limit });
  if (flags.json) return rawJson(result);
  const q = result?.questions ?? [];
  return renderList("questions", q, QUESTION_SCHEMA);
}

/** Parse one `--from <ulid>[:amount]` value into a convert source. */
function parseSource(raw: string): { item_ulid: string; amount?: number } {
  const sep = raw.indexOf(":");
  if (sep === -1) return { item_ulid: raw };
  const item_ulid = raw.slice(0, sep);
  const amountText = raw.slice(sep + 1);
  const amount = Number(amountText);
  if (!item_ulid || !Number.isFinite(amount)) {
    throw new AxiError(`--from must be "<ulid>" or "<ulid>:<amount>" (got ${raw})`, "VALIDATION_ERROR", [INVENTORY_HELP]);
  }
  return { item_ulid, amount };
}

async function convert(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"], ["from", "to", "at"]);
  // --from is optional: with none, this is a source-less conversion that
  // registers a prepared item ("I made this") without decrementing stock.
  const fromValues = collectFlag(args, "from");
  const toRaw = typeof flags.to === "string" ? flags.to : undefined;
  if (!toRaw) throw new AxiError("convert needs --to '<derived spec json>'", "VALIDATION_ERROR", [INVENTORY_HELP]);
  const derived = parseJson(toRaw, "--to", INVENTORY_HELP);
  if (!derived || typeof derived !== "object" || Array.isArray(derived) || !("name" in derived)) {
    throw new AxiError("--to must be a JSON object with at least a \"name\" field", "VALIDATION_ERROR", [INVENTORY_HELP]);
  }

  // A converted (made) item accepts only made-food classes — block the
  // package-durable ones before the network call (§ Shelf-life classes). The
  // server enforces the same guard; this just fails fast with clean guidance.
  assertConvertShelfLifeClass((derived as { shelf_life_class?: unknown }).shelf_life_class);

  const body: Record<string, unknown> = {
    sources: fromValues.map(parseSource),
    derived,
  };
  if (typeof flags.at === "string") body.at = validateDate(flags.at, "--at", INVENTORY_HELP);

  const result = await api.post("/api/kitchen/inventory/convert", body);
  if (flags.json) return rawJson(result);
  return renderOutput([
    renderList("sources", result.sources ?? [], ITEM_ROW_SCHEMA),
    renderDetail("derived", result.derived, ITEM_DETAIL_SCHEMA),
  ]);
}

async function consumeItem(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], ["quantity", "at", "ulid"]);
  const itemUlid = requirePositional(positionals, 0, "item ulid", INVENTORY_HELP);

  const body: Record<string, unknown> = { ulid: typeof flags.ulid === "string" ? flags.ulid : generateUlid() };
  if (typeof flags.quantity === "string") {
    body.quantity = parseNumberFlag(flags.quantity, "quantity", INVENTORY_HELP, { min: 1 });
  }
  if (typeof flags.at === "string") body.at = validateDate(flags.at, "--at", INVENTORY_HELP);

  const result = await api.post(`/api/kitchen/inventory/${encodeURIComponent(itemUlid)}/consume`, body);
  if (flags.json) return rawJson(result);

  const cli = cliInvocation();
  return renderOutput([
    renderObject({ created: result?.created ?? null }),
    renderDetail("entry", result?.entry, ENTRY_ROW_SCHEMA),
    renderDetail("item", result?.item, ITEM_DETAIL_SCHEMA),
    renderHelp([
      result?.created
        ? `Logged + depleted in one atomic step — run \`${cli} entries show ${result?.entry?.ulid}\` to see the entry`
        : `Replay of an already-consumed request — entry ${result?.entry?.ulid} was NOT re-created, item was NOT re-depleted`,
    ]),
  ]);
}

function validateShelfLife(value: string): string {
  if (!(SHELF_LIFE_CLASSES as readonly string[]).includes(value)) {
    throw new AxiError(`--shelf-life must be one of: ${SHELF_LIFE_CLASSES.join(", ")}`, "VALIDATION_ERROR", [INVENTORY_HELP]);
  }
  return value;
}

/**
 * Guard a convert `--to` shelf_life_class client-side (§ Shelf-life classes —
 * "A `convert` derived item accepts only made-food shelf-life classes"): a
 * converted (made) item accepts only the made-food classes, so reject the
 * package-durable ones with a clean AXI error before the network call. A
 * missing/undefined class is fine — the server defaults it to `prepared`.
 */
export function assertConvertShelfLifeClass(cls: unknown): void {
  if (typeof cls === "string" && (PACKAGE_DURABLE_SHELF_LIFE_CLASSES as readonly string[]).includes(cls)) {
    throw new AxiError(
      `--to shelf_life_class "${cls}" is a package-durable class; a converted (made) item accepts only made-food classes: ${CONVERT_SHELF_LIFE_CLASSES.join(", ")} (default "prepared")`,
      "VALIDATION_ERROR",
      [INVENTORY_HELP]
    );
  }
}
