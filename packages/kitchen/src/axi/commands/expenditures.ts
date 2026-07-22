import { api } from "../client.js";
import { AxiError } from "axi-sdk-js";
import { parseArgs, requirePositional, rawJson, validateDate, parseNumberFlag } from "../args.js";
import { renderList, renderDetail, renderObject, type FieldDef, field } from "../toon.js";

export const EXPENDITURE_HELP = `kitchen-axi expenditure <subcommand> [args] [--json]

  log "<label>" --kcal N [--duration M] [--avg-hr H] [--at TIME] [--source S] [--ulid U]
                                       record a stated burn (default source: manual;
                                       --at defaults to now; idempotent on --ulid)
  list [--since DATE] [--limit N]      recent expenditures, newest first
  delete <ulid>                        remove from all rollups

  Burns are always STATED — a device said it, or you did; there is no model
  estimation path for a burn (§ Expenditure & net energy). kcal is ACTIVE
  calories, not gross. The daily net line ((TDEE base + burns) − intake) is
  CONTEXT, not a spend-it budget: the intake range stays the target, and
  nothing here computes "remaining to eat" from a workout.`;

const ROW_SCHEMA: FieldDef[] = [
  field("ulid"),
  field("occurred_at"),
  field("label"),
  field("source"),
  field("kcal"),
  field("duration_min"),
  field("avg_hr"),
];

const SOURCES = ["strava", "health_connect", "garmin", "manual"];

export async function expenditureCommand(args: string[]): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "log":
      return logExpenditure(rest);
    case "list":
    case undefined:
      return listExpenditures(sub === undefined ? args : rest);
    case "delete":
      return deleteExpenditure(rest);
    default:
      throw new AxiError(`Unknown expenditure subcommand: ${sub}`, "VALIDATION_ERROR", [EXPENDITURE_HELP]);
  }
}

async function logExpenditure(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], ["kcal", "duration", "avg-hr", "at", "source", "ulid"]);
  const label = positionals.join(" ").trim();
  if (!label) throw new AxiError("expenditure log needs a label", "VALIDATION_ERROR", [EXPENDITURE_HELP]);
  if (typeof flags.kcal !== "string") {
    throw new AxiError("expenditure log needs --kcal (active calories)", "VALIDATION_ERROR", [EXPENDITURE_HELP]);
  }
  const source = typeof flags.source === "string" ? flags.source : "manual";
  if (!SOURCES.includes(source)) {
    throw new AxiError(`--source must be one of: ${SOURCES.join(", ")}`, "VALIDATION_ERROR", [EXPENDITURE_HELP]);
  }
  const body: Record<string, unknown> = {
    label,
    source,
    kcal: parseNumberFlag(flags.kcal, "kcal", EXPENDITURE_HELP, { min: 0 }),
    occurred_at:
      typeof flags.at === "string"
        ? validateDate(flags.at, "--at", EXPENDITURE_HELP)
        : new Date().toISOString(),
  };
  if (typeof flags.duration === "string") {
    body.duration_min = parseNumberFlag(flags.duration, "duration", EXPENDITURE_HELP, { min: 0 });
  }
  if (typeof flags["avg-hr"] === "string") {
    body.avg_hr = parseNumberFlag(flags["avg-hr"], "avg-hr", EXPENDITURE_HELP, { min: 0 });
  }
  if (typeof flags.ulid === "string") body.ulid = flags.ulid;

  const row = await api.post("/api/kitchen/expenditures", body);
  if (flags.json) return rawJson(row);
  return renderDetail("expenditure", row, ROW_SCHEMA);
}

async function listExpenditures(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"], ["since", "limit"]);
  const result = await api.get("/api/kitchen/expenditures", {
    since: typeof flags.since === "string" ? validateDate(flags.since, "--since", EXPENDITURE_HELP) : undefined,
    limit: typeof flags.limit === "string" ? String(parseNumberFlag(flags.limit, "limit", EXPENDITURE_HELP, { min: 1 })) : undefined,
  });
  if (flags.json) return rawJson(result);
  return renderList("expenditures", result?.expenditures ?? [], ROW_SCHEMA);
}

async function deleteExpenditure(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], []);
  const ulid = requirePositional(positionals, 0, "expenditure ulid", EXPENDITURE_HELP);
  await api.del(`/api/kitchen/expenditures/${encodeURIComponent(ulid)}`);
  if (flags.json) return rawJson({ deleted: ulid });
  return renderObject({ deleted: ulid });
}
