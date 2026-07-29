/**
 * Pages stores.
 *
 * `PagesStore` is an interface so routes are testable without Postgres (see
 * memory-store.ts). `PgPagesStore` is the production implementation over the
 * `pages` schema.
 *
 * Versioning contract: publishing a slug for the first time creates a page +
 * its first version. Republishing the same slug inserts a NEW version row
 * and repoints `current_version_id` — the prior version's HTML is retained,
 * never overwritten or deleted.
 */

import type postgres from 'postgres';
import type {
  ArchivedFilter,
  ListResponsesFilter,
  NewResponseInput,
  PageRecord,
  PageResponseRecord,
  PageSummaryRecord,
  PageVersionRecord,
  PublishInput,
  PublishResult,
} from './types.js';
import type { WorksheetDefinition } from './worksheet.js';

export interface PagesStore {
  /** Create a page + its first version, or add a new version to an existing slug. */
  publish(input: PublishInput): Promise<PublishResult>;

  getPage(slug: string): Promise<PageRecord | null>;

  /**
   * The page + its current version's HTML and worksheet definition (null when
   * the version was published as plain HTML), or null if the slug is unknown.
   */
  getCurrent(
    slug: string
  ): Promise<{ page: PageRecord; html: string; worksheet: WorksheetDefinition | null } | null>;

  /** Active (non-archived) pages, newest-first by last publish. */
  listActive(): Promise<PageRecord[]>;

  /**
   * Pages with their aggregate status counts (versions, total + unprocessed
   * responses), newest-activity-first. `archived` selects which pages appear
   * (default `exclude` = active only, preserving the historical index set).
   */
  listPages(filter?: { archived?: ArchivedFilter }): Promise<PageSummaryRecord[]>;

  /** Idempotent: archiving an already-archived page leaves it as-is. */
  archive(slug: string): Promise<PageRecord | null>;

  /** Append-only insert; returns the response + parent page, or null if the slug is unknown. */
  addResponse(
    slug: string,
    input: NewResponseInput
  ): Promise<{ page: PageRecord; response: PageResponseRecord } | null>;

  /**
   * Oldest-first (processing order), or null if the slug is unknown.
   * When `filter.latestOnly` is set, returns at most one response — the
   * newest — still wrapped in an array so callers share one shape.
   */
  listResponses(slug: string, filter: ListResponsesFilter): Promise<PageResponseRecord[] | null>;

