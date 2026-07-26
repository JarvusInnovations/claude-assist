import { api, resolveServer } from "../client.js";
import { parseArgs, rawJson } from "../args.js";
import { renderOutput, renderObject, renderList, renderHelp, field, type FieldDef } from "../toon.js";
import { sumEffective, targetLine, type MacroKey, type TargetBound } from "../format.js";
import { discoveryHelp } from "../reference.js";
import { cliInvocation } from "../invocation.js";

/**
 * Home view (no-args invocation): the at-a-glance kitchen state an agent needs
 * before acting — today's entry count + effective totals, the pending-estimate
 * count, the top eat-first items, and the open needs-info question count
 * (specs/modules/kitchen.md § Agent tooling). Deliberately lean (well under 2KB
 * for a typical day) so it can ride a SessionStart injection cheaply. Resilient:
 * if the server is unreachable it renders a status line and help, not an error.
 */

export const HOME_HELP = `kitchen-axi [--eat-first N] [--json]

  The no-arg view: today's entries + effective macro totals, pending-estimate
  count, the top eat-first inventory items, and the open needs-info question
  count. Fields with an owner-set daily target render as logged / target with
  remaining (caps count down what's left; floors count up to met).

  --eat-first N   how many eat-first items to show (default 3)
  --json          raw JSON`;

const EAT_FIRST_SCHEMA: FieldDef[] = [
  field("product_name", "name"),
  field("state"),
  field("eat_by"),
  field("days_until_eat_by", "days_left"),
  field("on_hand_fraction", "on_hand"),
];

function startOfTodayIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

export async function homeCommand(args: string[]): Promise<string> {
  const { flags } = parseArgs(args, ["json"], ["eat-first"]);
  const server = resolveServer();
  const cli = cliInvocation();
  const eatFirstN = typeof flags["eat-first"] === "string" ? Math.max(parseInt(flags["eat-first"], 10) || 3, 1) : 3;

  let entries: any[] | null = null;
  let items: any[] = [];
  let questionCount = 0;
  let summary: any = null;
  let reachable = true;

  // Local-day window for the net-energy summary (the server makes no
  // timezone assumptions — the caller owns its day boundaries).
  const dayStart = startOfTodayIso();
  const dayEnd = new Date(new Date(dayStart).getTime() + 24 * 60 * 60 * 1000).toISOString();

  try {
    const [entriesRes, invRes, qRes, summaryRes] = await Promise.all([
      api.get("/api/kitchen/entries", { since: dayStart }),
      api.get("/api/kitchen/inventory", { limit: eatFirstN }),
      api.get("/api/kitchen/inventory/questions", { limit: 1 }),
      api.get("/api/kitchen/summary", { since: dayStart, until: dayEnd }).catch(() => null),
    ]);
    entries = Array.isArray(entriesRes?.entries) ? entriesRes.entries : [];
    items = Array.isArray(invRes?.items) ? invRes.items : [];
    questionCount = typeof qRes?.count === "number" ? qRes.count : 0;
    summary = summaryRes;
  } catch {
    reachable = false;
  }

  if (flags.json) {
    return rawJson({ server, today: entries, eat_first: items, questions: questionCount });
  }

  if (!reachable || entries === null) {
    return renderOutput([
      renderObject({ server }),
      "The server is not reachable. Set CLAUDE_ASSIST_SERVER or start it (cd apps/server && docker-compose up -d).",
      renderHelp([discoveryHelp(cli)]),
    ]);
  }

  const pending = entries.filter((e) => e.status === "estimating").length;
  const failed = entries.filter((e) => e.status === "failed").length;
  const totals = sumEffective(entries);

  // Daily targets (§ Daily targets): when the instance configures a line for
  // a field, its plain total becomes `logged / target` with a direction-aware
  // remaining — display arithmetic only, never folded into the net line.
  const targets: Partial<Record<MacroKey, TargetBound>> =
    summary && summary.targets && typeof summary.targets === "object" ? summary.targets : {};
  const vsTarget = (key: MacroKey): number | string => {
    const bound = targets[key];
    return bound ? targetLine(totals[key], bound) : totals[key];
  };

  const today = renderObject({
    server,
    date: startOfTodayIso().slice(0, 10),
    entries: entries.length,
    pending_estimates: pending,
    ...(failed ? { failed } : {}),
    kcal: vsTarget("calories"),
    protein_g: vsTarget("protein_g"),
    fat_g: vsTarget("fat_g"),
    sat_fat_g: vsTarget("sat_fat_g"),
    carbs_g: vsTarget("carbs_g"),
    sugar_g: vsTarget("sugar_g"),
    fiber_g: vsTarget("fiber_g"),
    sodium_mg: vsTarget("sodium_mg"),
    // Net-energy context (§ Expenditure & net energy): shown only when the
    // day logged a burn and/or the instance configured a TDEE base. The net
    // is CONTEXT, not a spend-it budget — never a "remaining to eat" figure.
    ...(summary && summary.expenditure_count > 0 ? { burned_kcal: summary.expenditure_kcal } : {}),
    ...(summary && typeof summary.net_kcal === "number"
      ? { est_deficit_kcal: summary.net_kcal }
      : {}),
    open_questions: questionCount,
  });

  const blocks: string[] = [today];
  if (items.length) {
    blocks.push(renderList("eat_first", items, EAT_FIRST_SCHEMA));
  } else {
    blocks.push("eat_first: no on-hand items");
  }
  blocks.push(
    renderHelp([
      `Run \`${cli} entries list\` for today's log, \`${cli} entries log "<meal>"\` to log`,
      questionCount ? `Run \`${cli} inventory questions\` to answer ${questionCount} open needs-info item(s)` : "",
      `Run \`${cli} inventory list\` for full stock, \`${cli} recipes list\` for the reselect strip`,
      discoveryHelp(cli),
    ]),
  );
  return renderOutput(blocks);
}
