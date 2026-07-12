/**
 * Per-occurrence prep store — the durable state of the meeting-briefing cycle.
 *
 * Keyed by occurrence_key (the reschedule-stable calendar instance id). A
 * Postgres store for the service; an in-memory store for tests and fakes.
 */

import type postgres from 'postgres';
import type { MeetingPrep, MeetingPrepStatus } from './types.js';

/** Fields a compose/refresh step writes back for an occurrence. */
export interface PrepUpsert {
  occurrenceKey: string;
  seriesKey: string;
  occurrenceStart: string | null;
  summary: string | null;
  status: MeetingPrepStatus;
  prepContent: string | null;
  inputsDigest: string | null;
  model: string | null;
  deliveredNodeId?: string | null;
}

export interface MeetingPrepStore {
  get(occurrenceKey: string): Promise<MeetingPrep | null>;
  /** Insert or update by occurrence_key. Sets generated/refreshed/delivered timestamps from status. */
  upsert(input: PrepUpsert): Promise<MeetingPrep>;
  /** Record a successful Tana render: node id + delivered/refreshed status + timestamp. */
  markDelivered(occurrenceKey: string, nodeId: string, status: MeetingPrepStatus): Promise<void>;
  /** Preps whose occurrence starts within [fromMs, toMs] — drives the refresh pass. */
  listUpcoming(fromMs: number, toMs: number): Promise<MeetingPrep[]>;
}

interface PrepRow {
  occurrence_key: string;
  series_key: string;
  occurrence_start: Date | string | null;
  summary: string | null;
  status: MeetingPrepStatus;
  prep_content: string | null;
  inputs_digest: string | null;
  model: string | null;
  delivered_node_id: string | null;
  generated_at: Date | string | null;
  refreshed_at: Date | string | null;
  delivered_at: Date | string | null;
}

function iso(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : v;
}

function rowToPrep(row: PrepRow): MeetingPrep {
  return {
    occurrenceKey: row.occurrence_key,
    seriesKey: row.series_key,
    occurrenceStart: iso(row.occurrence_start),
    summary: row.summary,
    status: row.status,
    prepContent: row.prep_content,
    inputsDigest: row.inputs_digest,
    model: row.model,
    deliveredNodeId: row.delivered_node_id,
    generatedAt: iso(row.generated_at),
    refreshedAt: iso(row.refreshed_at),
    deliveredAt: iso(row.delivered_at),
  };
}

export class PgMeetingPrepStore implements MeetingPrepStore {
  constructor(private sql: postgres.Sql) {}

  async get(occurrenceKey: string): Promise<MeetingPrep | null> {
    const rows = await this.sql<PrepRow[]>`
      SELECT * FROM briefing.meeting_preps WHERE occurrence_key = ${occurrenceKey}
    `;
    return rows[0] ? rowToPrep(rows[0]) : null;
  }

  async upsert(input: PrepUpsert): Promise<MeetingPrep> {
    const start = input.occurrenceStart ? new Date(input.occurrenceStart) : null;
    // generated_at is set once (first compose); refreshed_at on a refresh.
    const refreshed = input.status === 'refreshed';
    const rows = await this.sql<PrepRow[]>`
      INSERT INTO briefing.meeting_preps
        (occurrence_key, series_key, occurrence_start, summary, status,
         prep_content, inputs_digest, model, delivered_node_id, generated_at, refreshed_at)
      VALUES (
        ${input.occurrenceKey}, ${input.seriesKey}, ${start}, ${input.summary},
        ${input.status}, ${input.prepContent}, ${input.inputsDigest}, ${input.model},
        ${input.deliveredNodeId ?? null}, NOW(), ${refreshed ? this.sql`NOW()` : null}
      )
      ON CONFLICT (occurrence_key) DO UPDATE SET
        series_key = EXCLUDED.series_key,
        occurrence_start = EXCLUDED.occurrence_start,
        summary = EXCLUDED.summary,
        status = EXCLUDED.status,
        prep_content = EXCLUDED.prep_content,
        inputs_digest = EXCLUDED.inputs_digest,
        model = EXCLUDED.model,
        delivered_node_id = COALESCE(EXCLUDED.delivered_node_id, briefing.meeting_preps.delivered_node_id),
        refreshed_at = ${refreshed ? this.sql`NOW()` : this.sql`briefing.meeting_preps.refreshed_at`}
      RETURNING *
    `;
    return rowToPrep(rows[0]!);
  }

  async markDelivered(occurrenceKey: string, nodeId: string, status: MeetingPrepStatus): Promise<void> {
    await this.sql`
      UPDATE briefing.meeting_preps SET
        status = ${status},
        delivered_node_id = ${nodeId},
        delivered_at = NOW(),
        refreshed_at = ${status === 'refreshed' ? this.sql`NOW()` : this.sql`refreshed_at`}
      WHERE occurrence_key = ${occurrenceKey}
    `;
  }

  async listUpcoming(fromMs: number, toMs: number): Promise<MeetingPrep[]> {
    const rows = await this.sql<PrepRow[]>`
      SELECT * FROM briefing.meeting_preps
      WHERE occurrence_start >= ${new Date(fromMs)} AND occurrence_start <= ${new Date(toMs)}
      ORDER BY occurrence_start ASC
    `;
    return rows.map(rowToPrep);
  }
}

/** In-memory prep store for tests / fakes. */
export class MemoryMeetingPrepStore implements MeetingPrepStore {
  readonly map = new Map<string, MeetingPrep>();

  constructor(initial: MeetingPrep[] = []) {
    for (const p of initial) this.map.set(p.occurrenceKey, p);
  }

  async get(occurrenceKey: string): Promise<MeetingPrep | null> {
    return this.map.get(occurrenceKey) ?? null;
  }

  async upsert(input: PrepUpsert): Promise<MeetingPrep> {
    const prior = this.map.get(input.occurrenceKey);
    const now = new Date().toISOString();
    const prep: MeetingPrep = {
      occurrenceKey: input.occurrenceKey,
      seriesKey: input.seriesKey,
      occurrenceStart: input.occurrenceStart,
      summary: input.summary,
      status: input.status,
      prepContent: input.prepContent,
      inputsDigest: input.inputsDigest,
      model: input.model,
      deliveredNodeId: input.deliveredNodeId ?? prior?.deliveredNodeId ?? null,
      generatedAt: prior?.generatedAt ?? now,
      refreshedAt: input.status === 'refreshed' ? now : (prior?.refreshedAt ?? null),
      deliveredAt: prior?.deliveredAt ?? null,
    };
    this.map.set(input.occurrenceKey, prep);
    return prep;
  }

  async markDelivered(occurrenceKey: string, nodeId: string, status: MeetingPrepStatus): Promise<void> {
    const prior = this.map.get(occurrenceKey);
    if (!prior) return;
    const now = new Date().toISOString();
    this.map.set(occurrenceKey, {
      ...prior,
      status,
      deliveredNodeId: nodeId,
      deliveredAt: now,
      refreshedAt: status === 'refreshed' ? now : prior.refreshedAt,
    });
  }

  async listUpcoming(fromMs: number, toMs: number): Promise<MeetingPrep[]> {
    return [...this.map.values()]
      .filter((p) => {
        if (!p.occurrenceStart) return false;
        const ms = Date.parse(p.occurrenceStart);
        return !Number.isNaN(ms) && ms >= fromMs && ms <= toMs;
      })
      .sort((a, b) => Date.parse(a.occurrenceStart!) - Date.parse(b.occurrenceStart!));
  }
}
