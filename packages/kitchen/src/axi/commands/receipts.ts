import { existsSync } from "node:fs";
import { api, buildMultipartForm } from "../client.js";
import { generateUlid } from "../../ulid.js";
import { AxiError } from "axi-sdk-js";
import { parseArgs, requirePositional, rawJson, validateDate, parseNumberFlag } from "../args.js";
import { renderList, renderDetail, renderObject, renderOutput, renderHelp, field, type FieldDef } from "../toon.js";
import { cliInvocation } from "../invocation.js";

export const RECEIPTS_HELP = `kitchen-axi receipts <subcommand> [args] [--json]

  list [--limit N]                          recent purchase batches + parse status
  show <ulid>                               one batch + parsed line outcomes
  scan <photo…> [--store S]                 post a batch from receipt photos
       [--purchased-at DATE] [--ulid U]       (parses asynchronously)

  scan posts immediately (status 'parsing') and is idempotent on --ulid (one is
  generated when omitted). The receipt meta is sent as a multipart form FIELD,
  photos as file parts. A cheap model then extracts lines; known lines (via the
  store lexicon) become stocked items, unknown lines become needs-info items.`;

const BATCH_ROW_SCHEMA: FieldDef[] = [
  field("ulid"),
  field("store"),
  field("purchased_at", "purchased"),
  field("status"),
  field("parse_attempts", "attempts"),
  field("last_error"),
];

const LINE_SCHEMA: FieldDef[] = [
  field("raw_text", "line"),
  field("quantity", "qty"),
  field("match_outcome", "outcome"),
  field("product_ulid"),
  field("inventory_item_ulid", "item_ulid"),
];

export async function receiptsCommand(args: string[]): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
    case undefined:
      return listBatches(sub === undefined ? args : rest);
    case "show":
      return showBatch(rest);
    case "scan":
      return scanReceipt(rest);
    default:
      throw new AxiError(`Unknown receipts subcommand: ${sub}`, "VALIDATION_ERROR", [RECEIPTS_HELP]);
  }
}

async function listBatches(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"], ["limit"]);
  const limit = typeof flags.limit === "string" ? String(parseNumberFlag(flags.limit, "limit", RECEIPTS_HELP, { min: 1 })) : undefined;
  const result = await api.get("/api/kitchen/receipts", { limit });
  if (flags.json) return rawJson(result);
  const batches = result?.batches ?? [];
  return renderList("batches", batches, BATCH_ROW_SCHEMA);
}

async function showBatch(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], []);
  const ulid = requirePositional(positionals, 0, "batch ulid", RECEIPTS_HELP);
  const result = await api.get(`/api/kitchen/receipts/${encodeURIComponent(ulid)}`);
  if (flags.json) return rawJson(result);
  const lines = result?.lines ?? [];
  return renderOutput([
    renderDetail("batch", result?.batch ?? {}, BATCH_ROW_SCHEMA),
    renderList("lines", lines, LINE_SCHEMA),
  ]);
}

async function scanReceipt(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], ["store", "purchased-at", "ulid"]);
  const photos = positionals;
  if (photos.length === 0) {
    throw new AxiError("receipts scan needs at least one photo path", "VALIDATION_ERROR", [RECEIPTS_HELP]);
  }
  for (const p of photos) {
    if (!existsSync(p)) throw new AxiError(`Photo not found: ${p}`, "VALIDATION_ERROR", [RECEIPTS_HELP]);
  }

  const meta: Record<string, unknown> = { ulid: typeof flags.ulid === "string" ? flags.ulid : generateUlid() };
  if (typeof flags.store === "string") meta.store = flags.store;
  if (typeof flags["purchased-at"] === "string") meta.purchased_at = validateDate(flags["purchased-at"], "--purchased-at", RECEIPTS_HELP);

  const form = await buildMultipartForm("receipt", meta, photos);
  const batch = await api.postForm("/api/kitchen/receipts", form);

  if (flags.json) return rawJson(batch);
  const cli = cliInvocation();
  return renderOutput([
    renderDetail("batch", batch, BATCH_ROW_SCHEMA),
    renderHelp([`Parsing asynchronously — run \`${cli} receipts show ${batch?.ulid}\` to see extracted lines`]),
  ]);
}
