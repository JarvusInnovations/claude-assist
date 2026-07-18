/**
 * In-memory CaptureStore/ReferenceStore implementations.
 *
 * Used by the test suite (idempotency + routing state machine) and handy
 * for local spikes. Mirrors PgCaptureStore semantics exactly: first write
 * wins, failures bump attempts without changing status.
 */

import type {
  CaptureRecord,
  CaptureStatus,
  Classification,
  ReferenceRecord,
} from './types.js';
import type { CaptureStore, NewCapture, ReferenceStore } from './store.js';

export class MemoryCaptureStore implements CaptureStore {
  readonly records = new Map<string, CaptureRecord>();

  async insertIfAbsent(capture: NewCapture): Promise<{ record: CaptureRecord; created: boolean }> {
    const existing = this.records.get(capture.ulid);
    if (existing) {
      return { record: structuredClone(existing), created: false };
    }
    const record: CaptureRecord = {
      ...capture,
      received_at: new Date(),
      status: 'queued',
      classification: null,
      classified_at: null,
      classify_attempts: 0,
      route_destination: null,
      route_attempts: 0,
      routed_at: null,
      route_result: null,
      last_error: null,
      last_error_at: null,
      resolution: null,
      resolved_at: null,
    };
    this.records.set(capture.ulid, record);
    return { record: structuredClone(record), created: true };
  }

  async get(ulid: string): Promise<CaptureRecord | null> {
    const record = this.records.get(ulid);
    return record ? structuredClone(record) : null;
  }

  async list(filter: {
    status?: CaptureStatus;
    limit?: number;
    offset?: number;
  }): Promise<CaptureRecord[]> {
    const limit = Math.min(filter.limit ?? 50, 500);
    const offset = filter.offset ?? 0;
    return [...this.records.values()]
      .filter((r) => !filter.status || r.status === filter.status)
      .sort((a, b) => b.captured_at.getTime() - a.captured_at.getTime())
      .slice(offset, offset + limit)
      .map((r) => structuredClone(r));
  }

  async selectForClassification(limit: number, maxAttempts: number): Promise<CaptureRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.status === 'queued' && r.classify_attempts < maxAttempts)
      .sort((a, b) => a.captured_at.getTime() - b.captured_at.getTime())
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async selectForRouting(limit: number, maxAttempts: number): Promise<CaptureRecord[]> {
    return [...this.records.values()]
      .filter(
        (r) =>
          (r.status === 'classified' || r.status === 'awaiting_executor') &&
          r.route_attempts < maxAttempts
      )
      .sort((a, b) => a.captured_at.getTime() - b.captured_at.getTime())
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  private mustGet(ulid: string): CaptureRecord {
    const record = this.records.get(ulid);
    if (!record) throw new Error(`Capture not found: ${ulid}`);
    return record;
  }

  async applyClassification(
    ulid: string,
    classification: Classification,
    destination: string,
    nextStatus: CaptureStatus
  ): Promise<void> {
    const record = this.mustGet(ulid);
    record.classification = classification;
    record.classified_at = new Date();
    record.classify_attempts = 0;
    record.route_destination = destination;
    record.status = nextStatus;
    record.last_error = null;
    record.last_error_at = null;
  }

  async recordClassificationFailure(ulid: string, error: string): Promise<number> {
    const record = this.mustGet(ulid);
    record.classify_attempts += 1;
    record.last_error = error;
    record.last_error_at = new Date();
    return record.classify_attempts;
  }

  async applyRouting(
    ulid: string,
    nextStatus: CaptureStatus,
    result: Record<string, unknown> | null
  ): Promise<void> {
    const record = this.mustGet(ulid);
    record.status = nextStatus;
    if (nextStatus === 'routed') record.routed_at = new Date();
    record.route_result = result;
    record.last_error = null;
    record.last_error_at = null;
  }

  async recordRoutingFailure(ulid: string, error: string): Promise<number> {
    const record = this.mustGet(ulid);
    record.route_attempts += 1;
    record.last_error = error;
    record.last_error_at = new Date();
    return record.route_attempts;
  }

  async applyCorrection(
    ulid: string,
    classification: Classification,
    destination: string,
    nextStatus: CaptureStatus
  ): Promise<void> {
    const record = this.mustGet(ulid);
    record.classification = classification;
    record.classified_at = new Date();
    record.route_destination = destination;
    record.status = nextStatus;
    record.route_attempts = 0;
    record.routed_at = null;
    record.route_result = null;
    record.last_error = null;
    record.last_error_at = null;
  }

  async applyResolution(
    ulid: string,
    resolution: string | null,
    nextStatus: CaptureStatus
  ): Promise<void> {
    const record = this.mustGet(ulid);
    record.status = nextStatus;
    record.resolution = resolution;
    record.resolved_at = new Date();
  }
}

export class MemoryReferenceStore implements ReferenceStore {
  readonly records = new Map<string, ReferenceRecord>();

  async upsert(ref: Omit<ReferenceRecord, 'final_url'> & { final_url?: string | null }): Promise<void> {
    this.records.set(ref.capture_ulid, { ...ref, final_url: ref.final_url ?? null });
  }

  async list(filter: { limit?: number; offset?: number }): Promise<ReferenceRecord[]> {
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    return [...this.records.values()]
      .sort((a, b) => b.captured_at.getTime() - a.captured_at.getTime())
      .slice(offset, offset + limit);
  }
}
