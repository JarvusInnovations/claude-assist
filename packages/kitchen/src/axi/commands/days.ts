import { api } from "../client.js";
import { AxiError } from "axi-sdk-js";
import { parseArgs, rawJson, validateDate } from "../args.js";
import { renderList, renderObject, renderOutput, renderHelp, field, type FieldDef } from "../toon.js";
import { cliInvocation } from "../invocation.js";

/**
 * `kitchen-axi days` — the per-owner-local-day rollup (specs/modules/kitchen.md
 * § Timezone & local-day bucketing). The MODULE owns the day boundaries via its
 * configured owner timezone; this command never supplies, knows, or computes an
 * offset. One row per local day over the window — the nine-field panel,
 * calories, and the net line (when a TDEE base is configured). An agent asking
 * "how did the week go" calls this ONCE instead of listing entries and
 * hand-summing them by UTC date (the recurring mis-bucketing footgun this
 * command exists to retire).
 */

export const DAYS_HELP = `kitchen-axi days [--since <n|date>] [--json]

  Per-owner-local-day rollup: one row per day over the window, each with the
  nine-field nutrition panel + calories (EFFECTIVE totals) and — when the
  instance sets a TDEE base — the net line ((TDEE base + burns) − intake).

  \`sugar\` is TOTAL sugar and has no target; \`added_sugar\` is the part added in
  processing and is the one that carries a ceiling. A null in either column means
  no entry that day carried the field — unknown, not zero.

  --since <n|date>   window start: a day count (e.g. 7 or 7d = last 7 days) or a
                     date (YYYY-MM-DD). Default: last 7 days.
  --json             raw JSON

  Days bucket by the instance's OWNER timezone, server-side — you never supply or
  compute an offset. Use this for any multi-day/weekly total; never hand-sum
  \`entries list\` rows by their timestamp.`;

const DAY_SCHEMA: FieldDef[] = [
  field("day"),
  field("calories", "kcal"),
  field("protein_g", "protein"),
  field("fat_g", "fat"),
  field("sat_fat_g", "sat_fat"),
  field("carbs_g", "carbs"),
  field("sugar_g", "sugar"),
  // Total sugar and its added share, side by side and unjudged: `days` is a
  // table, not the home view's nested figure, and NEITHER column carries a
  // verdict here (§ Display: only added sugar has a threshold at all).
  field("added_sugar_g", "added_sugar"),
  field("fiber_g", "fiber"),
  field("sodium_mg", "sodium"),
  field("entry_count", "entries"),
  field("expenditure_kcal", "burned"),
  field("net_kcal", "net"),
];

/** Parse `--since`: a bare day-count (`7`/`7d`) → ISO start; else a date. */
function resolveSince(raw: string): string {
  const m = /^(\d+)d?$/.exec(raw.trim());
  if (m) {
    const days = parseInt(m[1]!, 10);
    if (days < 1) throw new AxiError("--since day count must be >= 1", "VALIDATION_ERROR", [DAYS_HELP]);
    return new Date(Date.now() - days * 86_400_000).toISOString();
  }
  return validateDate(raw, "--since", DAYS_HELP);
}

export async function daysCommand(args: string[]): Promise<string> {
  const sub = args[0];
  // Reject an unknown subcommand explicitly (this group has no subcommands) so a
  // typo like `days lst` isn't silently treated as a window.
  if (sub === "--help") throw new AxiError(DAYS_HELP, "VALIDATION_ERROR", [DAYS_HELP]);

  const { flags } = parseArgs(args, ["json"], ["since"]);
  const since = typeof flags.since === "string" ? resolveSince(flags.since) : undefined;

  const result = await api.get("/api/kitchen/summary", { group: "day", since });
  if (flags.json) return rawJson(result);

  const days = Array.isArray(result?.days) ? result.days : [];
  const cli = cliInvocation();
  const blocks: string[] = [];
  // State the timezone only when it's the UTC fallback (KITCHEN_OWNER_TZ unset)
  // — a stated fallback, never a silent guess; a configured zone stays quiet.
  if (typeof result?.tz === "string" && result.tz.includes("unset")) {
    blocks.push(renderObject({ tz: result.tz }));
  }
  blocks.push(
    days.length ? renderList("days", days, DAY_SCHEMA) : "days: no entries in window"
  );
  blocks.push(
    renderHelp([
      `Days bucket by the instance owner timezone, server-side — group/total by \`day\`, never by a raw timestamp`,
      `Run \`${cli} entries list --since <date>\` to see the individual entries behind a day`,
    ]),
  );
  return renderOutput(blocks);
}
