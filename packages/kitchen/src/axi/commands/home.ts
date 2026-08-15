import { api, resolveServer } from "../client.js";
import { parseArgs, rawJson } from "../args.js";
import { renderOutput, renderObject, renderList, renderHelp, field, type FieldDef } from "../toon.js";
import { targetLine, nestedSugarLine, type MacroKey, type TargetBound } from "../format.js";
import { discoveryHelp } from "../reference.js";
import { cliInvocation } from "../invocation.js";

/**
 * Home view (no-args invocation): the at-a-glance kitchen state an agent needs
 * before acting — today's entry count + effective totals, the pending-estimate
 * count, the top eat-first items, and the open needs-info question count
 * (specs/modules/kitchen.md § Agent tooling). Deliberately lean (well under 2KB
 * for a typical day) so it can ride a SessionStart injection cheaply. Resilient:
 * if the server is unreachable it renders a status line and help, not an error.
 *
 * "Today" is the OWNER-timezone day, derived SERVER-SIDE (§ Timezone & local-day
 * bucketing) — the CLI no longer computes a local-day window from its own machine
 * clock (the retired startOfTodayIso hack). The day-grouped summary reports both
 * the owner-local `today` date and the pre-computed totals for it, so the home
 * "today" figures match `days` for the current day by construction.
 */

export const HOME_HELP = `kitchen-axi [--eat-first N] [--json]

  The no-arg view: today's entries + effective macro totals, pending-estimate
  count, the top eat-first inventory items, and the open needs-info question
  count. Fields with an owner-set daily target render as logged / target with
  remaining (caps count down what's left; floors count up to met).

  "Today" is the instance owner timezone's day, computed server-side. For a
  multi-day trend use \`kitchen-axi days\`.

  --eat-first N   how many eat-first items to show (default 3)
  --json          raw JSON`;

const EAT_FIRST_SCHEMA: FieldDef[] = [
  field("product_name", "name"),
  field("state"),
  field("eat_by"),
  field("days_until_eat_by", "days_left"),
  field("on_hand_fraction", "on_hand"),
];

