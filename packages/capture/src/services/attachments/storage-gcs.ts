/**
 * Google Cloud Storage AttachmentStorage implementation.
 *
 * The only place in the module that knows the object store is GCS. Everything
 * else depends on the generic AttachmentStorage interface. Credentials come
 * from Application Default Credentials (ADC) — i.e. GOOGLE_APPLICATION_CREDENTIALS
 * or the ambient service-account/metadata identity — resolved by the client
 * library; the module never handles a key directly. The bucket name is the
 * only wiring this class needs.
 *
 * Uploads and reads both use V4 signed URLs so the service never proxies
 * bytes: the client PUTs to / GETs from the bucket directly with a short-lived,
 * scoped signature.
 */

import { Storage, type Bucket } from '@google-cloud/storage';
import type { AttachmentStorage, SignUploadParams } from './storage.js';
import { SIGNED_URL_TTL_MS } from './storage.js';

export interface GcsAttachmentStorageOptions {
  /** Bucket that holds capture attachments (CAPTURE_ATTACHMENTS_BUCKET). */
  bucket: string;
  /** Signed-URL lifetime in ms (default SIGNED_URL_TTL_MS). */
  ttlMs?: number;
  /** Injectable Storage client (tests); defaults to ADC-resolved client. */
  storage?: Storage;
}

export class GcsAttachmentStorage implements AttachmentStorage {
  private readonly bucket: Bucket;
  private readonly ttlMs: number;

  constructor(options: GcsAttachmentStorageOptions) {
    const storage = options.storage ?? new Storage();
    this.bucket = storage.bucket(options.bucket);
    this.ttlMs = options.ttlMs ?? SIGNED_URL_TTL_MS;
  }

  async signUpload(params: SignUploadParams): Promise<string> {
    const [url] = await this.bucket.file(params.object_key).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + this.ttlMs,
      // Constrain the signature: the client must PUT exactly this content-type
      // and this many bytes, or the request is rejected by the bucket.
      contentType: params.content_type,
      extensionHeaders: {
        'content-length': String(params.bytes),
      },
    });
    return url;
  }

  async signRead(objectKey: string): Promise<string> {
    const [url] = await this.bucket.file(objectKey).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + this.ttlMs,
    });
    return url;
  }

  async objectExists(objectKey: string): Promise<boolean> {
    const [exists] = await this.bucket.file(objectKey).exists();
    return exists;
  }
}
