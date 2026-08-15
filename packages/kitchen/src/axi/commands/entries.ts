import { api } from "../client.js";
import { generateUlid } from "../../ulid.js";
import {
  parseArgs,
  collectFlag,
  requirePositional,
  rawJson,
  validateDate,
  parseNumberFlag,
} from "../args.js";
import { AxiError } from "axi-sdk-js";
import { renderList, renderDetail, renderObject, renderOutput, renderHelp, field, custom, type FieldDef } from "../toon.js";
import { ENTRY_ROW_SCHEMA, effectiveMacro } from "../format.js";
import { cliInvocation } from "../invocation.js";
import { discoveryHelp, MACRO_PANEL_FLAGS, MACRO_PANEL_FLAG_NAMES } from "../reference.js";

export const ENTRIES_HELP = `kitchen-axi entries <subcommand> [args] [--json]

  list [--since DATE] [--limit N]      newest-first consumption entries
  show <ulid>                          one entry, full nutrition/source/status
  log [note…] [--recipe ULID]          log a deliberate no-model entry
       [--component "label=grams"]…      (repeatable; recipe → deterministic macros)
       [--at TIME]                       set logged_at; default now. Prefer a full local
                                          timestamp (2026-04-29T14:30:00-04:00); a bare
                                          YYYY-MM-DD backstops to local noon that day
       [--calories N] [--protein N]…     directly-stated panel: born-manual, terminal,
       [--label T]                        NO estimation (mutually exclusive with --recipe/--component)
  patch <ulid> [flags]                 edit note/label (re-queue), macro override
                                         (terminal — ANY of the nine panel flags),
                                         --multiplier M (post-hoc rescale),
                                         or --at TIME (backdate logged_at)
  questions [--limit N]                entries whose HUMAN note nobody has reconciled
                                         against the panel — a condiment, a splash of
                                         oil, an extra the components never covered
  review <ulid>                        mark one looked at. Records that a human READ
                                         the note, NOT that the numbers changed —
                                         correct those with 'patch' first if needed
  delete <ulid>                        remove from all rollups

  Macros on the wire are the BASE; effective = base × portion_multiplier. A
  macro flag on patch sets a terminal manual override; --multiplier and --at
  only touch their own field — neither re-queues estimation nor changes source.
  Macro flags (identical on log and patch): ${MACRO_PANEL_FLAG_NAMES.map((f) => `--${f}`).join(" ")}
  — the nine-field nutrition panel; unknown stays null, never 0. Every field is
  correctable in place, so never delete + re-log to fix a number (that mints a
  new ULID and breaks anything referencing the entry).
  --sugar is TOTAL sugar (no target); --added-sugar is the part added in
  processing or preparation and is the one with a ceiling. Whole foods (fruit,
  plain dairy, eggs, meat, plain grains) are --added-sugar 0 — a null there
  silently drops the day's added-sugar total.`;

const DETAIL_SCHEMA: FieldDef[] = [
  field("ulid"),
  // `day` = owner-tz calendar date (authoritative bucketing key); `logged`
  // renders the instant in the owner zone (§ Timezone & local-day bucketing).
  field("day"),
  field("logged_local", "logged"),
  field("note"),
  field("label"),
  field("status"),
  field("source"),
  field("portion_multiplier", "mult"),
  field("calories", "base_kcal"),
  field("protein_g", "base_protein"),
  field("fat_g", "base_fat"),
  field("sat_fat_g", "base_sat_fat"),
  field("carbs_g", "base_carbs"),
  field("sugar_g", "base_sugar"),
  field("added_sugar_g", "base_added_sugar"),
  field("fiber_g", "base_fiber"),
  field("sodium_mg", "base_sodium"),
  custom("eff_kcal", (e) => effectiveMacro(e, "calories")),
  custom("eff_protein", (e) => effectiveMacro(e, "protein_g")),
  field("confidence"),
  field("portion_basis"),
  field("recipe_ulid"),
  // Non-food lines the estimator dropped rather than estimating (§ Billing
  // artifacts are not ingredients). Rendered as `kind: text` pairs so an
  // over-eager exclusion — a real food line reported as a fee — is readable
  // right next to the numbers it was left out of. Absent when nothing was.
  custom("excluded_lines", (e) => {
    const lines = e.excluded_lines;
    if (!Array.isArray(lines) || lines.length === 0) return null;
    return lines
      .map((l) => {
        const row = (l ?? {}) as Record<string, unknown>;
        return `${row.kind ?? "other"}: ${row.text ?? ""}`;
      })
      .join("; ");
  }),
  field("last_error"),
];

