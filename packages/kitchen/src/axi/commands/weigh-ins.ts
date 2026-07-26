import { api } from "../client.js";
import { AxiError } from "axi-sdk-js";
import { parseArgs, rawJson, validateDate, parseNumberFlag } from "../args.js";
import { renderList, renderDetail, renderOutput, type FieldDef, field } from "../toon.js";
import { generateUlid } from "../../ulid.js";

export const WEIGH_INS_HELP = `kitchen-axi weigh-ins <subcommand> [args] [--json]

  log --weight KG [--body-fat PCT] [--at TIME]
                                       record a manual weigh-in (source: manual;
                                       --at defaults to now — prefer a full local
                                       timestamp; a bare YYYY-MM-DD backstops to
                                       local noon that day; a naive time gets this
                                       machine's local offset attached, because the
                                       server refuses to guess a zone)
  list [--since DATE] [--limit N]      raw readings, newest first

  Every reading is a row — repeats and all; noise collapses at read time
  (daily median), never by rewriting observations. For the derived daily/
  trend view, use \`weight trend\`. The trend is context for the OWNER'S
  judgment: nothing auto-tunes the TDEE base or targets from it.`;

export const WEIGHT_HELP = `kitchen-axi weight <subcommand> [args] [--json]

  trend [--days N]                     derived view over the last N days
                                       (default 30): one line per local day
                                       with readings (median weight, median
                                       body-fat of non-null values, reading
                                       count) plus a 7-day rolling mean over
                                       the days that exist — no interpolation

  Days bucket by each reading's OWN recorded UTC offset, not this machine's
  zone. Raw rows stay intact — inspect them with \`weigh-ins list\`.`;

const ROW_SCHEMA: FieldDef[] = [
  field("ulid"),
  field("local_date"),
  field("occurred_at"),
  field("weight_kg"),
  field("body_fat_pct"),
  field("source"),
];

const DAILY_SCHEMA: FieldDef[] = [
  field("date"),
  field("weight_kg"),
  field("body_fat_pct"),
  field("readings"),
];

const TREND_SCHEMA: FieldDef[] = [field("date"), field("weight_kg")];

/** Trailing explicit-offset designator: Z, ±HH:MM, or ±HHMM. */
const OFFSET_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * The weigh-in API refuses zone-naive timestamps (the server never infers a
 * clock), so the CLI — which DOES know its machine's zone — attaches the
 * local offset in effect on that date to any naive --at before sending.
 * Values already carrying Z/±HH:MM pass through untouched.
 */
export function ensureExplicitOffset(value: string): string {
  if (OFFSET_PATTERN.test(value)) return value;
  const local = new Date(value); // naive ISO parses in the machine's local zone
  const offsetMinutes = -local.getTimezoneOffset(); // minutes east of UTC, DST-correct for that date
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${value}${sign}${hh}:${mm}`;
}

export async function weighInsCommand(args: string[]): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "log":
      return logWeighIn(rest);
    case "list":
    case undefined:
      return listWeighIns(sub === undefined ? args : rest);
    default:
      throw new AxiError(`Unknown weigh-ins subcommand: ${sub}`, "VALIDATION_ERROR", [WEIGH_INS_HELP]);
  }
}

export async function weightCommand(args: string[]): Promise<string> {
  const sub = args[0];
  switch (sub) {
    case "trend":
      return weightTrend(args.slice(1));
    default:
      throw new AxiError(`Unknown weight subcommand: ${sub ?? "(none)"}`, "VALIDATION_ERROR", [WEIGHT_HELP]);
  }
}

async function logWeighIn(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"], ["weight", "body-fat", "at"]);
  if (typeof flags.weight !== "string") {
    throw new AxiError("weigh-ins log needs --weight (kg)", "VALIDATION_ERROR", [WEIGH_INS_HELP]);
  }
  const body: Record<string, unknown> = {
    // Manual rows use fresh ulids (idempotency seeding is for Health Connect
    // re-reads, which the capture app posts via hc_uuid).
    ulid: generateUlid(),
    source: "manual",
    weight_kg: parseNumberFlag(flags.weight, "weight", WEIGH_INS_HELP, { min: 0.001 }),
    occurred_at:
      typeof flags.at === "string"
        ? ensureExplicitOffset(validateDate(flags.at, "--at", WEIGH_INS_HELP))
        : new Date().toISOString(),
  };
  if (typeof flags["body-fat"] === "string") {
    body.body_fat_pct = parseNumberFlag(flags["body-fat"], "body-fat", WEIGH_INS_HELP, { min: 0, max: 100 });
  }
  const row = await api.post("/api/kitchen/weigh-ins", body);
  if (flags.json) return rawJson(row);
  return renderDetail("weigh_in", row, ROW_SCHEMA);
}

async function listWeighIns(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"], ["since", "limit"]);
  const result = await api.get("/api/kitchen/weigh-ins", {
    since: typeof flags.since === "string" ? validateDate(flags.since, "--since", WEIGH_INS_HELP) : undefined,
    limit: typeof flags.limit === "string" ? String(parseNumberFlag(flags.limit, "limit", WEIGH_INS_HELP, { min: 1 })) : undefined,
  });
  if (flags.json) return rawJson(result);
  return renderList("weigh_ins", result?.weigh_ins ?? [], ROW_SCHEMA);
}

async function weightTrend(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"], ["days"]);
  const result = await api.get("/api/kitchen/weight", {
    days: typeof flags.days === "string" ? String(parseNumberFlag(flags.days, "days", WEIGHT_HELP, { min: 1, max: 366 })) : undefined,
  });
  if (flags.json) return rawJson(result);
  return renderOutput([
    renderList("daily", result?.daily ?? [], DAILY_SCHEMA),
    renderList("trend_7d", result?.trend ?? [], TREND_SCHEMA),
  ]);
}