export async function homeCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"], ["eat-first"]);
  const server = resolveServer();
  const cli = cliInvocation();
  const eatFirstN = typeof flags["eat-first"] === "string" ? Math.max(parseInt(flags["eat-first"], 10) || 3, 1) : 3;

  let entries: any[] | null = null;
  let items: any[] = [];
  let questionCount = 0;
  let noteQuestionCount = 0;
  let summary: any = null;
  let reachable = true;

  // Window wide enough to include all of the owner-local "today" regardless of
  // the machine's zone; the server tells us which local day is today and stamps
  // each entry's `day`, so we filter on that rather than a self-computed boundary.
  const windowStart = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  try {
    const [entriesRes, invRes, qRes, summaryRes, noteQRes] = await Promise.all([
      api.get("/api/kitchen/entries", { since: windowStart }),
      api.get("/api/kitchen/inventory", { limit: eatFirstN }),
      api.get("/api/kitchen/inventory/questions", { limit: 1 }),
      api.get("/api/kitchen/summary", { group: "day", since: windowStart }).catch(() => null),
      // Unreviewed human notes on entries (specs/modules/kitchen.md § Unreviewed
      // entry notes) join the SAME open-question total as needs-info stock: one
      // vocabulary for "a human said something the ledger hasn't reconciled".
      // Tolerated as null so an older server without the route still renders.
      api.get("/api/kitchen/entries/questions", { limit: 1 }).catch(() => null),
    ]);
    entries = Array.isArray(entriesRes?.entries) ? entriesRes.entries : [];
    items = Array.isArray(invRes?.items) ? invRes.items : [];
    questionCount = typeof qRes?.count === "number" ? qRes.count : 0;
    noteQuestionCount = typeof noteQRes?.count === "number" ? noteQRes.count : 0;
    summary = summaryRes;
  } catch {
    reachable = false;
  }

  if (flags.json) {
    return rawJson({
      server,
      today: summary?.today,
      summary,
      entries,
      eat_first: items,
      questions: questionCount + noteQuestionCount,
      inventory_questions: questionCount,
      note_questions: noteQuestionCount,
    });
  }

  if (!reachable || entries === null) {
    return renderOutput([
      renderObject({ server }),
      "The server is not reachable. Set CLAUDE_ASSIST_SERVER or start it (cd apps/server && docker-compose up -d).",
      renderHelp([discoveryHelp(cli)]),
    ]);
  }

  // The owner-local day, server-derived. If the summary was unreachable, fall
  // back to the newest entry's own server-stamped `day` so "today" is still an
  // owner-tz date, never a machine-clock guess.
  const today: string | undefined =
    (summary && typeof summary.today === "string" ? summary.today : undefined) ??
    (entries[0] && typeof entries[0].day === "string" ? entries[0].day : undefined);

  // Today's entries, bucketed by the server-stamped owner-tz `day`.
  const todayEntries = today ? entries.filter((e) => e.day === today) : [];
  const pending = todayEntries.filter((e) => e.status === "estimating").length;
  const failed = todayEntries.filter((e) => e.status === "failed").length;

  // Totals for today come from the pre-computed day rollup (so home matches
  // `days` exactly); an empty/missing row means zero logged today.
  const todayRow: Record<string, any> =
    (summary && Array.isArray(summary.days) ? summary.days.find((d: any) => d.day === today) : null) ?? {};
  const totalOf = (key: MacroKey): number => (typeof todayRow[key] === "number" ? todayRow[key] : 0);
  // Null-preserving read, for the fields where "no entry carried it" must NOT
  // read as zero (§ Nutrition panel: unknown is null, never 0).
  const rawOf = (key: MacroKey): number | null => (typeof todayRow[key] === "number" ? todayRow[key] : null);

  // Daily targets (§ Daily targets): when the instance configures a line for
  // a field, its plain total becomes `logged / target` with a direction-aware
  // remaining — display arithmetic only, never folded into the net line.
  const targets: Partial<Record<MacroKey, TargetBound>> =
    summary && summary.targets && typeof summary.targets === "object" ? summary.targets : {};
  const vsTarget = (key: MacroKey): number | string => {
    const bound = targets[key];
    return bound ? targetLine(totalOf(key), bound) : totalOf(key);
  };

  const fallbackTz = typeof summary?.tz === "string" && summary.tz.includes("unset") ? summary.tz : undefined;

  const today_view = renderObject({
    server,
    // State the zone only on the UTC fallback (KITCHEN_OWNER_TZ unset) — a
    // stated fallback, never a silent guess.
    ...(fallbackTz ? { tz: fallbackTz } : {}),
    date: today ?? "unknown",
    entries: todayEntries.length,
    pending_estimates: pending,
    ...(failed ? { failed } : {}),
    kcal: vsTarget("calories"),
    protein_g: vsTarget("protein_g"),
    fat_g: vsTarget("fat_g"),
    sat_fat_g: vsTarget("sat_fat_g"),
    carbs_g: vsTarget("carbs_g"),
    // ONE nested figure for the sugar pair (§ Display: one nested bar, not
    // two): total sugar as the extent, added sugar inside it carrying the only
    // ceiling. Total sugar never gets an over/under verdict — there is no
    // guideline to breach, and a line here fires on fruit-and-dairy days.
    sugar_g: nestedSugarLine(rawOf("sugar_g"), rawOf("added_sugar_g"), targets.added_sugar_g),
    fiber_g: vsTarget("fiber_g"),
    sodium_mg: vsTarget("sodium_mg"),
    // Net-energy context (§ Expenditure & net energy): shown only when the
    // day logged a burn and/or the instance configured a TDEE base. The net
    // is CONTEXT, not a spend-it budget — never a "remaining to eat" figure.
    ...(typeof todayRow.expenditure_kcal === "number" && todayRow.expenditure_kcal > 0
      ? { burned_kcal: todayRow.expenditure_kcal }
      : {}),
    ...(typeof todayRow.net_kcal === "number" ? { est_deficit_kcal: todayRow.net_kcal } : {}),
    open_questions: questionCount + noteQuestionCount,
  });

  const blocks: string[] = [today_view];
  if (items.length) {
    blocks.push(renderList("eat_first", items, EAT_FIRST_SCHEMA));
  } else {
    blocks.push("eat_first: no on-hand items");
  }
  blocks.push(
    renderHelp([
      `Run \`${cli} entries list\` for today's log, \`${cli} entries log "<meal>"\` to log`,
      `Run \`${cli} days\` for the per-day trend (weekly totals, bucketed by the owner timezone)`,
      questionCount ? `Run \`${cli} inventory questions\` to answer ${questionCount} open needs-info item(s)` : "",
      `Run \`${cli} inventory list\` for full stock, \`${cli} recipes list\` for the reselect strip`,
      discoveryHelp(cli),
    ]),
  );
  return renderOutput(blocks);
}