export async function entriesCommand(args: string[]): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
    case undefined:
      return listEntries(sub === undefined ? args : rest);
    case "show":
      return showEntry(rest);
    case "log":
      return logEntry(rest);
    case "patch":
      return patchEntry(rest);
    case "questions":
      return listNoteQuestions(rest);
    case "review":
      return reviewNote(rest);
    case "delete":
      return deleteEntry(rest);
    default:
      throw new AxiError(`Unknown entries subcommand: ${sub}`, "VALIDATION_ERROR", [ENTRIES_HELP]);
  }
}

async function listEntries(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"], ["since", "limit"]);
  const since = typeof flags.since === "string" ? validateDate(flags.since, "--since", ENTRIES_HELP) : undefined;
  const limit = typeof flags.limit === "string" ? String(parseNumberFlag(flags.limit, "limit", ENTRIES_HELP, { min: 1 })) : undefined;
  const result = await api.get("/api/kitchen/entries", { since, limit });
  if (flags.json) return rawJson(result);
  const entries = result?.entries ?? [];
  return renderList("entries", entries, ENTRY_ROW_SCHEMA);
}

/**
 * Entries whose HUMAN-supplied note nobody has reconciled against the panel
 * (specs/modules/kitchen.md § Unreviewed entry notes). The entries-side twin of
 * `inventory questions` — deliberately the same word, because it is the same
 * idea: a human said something the ledger has not accounted for.
 */
async function listNoteQuestions(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"], ["limit"]);
  const limit = typeof flags.limit === "string" ? String(parseNumberFlag(flags.limit, "limit", ENTRIES_HELP, { min: 1 })) : undefined;
  const result = await api.get("/api/kitchen/entries/questions", { limit });
  if (flags.json) return rawJson(result);
  const entries = result?.entries ?? [];
  if (entries.length === 0) {
    return renderList("unreviewed_notes", [], ENTRY_ROW_SCHEMA);
  }
  return [
    renderList("unreviewed_notes", entries, ENTRY_ROW_SCHEMA),
    renderHelp([
      "Each row's note names something the computed panel may not include",
      "Run `kitchen-axi entries review <ulid>` once you have looked — reviewing records that you READ it, not that anything changed",
      "If it DOES change the numbers, `kitchen-axi entries patch <ulid> --calories … --sodium …` first, then review",
    ]),
  ].join("\n");
}

/** Mark a note looked at. Touches only the flag — correcting macros is `patch`. */
async function reviewNote(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], []);
  const ulid = requirePositional(positionals, 0, "entry ulid", ENTRIES_HELP);
  const entry = await api.post(`/api/kitchen/entries/${encodeURIComponent(ulid)}/review`, {});
  if (flags.json) return rawJson(entry);
  return [
    renderDetail("reviewed", entry, DETAIL_SCHEMA),
    renderHelp(
      entry?.changed === false
        ? ["Already reviewed — no change (replaying a review is a safe no-op)"]
        : ["Panel untouched: review records that a human read the note, never that the numbers moved"]
    ),
  ].join("\n");
}

async function showEntry(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], []);
  const ulid = requirePositional(positionals, 0, "entry ulid", ENTRIES_HELP);
  const entry = await api.get(`/api/kitchen/entries/${encodeURIComponent(ulid)}`);
  if (flags.json) return rawJson(entry);
  return renderDetail("entry", entry, DETAIL_SCHEMA);
}

/** Parse a `--component "label=grams"` value into {label, quantity_g}. */
function parseComponent(raw: string): { label: string; quantity_g: number } {
  const eq = raw.lastIndexOf("=");
  if (eq <= 0) {
    throw new AxiError(`--component must be "label=grams" (got ${raw})`, "VALIDATION_ERROR", [ENTRIES_HELP]);
  }
  const label = raw.slice(0, eq).trim();
  const qty = Number(raw.slice(eq + 1).trim());
  if (!label || !Number.isFinite(qty) || qty < 0) {
    throw new AxiError(`--component must be "label=grams" with a non-negative number (got ${raw})`, "VALIDATION_ERROR", [ENTRIES_HELP]);
  }
  return { label, quantity_g: qty };
}

/**
 * Pure: build the `entry` JSON part's fields (everything but the ulid, which
 * the caller generates) from `entries log`'s parsed positionals/flags —
 * including `--at` → `logged_at` (claude-assist#111; the field is already
 * accepted by `POST /entries`, this only wires the CLI flag to it) and the
 * directly-stated panel flags (`--calories`/`--protein`/… → `macros`, with an
 * optional `--label`). Exported so the arg-parse → server-field wiring is
 * unit-testable without a live server.
 */
