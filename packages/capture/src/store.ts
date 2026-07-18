/**
 * Capture stores.
 *
 * `CaptureStore`/`ReferenceStore` are interfaces so the endpoint, router,
 * and pipeline are testable without Postgres (see memory-store.ts) and so
 * future entry types (diet) can reuse the same contracts. PgCaptureStore is
 * the production implementation over the `capture` schema.
 */

import type postgres from 'postgres';
import type {
  CaptureAttachment,
  CaptureInput,
  CaptureRecord,
  CaptureStatus,
  Classification,
  LinkMetadata,
  ReferenceRecord,
} from './types.js';

/** Normalized insert payload (validation already applied at the route) */
export interface NewCapture {
  ulid: string;
  source: CaptureRecord['source'];
  text: string;
  type_hint: string | null;
  urls: string[];
  tags: string[];
  payload: Record<string, unknown>;
  attachments: CaptureAttachment[];
  captured_at: Date;
}

export function normalizeInput(input: CaptureInput, now = new Date()): NewCapture {
  return {
    ulid: input.ulid,
    source: input.source,
    text: input.text,
    type_hint: input.type?.trim() ? input.type.trim() : null,
    urls: input.urls ?? [],
    tags: input.tags ?? [],
    payload: input.payload ?? {},
    attachments: input.attachments ?? [],
    captured_at: input.captured_at ? new Date(input.captured_at) : now,
  };
}

export interface CaptureStore {
  /**
   * Idempotent insert: first write wins. A replayed ULID returns the
   * existing record untouched (created: false) — a retry must never
   * clobber server-side classification/routing state.
   */
  insertIfAbsent(capture: NewCapture): Promise<{ record: CaptureRecord; created: boolean }>;

  get(ulid: string): Promise<CaptureRecord | null>;
  list(filter: {
    status?: CaptureStatus;
    limit?: number;
    offset?: number;
  }): Promise<CaptureRecord[]>;

  /** queued rows under the classify-attempt cap, oldest first */
  selectForClassification(limit: number, maxAttempts: number): Promise<CaptureRecord[]>;
  /** classified/awaiting_executor rows under the route-attempt cap, oldest first */
  selectForRouting(limit: number, maxAttempts: number): Promise<CaptureRecord[]>;

  applyClassification(
    ulid: string,
    classification: Classification,
    destination: string,
    nextStatus: CaptureStatus
  ): Promise<void>;
  recordClassificationFailure(ulid: string, error: string): Promise<number>;

  applyRouting(
    ulid: string,
    nextStatus: CaptureStatus,
    result: Record<string, unknown> | null
  ): Promise<void>;
  recordRoutingFailure(ulid: string, error: string): Promise<number>;

  /** Override type/destination and reset routing so the row re-routes */
  applyCorrection(
    ulid: string,
    classification: Classification,
    destination: string,
    nextStatus: CaptureStatus
  ): Promise<void>;

  /** Terminal close-out for a held capture, with an optional note */
  applyResolution(ulid: string, resolution: string | null, nextStatus: CaptureStatus): Promise<void>;
}

export interface ReferenceStore {
  upsert(reference: Omit<ReferenceRecord, 'final_url'> & { final_url?: string | null }): Promise<void>;
  /** Recent stored references, most recently captured first (review surface). */
  list(filter: { limit?: number; offset?: number }): Promise<ReferenceRecord[]>;
}

/** Parse a JSONB field that may come back as a string from postgres.js */
function parseJsonField<T>(value: T | string | null): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

function rowToRecord(row: Record<string, unknown>): CaptureRecord {
  return {
    ...(row as unknown as CaptureRecord),
    classification: parseJsonField(row.classification as Classification | string | null),
    payload: parseJsonField(row.payload as Record<string, unknown> | string | null) ?? {},
    attachments:
      parseJsonField<CaptureAttachment[]>(
        row.attachments as CaptureAttachment[] | string | null
      ) ?? [],
    route_result: parseJsonField(row.route_result as Record<string, unknown> | string | null),
  };
}

export class PgCaptureStore implements CaptureStore {
  constructor(private sql: postgres.Sql) {}

  async insertIfAbsent(capture: NewCapture): Promise<{ record: CaptureRecord; created: boolean }> {
    const inserted = await this.sql`
      INSERT INTO capture.captures
        (ulid, source, text, type_hint, urls, tags, payload, attachments, captured_at)
      VALUES (
        ${capture.ulid}, ${capture.source}, ${capture.text}, ${capture.type_hint},
        ${capture.urls}, ${capture.tags}, ${JSON.stringify(capture.payload)},
        ${JSON.stringify(capture.attachments)}, ${capture.captured_at}
      )
      ON CONFLICT (ulid) DO NOTHING
      RETURNING *
    `;

    if (inserted.length > 0) {
      return { record: rowToRecord(inserted[0]!), created: true };
    }

    const existing = await this.get(capture.ulid);
    if (!existing) {
      throw new Error(`Capture ${capture.ulid} conflicted on insert but is not readable`);
    }
    return { record: existing, created: false };
  }

  async get(ulid: string): Promise<CaptureRecord | null> {
    const [row] = await this.sql`
      SELECT * FROM capture.captures WHERE ulid = ${ulid}
    `;
    return row ? rowToRecord(row) : null;
  }

