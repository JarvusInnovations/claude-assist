/**
 * Pages module domain types.
 *
 * A `slug` is the stable public identity of a page (`/pages/<slug>`).
 * `PageRecord` always reflects the CURRENT version; prior HTML is retained
 * in `versions` but not surfaced through these types.
 */

export interface PageRecord {
  id: number;
  slug: string;
  title: string;
  currentVersionId: number | null;
  digestOptin: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PageVersionRecord {
  id: number;
  pageId: number;
  html: string;
  createdAt: Date;
}

export interface PageResponseRecord {
  id: number;
  pageId: number;
  payload: unknown;
  anchor: string | null;
  note: string | null;
  createdAt: Date;
  processedBy: string | null;
  processedAt: Date | null;
}

/** Result of a publish call — distinguishes a brand-new slug from a republish. */
export interface PublishResult {
  page: PageRecord;
  version: PageVersionRecord;
  created: boolean;
}

export interface PublishInput {
  slug: string;
  title: string;
  html: string;
  /** Only applied on create, or when explicitly passed on a republish. */
  digestOptin?: boolean;
}

export interface NewResponseInput {
  payload: unknown;
  anchor?: string | null;
  note?: string | null;
}

export interface ListResponsesFilter {
  since?: Date;
  unprocessedOnly?: boolean;
}

/** Slugs: lowercase kebab-case, matching the rest of the toolkit's URL-safe ids. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