export function buildLogEntryFields(
  positionals: string[],
  flags: Record<string, string | boolean>,
  components: Array<{ label: string; quantity_g: number }>
): Record<string, unknown> {
  const note = positionals.join(" ").trim();
  const recipe = typeof flags.recipe === "string" ? flags.recipe : undefined;
  const label = typeof flags.label === "string" ? flags.label : undefined;

  // Directly-stated panel: any macro flag present makes this a born-manual entry.
  const macros: Record<string, number> = {};
  for (const [flag, key] of MACRO_PANEL_FLAGS) {
    if (typeof flags[flag] === "string") {
      macros[key] = parseNumberFlag(flags[flag] as string, flag, ENTRIES_HELP, { min: 0 });
    }
  }
  const hasMacros = Object.keys(macros).length > 0;

  if (hasMacros && (recipe || components.length)) {
    throw new AxiError(
      "entries log: a directly-stated panel (--calories/--protein/…) is mutually exclusive with --recipe/--component",
      "VALIDATION_ERROR",
      [ENTRIES_HELP]
    );
  }
  if (label !== undefined && !hasMacros) {
    throw new AxiError("entries log: --label is only valid with a directly-stated panel (--calories/…)", "VALIDATION_ERROR", [ENTRIES_HELP]);
  }
  if (!note && !recipe && !hasMacros) {
    throw new AxiError("entries log needs a note, --recipe, or a directly-stated panel (--calories/…)", "VALIDATION_ERROR", [ENTRIES_HELP]);
  }

  const entry: Record<string, unknown> = {};
  if (note) entry.note = note;
  if (recipe) entry.recipe_ulid = recipe;
  if (components.length) entry.component_quantities = components;
  if (typeof flags.at === "string") entry.logged_at = validateDate(flags.at, "--at", ENTRIES_HELP);
  if (hasMacros) entry.macros = macros;
  if (label !== undefined) entry.label = label;
  return entry;
}

async function logEntry(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(
    args,
    ["json"],
    ["recipe", "component", "at", "label", ...MACRO_PANEL_FLAG_NAMES]
  );
  const components = collectFlag(args, "component").map(parseComponent);
  const entry: Record<string, unknown> = { ulid: generateUlid(), ...buildLogEntryFields(positionals, flags, components) };

  const form = new FormData();
  form.append("entry", JSON.stringify(entry));
  const record = await api.postForm("/api/kitchen/entries", form);

  if (flags.json) return rawJson(record);
  const cli = cliInvocation();
  return renderOutput([
    renderDetail("logged", record, DETAIL_SCHEMA),
    renderHelp([
      record?.status === "estimating"
        ? `Estimating — run \`${cli} entries show ${record?.ulid}\` to see the result`
        : `Run \`${cli} entries patch ${record?.ulid} --multiplier 0.5\` to rescale, or --calories N to override`,
    ]),
  ]);
}

/**
 * Pure: build the PATCH body from `entries patch`'s parsed flags, including
 * `--at` → `logged_at` (claude-assist#111; a metadata edit like
 * `--multiplier` — the server field already never re-queues estimation or
 * changes source). Exported so the arg-parse → `logged_at` wiring is
 * unit-testable without a live server.
 */
export function buildPatchBody(flags: Record<string, string | boolean>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (typeof flags.note === "string") body.note = flags.note;
  if (typeof flags.label === "string") body.label = flags.label;
  if (typeof flags["portion-basis"] === "string") body.portion_basis = flags["portion-basis"];

  // Same nine-field panel `log` accepts, from the same source (§ Agent
  // tooling) — every logged field must be correctable in place.
  for (const [flag, key] of MACRO_PANEL_FLAGS) {
    if (typeof flags[flag] === "string") body[key] = parseNumberFlag(flags[flag] as string, flag, ENTRIES_HELP, { min: 0 });
  }
  if (typeof flags.multiplier === "string") {
    body.portion_multiplier = parseNumberFlag(flags.multiplier, "multiplier", ENTRIES_HELP, { min: 0.0001, max: 20 });
  }
  if (typeof flags.at === "string") {
    body.logged_at = validateDate(flags.at, "--at", ENTRIES_HELP);
  }

  if (Object.keys(body).length === 0) {
    throw new AxiError("entries patch needs at least one field to change", "VALIDATION_ERROR", [ENTRIES_HELP]);
  }
  return body;
}

async function patchEntry(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], ["note", "label", "portion-basis", ...MACRO_PANEL_FLAG_NAMES, "multiplier", "at"]);
  const ulid = requirePositional(positionals, 0, "entry ulid", ENTRIES_HELP);
  const body = buildPatchBody(flags);

  const updated = await api.patch(`/api/kitchen/entries/${encodeURIComponent(ulid)}`, body);
  if (flags.json) return rawJson(updated);
  return renderDetail("entry", updated, DETAIL_SCHEMA);
}

async function deleteEntry(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["json"], []);
  const ulid = requirePositional(positionals, 0, "entry ulid", ENTRIES_HELP);
  await api.del(`/api/kitchen/entries/${encodeURIComponent(ulid)}`);
  if (flags.json) return rawJson({ deleted: ulid });
  return renderObject({ deleted: ulid });
}
