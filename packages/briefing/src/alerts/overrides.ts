/**
 * Per-series override store — the correction path for the classifier.
 *
 * Keyed by the recurring-event base id so `suppress`/`force` (and any custom
 * lead time) survives every future instance. A Postgres-backed store for the
 * service; an in-memory store for tests and fakes.
 */

import type postgres from 'postgres';
import type { OverrideAction, SeriesOverride } from '../types.js';

export interface OverrideStore {
  get(seriesId: string): Promise<SeriesOverride | null>;
  /** Bulk fetch for a set of series ids (one query for a day's events). */
  getMany(seriesIds: string[]): Promise<Map<string, SeriesOverride>>;
  upsert(input: SeriesOverride): Promise<SeriesOverride>;
  remove(seriesId: string): Promise<boolean>;
  list(): Promise<SeriesOverride[]>;
}

interface OverrideRow {
  series_id: string;
  action: OverrideAction;
  lead_minutes: number | null;
  note: string | null;
}

function rowToOverride(row: OverrideRow): SeriesOverride {
  return {
    seriesId: row.series_id,
    action: row.action,
    leadMinutes: row.lead_minutes,
    note: row.note,
  };
}

export class PgOverrideStore implements OverrideStore {
  constructor(private sql: postgres.Sql) {}

  async get(seriesId: string): Promise<SeriesOverride | null> {
    const rows = await this.sql<OverrideRow[]>`
      SELECT series_id, action, lead_minutes, note
      FROM briefing.series_overrides
      WHERE series_id = ${seriesId}
    `;
    return rows[0] ? rowToOverride(rows[0]) : null;
  }

  async getMany(seriesIds: string[]): Promise<Map<string, SeriesOverride>> {
    const map = new Map<string, SeriesOverride>();
    if (seriesIds.length === 0) return map;
    const rows = await this.sql<OverrideRow[]>`
      SELECT series_id, action, lead_minutes, note
      FROM briefing.series_overrides
      WHERE series_id = ANY(${seriesIds as unknown as string[]})
    `;
    for (const row of rows) map.set(row.series_id, rowToOverride(row));
    return map;
  }

  async upsert(input: SeriesOverride): Promise<SeriesOverride> {
    const rows = await this.sql<OverrideRow[]>`
      INSERT INTO briefing.series_overrides (series_id, action, lead_minutes, note)
      VALUES (${input.seriesId}, ${input.action}, ${input.leadMinutes}, ${input.note})
      ON CONFLICT (series_id) DO UPDATE SET
        action = EXCLUDED.action,
        lead_minutes = EXCLUDED.lead_minutes,
        note = EXCLUDED.note
      RETURNING series_id, action, lead_minutes, note
    `;
    return rowToOverride(rows[0]!);
  }

  async remove(seriesId: string): Promise<boolean> {
    const rows = await this.sql<OverrideRow[]>`
      DELETE FROM briefing.series_overrides WHERE series_id = ${seriesId}
      RETURNING series_id, action, lead_minutes, note
    `;
    return rows.length > 0;
  }

  async list(): Promise<SeriesOverride[]> {
    const rows = await this.sql<OverrideRow[]>`
      SELECT series_id, action, lead_minutes, note
      FROM briefing.series_overrides
      ORDER BY updated_at DESC
    `;
    return rows.map(rowToOverride);
  }
}

/** In-memory override store for tests / fakes. */
export class MemoryOverrideStore implements OverrideStore {
  private map = new Map<string, SeriesOverride>();

  constructor(initial: SeriesOverride[] = []) {
    for (const o of initial) this.map.set(o.seriesId, o);
  }

  async get(seriesId: string): Promise<SeriesOverride | null> {
    return this.map.get(seriesId) ?? null;
  }

  async getMany(seriesIds: string[]): Promise<Map<string, SeriesOverride>> {
    const out = new Map<string, SeriesOverride>();
    for (const id of seriesIds) {
      const o = this.map.get(id);
      if (o) out.set(id, o);
    }
    return out;
  }

  async upsert(input: SeriesOverride): Promise<SeriesOverride> {
    this.map.set(input.seriesId, input);
    return input;
  }

  async remove(seriesId: string): Promise<boolean> {
    return this.map.delete(seriesId);
  }

  async list(): Promise<SeriesOverride[]> {
    return [...this.map.values()];
  }
}
