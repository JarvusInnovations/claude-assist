/**
 * Attachment object-store abstraction.
 *
 * Captures may carry file/photo attachments. The bytes live in an
 * object-store bucket; the capture row only references them (object key +
 * metadata). This interface is the seam between the capture module and the
 * concrete store so the whole pipeline is testable without a real bucket:
 *
 * - `GcsAttachmentStorage` (storage-gcs.ts) is the production implementation
 *   over @google-cloud/storage using V4 signed URLs.
 * - `MemoryAttachmentStorage` (storage-memory.ts) is the in-memory fake the
 *   test suite runs against — no cloud credentials required.
 *
 * The feature is OPTIONAL: when no bucket is configured the module runs with
 * a null storage and every attachment path degrades cleanly (sign endpoint
 * 503s, attachment-bearing ingests are rejected).
 */

export type { CaptureAttachment } from '../../types.js';

/** Parameters for a signed upload URL request. */
export interface SignUploadParams {
  /** Fully-formed object key the client will PUT to. */
  object_key: string;
  /** MIME type the upload must carry (constrains the signature). */
  content_type: string;
  /** Exact byte length the upload must carry (constrains the signature). */
  bytes: number;
}

/**
 * Object-store operations the capture module needs. Deliberately tiny: sign
 * an upload, sign a read, check existence. No listing, no delete, no
 * interpretation of contents (attachments are stored and referenced, never
 * processed).
 */
export interface AttachmentStorage {
  /**
   * Issue a short-lived signed URL the client PUTs the bytes to directly.
   * The signature is constrained to the given content-type and content-length
   * so a leaked URL cannot be used to upload arbitrary/larger objects.
   */
  signUpload(params: SignUploadParams): Promise<string>;

  /** Issue a short-lived signed URL to GET (download) an existing object. */
  signRead(objectKey: string): Promise<string>;

  /** True if the object currently exists in the bucket (verified at ingest). */
  objectExists(objectKey: string): Promise<boolean>;
}

/** Default lifetime of signed URLs (upload + read). */
export const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

/** Object-key prefix for every capture attachment. */
export const ATTACHMENT_KEY_PREFIX = 'captures';

/**
 * Strip a client filename down to a safe basename for use in an object key:
 * no path separators, no leading dots, collapse anything unusual. Keeps the
 * key readable while preventing traversal or prefix injection.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'file';
}

/**
 * Build the ULID-keyed object key for attachment `index` of `ulid`.
 * Keys are stable for a given (ulid, index, filename) so replays overwrite
 * the same object rather than piling up duplicates.
 */
export function buildObjectKey(ulid: string, index: number, filename: string): string {
  return `${ATTACHMENT_KEY_PREFIX}/${ulid}/${index}-${sanitizeFilename(filename)}`;
}

/** The prefix every object key for `ulid` must start with. */
export function objectKeyPrefix(ulid: string): string {
  return `${ATTACHMENT_KEY_PREFIX}/${ulid}/`;
}
