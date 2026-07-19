import { api, resolveServer } from "../client.js";
import { parseArgs, rawJson } from "../args.js";
import { renderOutput, renderObject, renderList, renderHelp, field, type FieldDef } from "../toon.js";
import { sumEffective } from "../format.js";
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
  count.

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
  let reachable = true;

  try {
    const [entriesRes, invRes, qRes] = await Promise.all([
      api.get("/api/kitchen/entries", { since: startOfTodayIso() }),
      api.get("/api/kitchen/inventory", { limit: eatFirstN }),
      api.get("/api/kitchen/inventory/questions", { limit: 1 }),
    ]);
    entries = Array.isArray(entriesRes?.entries) ? entriesRes.entries : [];
    items = Array.isArray(invRes?.items) ? invRes.items : [];
    questionCount = typeof qRes?.count === "number" ? qRes.count : 0;
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

  const today = renderObject({
    server,
    date: startOfTodayIso().slice(0, 10),
    entries: entries.length,
    pending_estimates: pending,
    ...(failed ? { failed } : {}),
    kcal: totals.calories,
    protein_g: totals.protein_g,
    fat_g: totals.fat_g,
    sat_fat_g: totals.sat_fat_g,
    carbs_g: totals.carbs_g,
    sodium_mg: totals.sodium_mg,
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
