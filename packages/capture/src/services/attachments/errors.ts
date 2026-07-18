/**
 * Attachment ingest errors.
 *
 * Ingest stays dumb-and-fast, but attachments are the one thing it must
 * verify synchronously: a capture that references objects which don't exist
 * in the bucket would be permanently broken downstream. These typed errors
 * let the route map failures to clear HTTP status codes, mirroring the
 * module's existing "fail clearly, preserve state" posture.
 */

/** Raised when attachments are supplied but no object store is configured. */
export class AttachmentStorageUnconfiguredError extends Error {
  readonly statusCode = 503;
  constructor(message = 'Attachment storage is not configured') {
    super(message);
    this.name = 'AttachmentStorageUnconfiguredError';
  }
}

/**
 * Raised when a referenced object key doesn't belong to the capture's ULID
 * (captures/<ulid>/…). Prevents one capture from referencing another's
 * objects; a client bug, so 400.
 */
export class AttachmentKeyMismatchError extends Error {
  readonly statusCode = 400;
  readonly badKeys: string[];
  constructor(ulid: string, badKeys: string[]) {
    super(
      `Attachment object key(s) do not belong to capture ${ulid}: ${badKeys.join(', ')}. ` +
        'Object keys must be issued by the sign endpoint for this ULID.'
    );
    this.name = 'AttachmentKeyMismatchError';
    this.badKeys = badKeys;
  }
}

/** Raised when a referenced attachment object is missing from the bucket. */
export class AttachmentVerificationError extends Error {
  readonly statusCode = 422;
  /** The object keys that could not be verified. */
  readonly missingKeys: string[];
  constructor(missingKeys: string[]) {
    super(
      `Attachment object(s) not found in bucket: ${missingKeys.join(', ')}. ` +
        'Upload each object via the signed URL before capturing.'
    );
    this.name = 'AttachmentVerificationError';
    this.missingKeys = missingKeys;
  }
}
