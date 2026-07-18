/**
 * In-memory AttachmentStorage fake.
 *
 * Lets the full test suite exercise the attachment paths (sign, verify,
 * signed-read exposure, Tana link append) without a real object store or any
 * cloud credentials. Semantics mirror the real store closely enough for the
 * module's contract:
 *
 * - `signUpload` returns a fake URL and records the *intent* but does NOT
 *   create the object — a real client PUT is a separate step. Tests simulate
 *   that step with `put()`.
 * - `objectExists` reflects only objects marked present via `put()`.
 * - `signRead` returns a deterministic fake URL for an existing object.
 */

import type { AttachmentStorage, SignUploadParams } from './storage.js';

export class MemoryAttachmentStorage implements AttachmentStorage {
  /** object_key -> declared upload metadata (existence = "uploaded") */
  readonly objects = new Map<string, { content_type: string; bytes: number }>();
  /** object_key -> params from the last signUpload (inspectable in tests) */
  readonly signedUploads = new Map<string, SignUploadParams>();

  async signUpload(params: SignUploadParams): Promise<string> {
    this.signedUploads.set(params.object_key, params);
    const q = new URLSearchParams({
      contentType: params.content_type,
      contentLength: String(params.bytes),
    });
    return `memory://upload/${params.object_key}?${q.toString()}`;
  }

  async signRead(objectKey: string): Promise<string> {
    return `memory://read/${objectKey}`;
  }

  async objectExists(objectKey: string): Promise<boolean> {
    return this.objects.has(objectKey);
  }

  /** Test helper: mark an object as successfully uploaded to the bucket. */
  put(objectKey: string, meta: { content_type?: string; bytes?: number } = {}): void {
    this.objects.set(objectKey, {
      content_type: meta.content_type ?? 'application/octet-stream',
      bytes: meta.bytes ?? 0,
    });
  }
}