  async list(filter: {
    status?: CaptureStatus;
    limit?: number;
    offset?: number;
  }): Promise<CaptureRecord[]> {
    const limit = Math.min(filter.limit ?? 50, 500);
    const offset = filter.offset ?? 0;
    const rows = filter.status
      ? await this.sql`
          SELECT * FROM capture.captures WHERE status = ${filter.status}
          ORDER BY captured_at DESC LIMIT ${limit} OFFSET ${offset}
        `
      : await this.sql`
          SELECT * FROM capture.captures
          ORDER BY captured_at DESC LIMIT ${limit} OFFSET ${offset}
        `;
    return rows.map(rowToRecord);
  }

  async selectForClassification(limit: number, maxAttempts: number): Promise<CaptureRecord[]> {
    const rows = await this.sql`
      SELECT * FROM capture.captures
      WHERE status = 'queued' AND classify_attempts < ${maxAttempts}
      ORDER BY captured_at ASC
      LIMIT ${limit}
    `;
    return rows.map(rowToRecord);
  }

  async selectForRouting(limit: number, maxAttempts: number): Promise<CaptureRecord[]> {
    const rows = await this.sql`
      SELECT * FROM capture.captures
      WHERE status IN ('classified', 'awaiting_executor')
        AND route_attempts < ${maxAttempts}
      ORDER BY captured_at ASC
      LIMIT ${limit}
    `;
    return rows.map(rowToRecord);
  }

  async applyClassification(
    ulid: string,
    classification: Classification,
    destination: string,
    nextStatus: CaptureStatus
  ): Promise<void> {
    await this.sql`
      UPDATE capture.captures SET
        classification = ${JSON.stringify(classification)},
        classified_at = NOW(),
        classify_attempts = 0,
        route_destination = ${destination},
        status = ${nextStatus},
        last_error = NULL,
        last_error_at = NULL
      WHERE ulid = ${ulid}
    `;
  }

  async recordClassificationFailure(ulid: string, error: string): Promise<number> {
    const [row] = await this.sql<{ classify_attempts: number }[]>`
      UPDATE capture.captures SET
        classify_attempts = classify_attempts + 1,
        last_error = ${error},
        last_error_at = NOW()
      WHERE ulid = ${ulid}
      RETURNING classify_attempts
    `;
    return row?.classify_attempts ?? 0;
  }

  async applyRouting(
    ulid: string,
    nextStatus: CaptureStatus,
    result: Record<string, unknown> | null
  ): Promise<void> {
    await this.sql`
      UPDATE capture.captures SET
        status = ${nextStatus},
        routed_at = ${nextStatus === 'routed' ? this.sql`NOW()` : this.sql`routed_at`},
        route_result = ${result ? JSON.stringify(result) : null},
        last_error = NULL,
        last_error_at = NULL
      WHERE ulid = ${ulid}
    `;
  }

  async recordRoutingFailure(ulid: string, error: string): Promise<number> {
    const [row] = await this.sql<{ route_attempts: number }[]>`
      UPDATE capture.captures SET
        route_attempts = route_attempts + 1,
        last_error = ${error},
        last_error_at = NOW()
      WHERE ulid = ${ulid}
      RETURNING route_attempts
    `;
    return row?.route_attempts ?? 0;
  }

  async applyCorrection(
    ulid: string,
    classification: Classification,
    destination: string,
    nextStatus: CaptureStatus
  ): Promise<void> {
    await this.sql`
      UPDATE capture.captures SET
        classification = ${JSON.stringify(classification)},
        classified_at = NOW(),
        route_destination = ${destination},
        status = ${nextStatus},
        route_attempts = 0,
        routed_at = NULL,
        route_result = NULL,
        last_error = NULL,
        last_error_at = NULL
      WHERE ulid = ${ulid}
    `;
  }

  async applyResolution(
    ulid: string,
    resolution: string | null,
    nextStatus: CaptureStatus
  ): Promise<void> {
    await this.sql`
      UPDATE capture.captures SET
        status = ${nextStatus},
        resolution = ${resolution},
        resolved_at = NOW()
      WHERE ulid = ${ulid}
    `;
  }
}

export class PgReferenceStore implements ReferenceStore {
  constructor(private sql: postgres.Sql) {}

  async upsert(ref: Omit<ReferenceRecord, 'final_url'> & { final_url?: string | null }): Promise<void> {
    await this.sql`
      INSERT INTO capture.references
        (capture_ulid, url, final_url, title, description, site_name,
         notes, tags, source, captured_at, extra_urls, fetch_error)
      VALUES (
        ${ref.capture_ulid}, ${ref.url}, ${ref.final_url ?? null},
        ${ref.title}, ${ref.description}, ${ref.site_name},
        ${ref.notes}, ${ref.tags}, ${ref.source}, ${ref.captured_at},
        ${JSON.stringify(ref.extra_urls satisfies LinkMetadata[])}, ${ref.fetch_error}
      )
      ON CONFLICT (capture_ulid) DO UPDATE SET
        url = EXCLUDED.url,
        final_url = EXCLUDED.final_url,
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        site_name = EXCLUDED.site_name,
        notes = EXCLUDED.notes,
        tags = EXCLUDED.tags,
        extra_urls = EXCLUDED.extra_urls,
        fetch_error = EXCLUDED.fetch_error
    `;
  }

  async list(filter: { limit?: number; offset?: number }): Promise<ReferenceRecord[]> {
    const limit = Math.min(filter.limit ?? 50, 500);
    const offset = filter.offset ?? 0;
    const rows = await this.sql<ReferenceRecord[]>`
      SELECT * FROM capture.references
      ORDER BY captured_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map((row) => ({
      ...row,
      extra_urls: parseJsonField<LinkMetadata[]>(
        row.extra_urls as unknown as LinkMetadata[] | string | null
      ) ?? [],
    }));
  }
}
