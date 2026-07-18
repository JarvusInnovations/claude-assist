/**
 * Kitchen daily-totals summary for the briefing, read from the kitchen
 * module's table (claude-assist Postgres) — calories, protein, and
 * saturated fat logged today. Follows the captures-source pattern
 * (sources/captures.ts): a direct read of the sibling module's schema, no
 * import of @jarvus/claude-assist-kitchen. Degrades to omission if the
 * kitchen schema is absent.
 */

import type postgres from 'postgres';
import { zonedDayWindow } from '../../time.js';

export interface KitchenSummary {
  calories: number;
  proteinG: number;
  satFatG: number;
  /** Entries logged today that are still awaiting an estimate (excluded from the totals above). */
  pendingCount: number;
  error: string | null;
}

export async function fetchKitchenSummary(
  sql: postgres.Sql,
  opts: { dateIso: string; timeZone: string }
): Promise<KitchenSummary> {
  try {
    const { fromIso, toIso } = zonedDayWindow(opts.dateIso, opts.timeZone);

    const [totals] = await sql<{ calories: string | null; protein_g: string | null; sat_fat_g: string | null }[]>`
      SELECT
        COALESCE(SUM(calories), 0) AS calories,
        COALESCE(SUM(protein_g), 0) AS protein_g,
        COALESCE(SUM(sat_fat_g), 0) AS sat_fat_g
      FROM kitchen.entries
      WHERE status = 'estimated' AND logged_at >= ${fromIso} AND logged_at < ${toIso}
    `;

    const [pending] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM kitchen.entries
      WHERE status = 'estimating' AND logged_at >= ${fromIso} AND logged_at < ${toIso}
    `;

    return {
      calories: Math.round(parseFloat(totals?.calories ?? '0')),
      proteinG: Math.round(parseFloat(totals?.protein_g ?? '0')),
      satFatG: Math.round(parseFloat(totals?.sat_fat_g ?? '0') * 10) / 10,
      pendingCount: pending?.count ?? 0,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      calories: 0,
      proteinG: 0,
      satFatG: 0,
      pendingCount: 0,
      error: `kitchen summary unavailable: ${message}`,
    };
  }
}
