/**
 * Capture pipeline: ingest (endpoint-side) + the async classify/route sweep
 * (scheduler-side).
 *
 * Ingest is dumb and fast: normalize, idempotent insert, ack. The sweep
 * does everything smart afterwards: URL metadata fetch, Haiku
 * classification, executor routing — each phase retried independently with
 * per-row attempt caps (mirrors the email triage pattern: a permanently
 * broken row stops being selected but stays inspectable/forcable).
 */

import pLimit from 'p-limit';
import type { FastifyBaseLogger } from 'fastify';
import type { CaptureInput, CaptureRecord, CaptureType, LinkMetadata } from '../types.js';
import type { CaptureStore } from '../store.js';
import { normalizeInput } from '../store.js';
import { destinationFor, transition } from '../state.js';
import type { CaptureClassifier } from './classifier.js';
import { collectUrls, deterministicClassification } from './classifier.js';
import { fetchAllLinkMetadata } from './link-metadata.js';
import type { CaptureRouter } from './router.js';

export interface PipelineConfig {
  /** Parallelism for classification (default 3) */
  concurrency?: number;
  /** Rows selected per sweep phase (default 50) */
  batchSize?: number;
  /** URL metadata fetcher override (tests; default fetchAllLinkMetadata) */
  fetchLinks?: (urls: string[]) => Promise<LinkMetadata[]>;
}

export interface SweepResult {
  classified: number;
  classifyFailed: number;
  routed: number;
  held: number;
  parked: number;
  routeFailed: number;
}

export class CapturePipeline {
  /**
   * Rows that fail classification/routing this many times stop being
   * selected by the sweep (state preserved; a correction or manual retry
   * can still revive them).
   */
  static readonly MAX_ATTEMPTS = 5;

  private limit: ReturnType<typeof pLimit>;
  private batchSize: number;
  private fetchLinks: (urls: string[]) => Promise<LinkMetadata[]>;
  private sweeping = false;

  constructor(
    private store: CaptureStore,
    private classifier: CaptureClassifier | null,
    private router: CaptureRouter,
    private log: FastifyBaseLogger,
    config: PipelineConfig = {}
  ) {
    this.limit = pLimit(config.concurrency ?? 3);
    this.batchSize = config.batchSize ?? 50;
    this.fetchLinks = config.fetchLinks ?? fetchAllLinkMetadata;
  }

  /** Endpoint-side: idempotent store-and-ack. Zero intelligence. */
  async ingest(input: CaptureInput): Promise<{ record: CaptureRecord; created: boolean }> {
    return this.store.insertIfAbsent(normalizeInput(input));
  }

  async get(ulid: string): Promise<CaptureRecord | null> {
    return this.store.get(ulid);
  }

  async list(filter: {
    status?: CaptureRecord['status'];
    limit?: number;
    offset?: number;
  }): Promise<CaptureRecord[]> {
    return this.store.list(filter);
  }

  /**
   * Apply a human routing correction: override the type, recompute the
   * destination, and re-enter routing. The correction is recorded in the
   * classification (classifier: 'correction', prior type in rationale) so
   * it can feed the classifier-tuning loop later.
   */
  async correct(ulid: string, type: CaptureType): Promise<CaptureRecord | null> {
    const capture = await this.store.get(ulid);
    if (!capture) return null;

    const nextStatus = transition(capture.status, {
      kind: 'corrected',
      destination: destinationFor(type),
    });

    await this.store.applyCorrection(
      ulid,
      {
        type,
        confidence: 1,
        title: capture.classification?.title ?? null,
        rationale: `Corrected by Chris (was: ${capture.classification?.type ?? 'unclassified'})`,
        classifier: 'correction',
        ...(capture.classification?.links ? { links: capture.classification.links } : {}),
      },
      destinationFor(type),
      nextStatus
    );

    // Route immediately — a correction is an explicit human action, no
    // reason to wait for the next sweep.
    const updated = await this.store.get(ulid);
    if (updated) await this.router.route(updated);
    return this.store.get(ulid);
  }

  /** Scheduler-side sweep: classify queued rows, then route routable rows. */
  async sweep(): Promise<SweepResult> {
    if (this.sweeping) {
      this.log.info('Capture sweep already in progress - skipping');
      return { classified: 0, classifyFailed: 0, routed: 0, held: 0, parked: 0, routeFailed: 0 };
    }
    this.sweeping = true;
    try {
      const result: SweepResult = {
        classified: 0,
        classifyFailed: 0,
        routed: 0,
        held: 0,
        parked: 0,
        routeFailed: 0,
      };

      // Phase 1: classification
      const queued = await this.store.selectForClassification(
        this.batchSize,
        CapturePipeline.MAX_ATTEMPTS
      );
      await Promise.all(
        queued.map((capture) =>
          this.limit(async () => {
            const ok = await this.classifyOne(capture);
            if (ok) result.classified++;
            else result.classifyFailed++;
          })
        )
      );

      // Phase 2: routing (includes rows classified above + prior failures
      // + awaiting_executor rows whose executor may have appeared)
      const routable = await this.store.selectForRouting(
        this.batchSize,
        CapturePipeline.MAX_ATTEMPTS
      );
      await Promise.all(
        routable.map((capture) =>
          this.limit(async () => {
            const before = capture.status;
            const after = await this.router.route(capture);
            if (after === 'routed') result.routed++;
            else if (after === 'awaiting_review') result.held++;
            else if (after === 'awaiting_executor' && before !== 'awaiting_executor')
              result.parked++;
            else if (after === before && before === 'classified') result.routeFailed++;
          })
        )
      );

      return result;
    } finally {
      this.sweeping = false;
    }
  }

  private async classifyOne(capture: CaptureRecord): Promise<boolean> {
    try {
      const urls = collectUrls(capture);
      const links = urls.length > 0 ? await this.fetchLinks(urls) : [];

      if (!this.classifier) {
        // No API key: the deterministic pre-pass still lets pure link
        // drops through; everything else waits, without burning attempts.
        const deterministic = deterministicClassification(capture);
        if (!deterministic) return false;
        const classification =
          links.length > 0 ? { ...deterministic, links } : deterministic;
        await this.store.applyClassification(
          capture.ulid,
          classification,
          destinationFor(classification.type),
          transition(capture.status, {
            kind: 'classified',
            destination: destinationFor(classification.type),
          })
        );
        return true;
      }

      const classification = await this.classifier.classify(capture, links);
      const destination = destinationFor(classification.type);
      await this.store.applyClassification(
        capture.ulid,
        classification,
        destination,
        transition(capture.status, { kind: 'classified', destination })
      );
      this.log.info(
        { ulid: capture.ulid, type: classification.type, destination },
        'Capture classified'
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = await this.store.recordClassificationFailure(capture.ulid, message);
      this.log.error(
        { ulid: capture.ulid, attempts, error: message },
        attempts >= CapturePipeline.MAX_ATTEMPTS
          ? 'Capture classification failed max attempts - sweep will stop retrying'
          : 'Capture classification failed'
      );
      return false;
    }
  }
}