  /** Marks one response processed; returns it, or null if slug/id don't match. */
  markProcessed(
    slug: string,
    responseId: number,
    processedBy: string
  ): Promise<PageResponseRecord | null>;
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

interface PageRow {
  id: number;
  slug: string;
  title: string;
  current_version_id: number | null;
  digest_optin: boolean;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow {
  id: number;
  page_id: number;
  html: string;
  worksheet: unknown;
  created_at: Date;
}

interface ResponseRow {
  id: number;
  page_id: number;
  payload: unknown;
  anchor: string | null;
  note: string | null;
  created_at: Date;
  processed_by: string | null;
  processed_at: Date | null;
}

function rowToPage(row: PageRow): PageRecord {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    currentVersionId: row.current_version_id,
    digestOptin: row.digest_optin,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A page row joined with its aggregate counts (COUNT(*) arrives as text/bigint). */
type PageSummaryRow = PageRow & {
  version_count: string | number;
  response_count: string | number;
  unprocessed_count: string | number;
};

function rowToSummary(row: PageSummaryRow): PageSummaryRecord {
  return {
    ...rowToPage(row),
    versionCount: Number(row.version_count),
    responseCount: Number(row.response_count),
    unprocessedCount: Number(row.unprocessed_count),
  };
}

function rowToVersion(row: VersionRow): PageVersionRecord {
  return {
    id: row.id,
    pageId: row.page_id,
    html: row.html,
    worksheet: parseJsonField<WorksheetDefinition>(row.worksheet as WorksheetDefinition | string | null),
    createdAt: row.created_at,
  };
}

function rowToResponse(row: ResponseRow): PageResponseRecord {
  return {
    id: row.id,
    pageId: row.page_id,
    payload: parseJsonField(row.payload as unknown as string | null),
    anchor: row.anchor,
    note: row.note,
    createdAt: row.created_at,
    processedBy: row.processed_by,
    processedAt: row.processed_at,
  };
}

export class PgPagesStore implements PagesStore {
  constructor(private sql: postgres.Sql) {}

  async publish(input: PublishInput): Promise<PublishResult> {
    return this.sql.begin(async (rawTx) => {
      // postgres.js's TransactionSql type is built via `Omit<Sql, ...>`, which
      // (a TS/Omit limitation) drops the tagged-template call signature from
      // the type even though it's present at runtime. Cast back to `Sql` so
      // `tx` can still be used as a template tag like the top-level `sql`.
      const tx = rawTx as unknown as postgres.Sql;
      const [existing] = await tx<PageRow[]>`
        SELECT * FROM pages.pages WHERE slug = ${input.slug} FOR UPDATE
      `;

      if (!existing) {
        const [pageRow] = await tx<PageRow[]>`
          INSERT INTO pages.pages (slug, title, digest_optin)
          VALUES (${input.slug}, ${input.title}, ${input.digestOptin ?? false})
          RETURNING *
        `;
        const [versionRow] = await tx<VersionRow[]>`
          INSERT INTO pages.versions (page_id, html, worksheet)
          VALUES (${pageRow!.id}, ${input.html}, ${input.worksheet ? JSON.stringify(input.worksheet) : null})
          RETURNING *
        `;
        const [updated] = await tx<PageRow[]>`
          UPDATE pages.pages SET current_version_id = ${versionRow!.id}
          WHERE id = ${pageRow!.id}
          RETURNING *
        `;
        return { page: rowToPage(updated!), version: rowToVersion(versionRow!), created: true };
      }

      const [versionRow] = await tx<VersionRow[]>`
        INSERT INTO pages.versions (page_id, html, worksheet)
        VALUES (${existing.id}, ${input.html}, ${input.worksheet ? JSON.stringify(input.worksheet) : null})
        RETURNING *
      `;
      const [updated] = await tx<PageRow[]>`
        UPDATE pages.pages SET
          title = ${input.title},
          current_version_id = ${versionRow!.id},
          digest_optin = ${input.digestOptin ?? existing.digest_optin},
          archived_at = NULL,
          updated_at = NOW()
        WHERE id = ${existing.id}
        RETURNING *
      `;
      return { page: rowToPage(updated!), version: rowToVersion(versionRow!), created: false };
    });
  }

  async getPage(slug: string): Promise<PageRecord | null> {
    const [row] = await this.sql<PageRow[]>`
      SELECT * FROM pages.pages WHERE slug = ${slug}
    `;
    return row ? rowToPage(row) : null;
  }

  async getCurrent(
    slug: string
  ): Promise<{ page: PageRecord; html: string; worksheet: WorksheetDefinition | null } | null> {
    const [row] = await this.sql<(PageRow & { html: string | null; worksheet: unknown })[]>`
      SELECT p.*, v.html, v.worksheet
      FROM pages.pages p
      LEFT JOIN pages.versions v ON v.id = p.current_version_id
      WHERE p.slug = ${slug}
    `;
    if (!row || row.html === null) return null;
    return {
      page: rowToPage(row),
      html: row.html,
      worksheet: parseJsonField<WorksheetDefinition>(row.worksheet as WorksheetDefinition | string | null),
    };
  }

  async listActive(): Promise<PageRecord[]> {
    const rows = await this.sql<PageRow[]>`
      SELECT * FROM pages.pages
      WHERE archived_at IS NULL
      ORDER BY updated_at DESC
    `;
    return rows.map(rowToPage);
  }

  async listPages(filter: { archived?: ArchivedFilter } = {}): Promise<PageSummaryRecord[]> {
    const archived = filter.archived ?? 'exclude';
    const where =
      archived === 'exclude'
        ? this.sql`WHERE p.archived_at IS NULL`
        : archived === 'only'
          ? this.sql`WHERE p.archived_at IS NOT NULL`
          : this.sql``;
    const rows = await this.sql<PageSummaryRow[]>`
      SELECT
        p.*,
        (SELECT COUNT(*) FROM pages.versions v WHERE v.page_id = p.id) AS version_count,
        (SELECT COUNT(*) FROM pages.responses r WHERE r.page_id = p.id) AS response_count,
        (SELECT COUNT(*) FROM pages.responses r
          WHERE r.page_id = p.id AND r.processed_at IS NULL) AS unprocessed_count
      FROM pages.pages p
      ${where}
      ORDER BY p.updated_at DESC
    `;
    return rows.map(rowToSummary);
  }

  async archive(slug: string): Promise<PageRecord | null> {
    const [row] = await this.sql<PageRow[]>`
      UPDATE pages.pages
      SET archived_at = COALESCE(archived_at, NOW())
      WHERE slug = ${slug}
      RETURNING *
    `;
    return row ? rowToPage(row) : null;
  }

  async addResponse(
    slug: string,
    input: NewResponseInput
  ): Promise<{ page: PageRecord; response: PageResponseRecord } | null> {
    const page = await this.getPage(slug);
    if (!page) return null;

    const [row] = await this.sql<ResponseRow[]>`
      INSERT INTO pages.responses (page_id, payload, anchor, note)
      VALUES (
        ${page.id},
        ${JSON.stringify(input.payload)},
        ${input.anchor ?? null},
        ${input.note ?? null}
      )
      RETURNING *
    `;
    return { page, response: rowToResponse(row!) };
  }

  async listResponses(
    slug: string,
    filter: ListResponsesFilter
  ): Promise<PageResponseRecord[] | null> {
    const page = await this.getPage(slug);
    if (!page) return null;

    if (filter.latestOnly) {
      const rows = await this.sql<ResponseRow[]>`
        SELECT * FROM pages.responses
        WHERE page_id = ${page.id}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      return rows.map(rowToResponse);
    }

    const rows = await this.sql<ResponseRow[]>`
      SELECT * FROM pages.responses
      WHERE page_id = ${page.id}
        ${filter.since ? this.sql`AND created_at > ${filter.since}` : this.sql``}
        ${filter.unprocessedOnly ? this.sql`AND processed_at IS NULL` : this.sql``}
      ORDER BY created_at ASC
    `;
    return rows.map(rowToResponse);
  }

  async markProcessed(
    slug: string,
    responseId: number,
    processedBy: string
  ): Promise<PageResponseRecord | null> {
    const page = await this.getPage(slug);
    if (!page) return null;

    const [row] = await this.sql<ResponseRow[]>`
      UPDATE pages.responses
      SET processed_by = ${processedBy}, processed_at = NOW()
      WHERE id = ${responseId} AND page_id = ${page.id}
      RETURNING *
    `;
    return row ? rowToResponse(row) : null;
  }
}
