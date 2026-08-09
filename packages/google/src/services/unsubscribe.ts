/**
 * Tiered unsubscribe automation — store + execution.
 *
 * What this does, in one paragraph: senders the OWNER explicitly flagged on the
 * digest page (`google.sender_standing.standing = 'unsubscribe_queue'`) are
 * materialized into `google.unsubscribe_attempts`; a scheduled cycle claims
 * those attempts through the shared lease helper, re-checks the whitelist and
 * the flag, respects a per-sender-domain rate limit, works out which tier the
 * sender's unsubscribe offer falls into, and either fires an RFC 8058 one-click
 * POST (tier 1), drives the page in a browser and keeps a screenshot (tier 2),
 * or routes the case to the weekly review queue (tier 3). Every action that
 * actually leaves this host writes an audit-ledger row.
 *
 * Three properties are worth stating outright because they are what make
 * unattended execution defensible:
 *
 *   - **The queue has exactly one source.** Nothing in this file infers that a
 *     sender should be unsubscribed. `enqueueFromQueue` reads
 *     `sender_standing` and nothing else, and `processAttempt` re-reads the
 *     standing at execution time — so un-flagging a sender stops the automation
 *     even after a row was enqueued.
 *   - **The whitelist is a hard gate at every tier**, decided by `gateSender`
 *     in unsubscribe-detect.ts before any tier logic runs.
 *   - **No model is in the path.** Tiering reads headers; the browser tier acts
 *     only on an unambiguous page. Judgment goes to a human, not to a prompt.
 */

import type postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { gmail_v1 } from 'googleapis';
import { join } from 'node:path';
import {
  createLeaseQueue,
  type LeaseQueue,
  type Ledger,
  type NotifyDispatcher,
} from '@jarvus/claude-assist-core';
import type { GmailAuthService } from './gmail-auth.js';
import type { WhitelistService } from './whitelist.js';
import type { SenderStanding, SenderStandingStore } from './standing.js';
import {
  checkRateLimit,
  detectUnsubscribeMethod,
  gateSender,
  senderDomain,
  type DetectedMethod,
  type RateLimitConfig,
  type UnsubscribeHeaders,
} from './unsubscribe-detect.js';
import type { BrowserDriver } from './unsubscribe-browser.js';

export const UNSUBSCRIBE_HEADERS = ['List-Unsubscribe', 'List-Unsubscribe-Post'];

export type AttemptStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'needs_review'
  | 'skipped';

export interface UnsubscribeAttemptRow {
  id: number;
  sender_email: string;
  sender_domain: string;
  account_id: number | null;
  email_id: number | null;
  tier: number | null;
  method: string | null;
  target_url: string | null;
  proof_path: string | null;
  status: AttemptStatus;
  detail: Record<string, unknown> | string | null;
  attempts: number;
  created_at?: Date;
  completed_at?: Date | null;
}

export interface SenderMessage {
  id: number;
  account_id: number;
  message_id: string;
  analysis: { unsubscribe_link?: string | null } | string | null;
}

/** Terminal state written when an attempt finishes. */
export interface AttemptOutcome {
  status: Exclude<AttemptStatus, 'queued' | 'running'>;
  tier?: number | null;
  method?: string | null;
  targetUrl?: string | null;
  proofPath?: string | null;
  detail: Record<string, unknown>;
}

/** The persistence surface the service needs — faked wholesale in tests. */
export interface UnsubscribeStoreLike {
  enqueueFromQueue(limit: number): Promise<number>;
  loadAttempt(id: number): Promise<UnsubscribeAttemptRow | null>;
  standingFor(senderEmail: string): Promise<SenderStanding | null>;
  latestSenderMessage(senderEmail: string): Promise<SenderMessage | null>;
  recentDomainActions(domain: string, since: Date): Promise<Date[]>;
  finish(id: number, outcome: AttemptOutcome): Promise<void>;
  defer(id: number, until: Date, note: string): Promise<void>;
  listByStatus(status: AttemptStatus, limit?: number): Promise<UnsubscribeAttemptRow[]>;
}

/** Reads the RFC 2369/8058 headers off one message. */
export interface MessageHeaderSource {
  fetchHeaders(accountId: number, messageId: string): Promise<UnsubscribeHeaders>;
}

/** The tier-1 wire call. Injectable so tests never touch the network. */
export interface OneClickPoster {
  (url: string, timeoutMs: number): Promise<{ status: number; ok: boolean }>;
}

/** RFC 8058 §3.1: `POST` with exactly this body, no other parameters. */
export const oneClickPost: OneClickPoster = async (url, timeoutMs) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, ok: response.ok };
};

export interface UnsubscribeConfig {
  /** Master switch. Destructive automation is opt-in, never on by default. */
  enabled?: boolean;
  /** Tier 2 needs an external browser bridge; opt in separately. */
  browserEnabled?: boolean;
  /** Attempts claimed per cycle. */
  maxPerRun?: number;
  rateWindowMinutes?: number;
  rateMaxPerDomain?: number;
  /** Where tier-2 screenshots land. The ledger carries the path, not the bytes. */
  proofDir?: string;
  /** Per-request timeout for the one-click POST. */
  requestTimeoutMs?: number;
  teamDomains?: string[];
}

export interface UnsubscribeDeps {
  store: UnsubscribeStoreLike;
  standingStore: Pick<SenderStandingStore, 'whitelistedSenders'>;
  whitelistService: Pick<WhitelistService, 'deriveWhitelist'>;
  headerSource: MessageHeaderSource;
  browser?: BrowserDriver;
  post?: OneClickPoster;
  ledger?: Ledger;
  notify?: NotifyDispatcher;
  /** The shared lease helper over `google.unsubscribe_attempts`. */
  queue?: LeaseQueue;
  now?: () => Date;
}

/** What `processAttempt` tells the cycle to do with the lease. */
export type ProcessOutcome =
  | { kind: 'terminal'; status: AttemptOutcome['status'] }
  | { kind: 'deferred'; until: Date }
  | { kind: 'retry'; error: string };

export interface CycleResult {
  enqueued: number;
  claimed: number;
  succeeded: number;
  needsReview: number;
  skipped: number;
  deferred: number;
  failed: number;
}

export class UnsubscribeService {
  private readonly log: FastifyBaseLogger;
  private readonly deps: UnsubscribeDeps;
  private readonly config: Required<
    Pick<
      UnsubscribeConfig,
      'maxPerRun' | 'rateWindowMinutes' | 'rateMaxPerDomain' | 'proofDir' | 'requestTimeoutMs'
    >
  > & { enabled: boolean; browserEnabled: boolean; teamDomains: string[] };

  constructor(log: FastifyBaseLogger, deps: UnsubscribeDeps, config: UnsubscribeConfig = {}) {
    this.log = log;
    this.deps = deps;
    this.config = {
      enabled: config.enabled ?? false,
      browserEnabled: config.browserEnabled ?? false,
      maxPerRun: config.maxPerRun ?? 10,
      rateWindowMinutes: config.rateWindowMinutes ?? 60,
      rateMaxPerDomain: config.rateMaxPerDomain ?? 3,
      proofDir: config.proofDir ?? '/tmp/claude-assist-unsubscribe',
      requestTimeoutMs: config.requestTimeoutMs ?? 20_000,
      teamDomains: config.teamDomains ?? [],
    };
  }

  get rateLimit(): RateLimitConfig {
    return {
      windowMinutes: this.config.rateWindowMinutes,
      maxPerDomain: this.config.rateMaxPerDomain,
    };
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /**
   * Materialize attempts for every owner-flagged sender that does not already
   * have one. Pure delegation to the store — the SELECT there reads
   * `sender_standing` and nothing else, which is the whole point.
   */
  async enqueue(limit = 100): Promise<number> {
    return this.deps.store.enqueueFromQueue(limit);
  }

  /**
   * Work one claimed attempt end to end.
   *
   * Order is load-bearing: resolve the sender's latest message (that is what
   * names the account), build the whitelist, GATE, rate-limit, then and only
   * then detect a tier and act.
   */
  async processAttempt(attemptId: number): Promise<ProcessOutcome> {
    const { store } = this.deps;
    const row = await store.loadAttempt(attemptId);
    if (!row) {
      return { kind: 'terminal', status: 'skipped' };
    }
    const sender = row.sender_email.trim().toLowerCase();

    // The most recent message from this sender is both the account context and
    // the document the unsubscribe offer is read off.
    const message = await store.latestSenderMessage(sender);

    // The whitelist: explicit `whitelist` standings ∪ the derived reply-history
    // list for the account this sender lands in. Failure to derive is NOT an
    // open gate — a whitelist we could not compute is treated as a reason to
    // stop, because the alternative is unsubscribing from a correspondent.
    let whitelist: Set<string>;
    try {
      whitelist = await this.deps.standingStore.whitelistedSenders();
      if (message) {
        for (const addr of await this.deps.whitelistService.deriveWhitelist(message.account_id)) {
          whitelist.add(addr);
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log.error({ attemptId, error }, 'Unsubscribe: whitelist unavailable; refusing to act');
      await store.finish(attemptId, {
        status: 'needs_review',
        tier: 3,
        method: 'review',
        detail: { reason: 'whitelist-unavailable', detail },
      });
      return { kind: 'terminal', status: 'needs_review' };
    }

    const standing = await store.standingFor(sender);
    const gate = gateSender({
      senderEmail: sender,
      standing,
      whitelist,
      teamDomains: this.config.teamDomains,
    });
    if (!gate.allowed) {
      // A whitelisted sender the owner ALSO flagged is a contradiction between
      // two owner-driven signals; it goes to a human, not to the floor. A
      // sender that simply is not flagged (or was un-flagged) is skipped
      // outright — there is nothing for anyone to decide.
      const whitelisted = gate.reason !== 'not-queued';
      await store.finish(attemptId, {
        status: whitelisted ? 'needs_review' : 'skipped',
        tier: whitelisted ? 3 : null,
        method: whitelisted ? 'review' : null,
        detail: { reason: gate.reason, detail: gate.detail, blocked_by: 'gate' },
      });
      this.log.info(
        { attemptId, reason: gate.reason },
        'Unsubscribe: gate blocked the attempt'
      );
      return { kind: 'terminal', status: whitelisted ? 'needs_review' : 'skipped' };
    }

    // Per-sender-domain rate limit. A limited attempt is DEFERRED, not failed:
    // the flag still stands, we are only pacing the provider.
    const domain = row.sender_domain || senderDomain(sender);
    const now = this.now();
    const since = new Date(now.getTime() - this.config.rateWindowMinutes * 60_000);
    const recent = await store.recentDomainActions(domain, since);
    const rate = checkRateLimit(recent, this.rateLimit, now);
    if (!rate.allowed) {
      await store.defer(
        attemptId,
        rate.retryAfter,
        `rate limit: ${rate.recent} action(s) against ${domain} in the last ${this.config.rateWindowMinutes}m`
      );
      this.log.info({ attemptId, domain, recent: rate.recent }, 'Unsubscribe: rate limited');
      return { kind: 'deferred', until: rate.retryAfter };
    }

    if (!message) {
      await store.finish(attemptId, {
        status: 'needs_review',
        tier: 3,
        method: 'review',
        detail: { reason: 'no-message', detail: 'no synced message from this sender to read' },
      });
      return { kind: 'terminal', status: 'needs_review' };
    }

    // Headers are read live rather than stored: the sync pipeline keeps no raw
    // headers, and fetching on demand works over the whole existing corpus
    // without a backfill. A fetch failure falls back to the triage-extracted
    // footer link, which is exactly the tier-2 case anyway.
    let headers: UnsubscribeHeaders = {};
    try {
      headers = await this.deps.headerSource.fetchHeaders(message.account_id, message.message_id);
    } catch (error) {
      this.log.warn({ attemptId, error }, 'Unsubscribe: header fetch failed; using body link');
    }
    const analysis =
      typeof message.analysis === 'string'
        ? (safeJson(message.analysis) as { unsubscribe_link?: string | null } | null)
        : message.analysis;
    const detected = detectUnsubscribeMethod(headers, analysis?.unsubscribe_link ?? null);

    switch (detected.tier) {
      case 1:
        return this.runTierOne(row, message, detected, domain);
      case 2:
        return this.runTierTwo(row, message, detected, domain);
      default:
        await store.finish(attemptId, {
          status: 'needs_review',
          tier: 3,
          method: 'review',
          targetUrl: detected.url,
          detail: {
            reason: detected.reason,
            mailto: detected.mailto,
            email_id: message.id,
          },
        });
        this.log.info({ attemptId, reason: detected.reason }, 'Unsubscribe: routed to review');
        return { kind: 'terminal', status: 'needs_review' };
    }
  }

  /** Tier 1 — the sender's own machine-readable one-click endpoint. */
  private async runTierOne(
    row: UnsubscribeAttemptRow,
    message: SenderMessage,
    detected: DetectedMethod,
    domain: string
  ): Promise<ProcessOutcome> {
    const post = this.deps.post ?? oneClickPost;
    const url = detected.url!;
    let status = 0;
    let ok = false;
    let error: string | null = null;
    try {
      const result = await post(url, this.config.requestTimeoutMs);
      status = result.status;
      ok = result.ok;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    // The POST left this host either way, so it is a ledger action either way —
    // the outcome lives in the context, not in whether a row exists.
    await this.recordLedger({
      row,
      message,
      tier: 1,
      method: 'one_click',
      url,
      domain,
      summary: ok
        ? `One-click unsubscribe from ${row.sender_email}`
        : `One-click unsubscribe from ${row.sender_email} (failed)`,
      extra: { http_status: status, ok, error },
    });

    if (error || !ok) {
      // Transport/5xx failures ride the lease's backoff; the attempt stays
      // claimable until the cap sends it terminal.
      return { kind: 'retry', error: error ?? `one-click POST returned ${status}` };
    }

    await this.deps.store.finish(row.id, {
      status: 'succeeded',
      tier: 1,
      method: 'one_click',
      targetUrl: url,
      detail: { dispatched: true, http_status: status, email_id: message.id },
    });
    this.log.info({ attemptId: row.id, status }, 'Unsubscribe: tier 1 one-click succeeded');
    return { kind: 'terminal', status: 'succeeded' };
  }

  /** Tier 2 — drive the page, keep a screenshot, downgrade anything ambiguous. */
  private async runTierTwo(
    row: UnsubscribeAttemptRow,
    message: SenderMessage,
    detected: DetectedMethod,
    domain: string
  ): Promise<ProcessOutcome> {
    const url = detected.url!;
    const { browser } = this.deps;

    if (!this.config.browserEnabled || !browser) {
      await this.deps.store.finish(row.id, {
        status: 'needs_review',
        tier: 3,
        method: 'review',
        targetUrl: url,
        detail: {
          reason: 'browser-tier-disabled',
          detail: 'tier 2 requires a configured browser bridge',
          email_id: message.id,
        },
      });
      return { kind: 'terminal', status: 'needs_review' };
    }

    const screenshotPath = join(
      this.config.proofDir,
      `${row.id}-${row.sender_email.replace(/[^a-z0-9._-]/gi, '_')}.png`
    );
    const result = await browser.unsubscribe(url, { screenshotPath });

    if (result.outcome === 'submitted') {
      await this.recordLedger({
        row,
        message,
        tier: 2,
        method: 'browser_form',
        url,
        domain,
        summary: `Browser unsubscribe from ${row.sender_email}`,
        proofPath: result.screenshotPath ?? null,
        extra: {
          confirmed: result.confirmed === true,
          steps: result.steps,
          reason: result.reason,
        },
      });
      await this.deps.store.finish(row.id, {
        status: 'succeeded',
        tier: 2,
        method: 'browser_form',
        targetUrl: url,
        proofPath: result.screenshotPath ?? null,
        detail: {
          dispatched: true,
          confirmed: result.confirmed === true,
          reason: result.reason,
          steps: result.steps,
          email_id: message.id,
        },
      });
      this.log.info(
        { attemptId: row.id, proof: result.screenshotPath, confirmed: result.confirmed },
        'Unsubscribe: tier 2 form submitted'
      );
      return { kind: 'terminal', status: 'succeeded' };
    }

    // `unavailable` (no bridge) and `needs_review` (login wall, ambiguity,
    // step failure) both land in the review queue. A tier-2 failure must
    // DOWNGRADE to a human, never silently retry into a wall — and the
    // screenshot, if one was taken, goes with it.
    await this.deps.store.finish(row.id, {
      status: 'needs_review',
      tier: 3,
      method: 'review',
      targetUrl: url,
      proofPath: result.screenshotPath ?? null,
      detail: {
        reason: result.outcome === 'unavailable' ? 'browser-unavailable' : 'browser-needs-review',
        detail: result.reason,
        steps: result.steps,
        email_id: message.id,
      },
    });
    this.log.info(
      { attemptId: row.id, outcome: result.outcome, reason: result.reason },
      'Unsubscribe: tier 2 downgraded to review'
    );
    return { kind: 'terminal', status: 'needs_review' };
  }

  /**
   * Direct audit-ledger row for an action that actually left this host.
   * Best-effort by contract: a ledger failure must never break — or silently
   * un-do — the thing it is recording.
   */
  private async recordLedger(input: {
    row: UnsubscribeAttemptRow;
    message: SenderMessage;
    tier: number;
    method: string;
    url: string;
    domain: string;
    summary: string;
    proofPath?: string | null;
    extra?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.deps.ledger?.record({
        actor: { kind: 'service', service: 'unsubscribe-automation' },
        actionType: 'unsubscribe',
        targetSystem: 'email',
        targetId: input.row.sender_email,
        summary: input.summary,
        context: {
          attempt_id: input.row.id,
          sender_email: input.row.sender_email,
          sender_domain: input.domain,
          tier: input.tier,
          method: input.method,
          target_url: input.url,
          email_id: input.message.id,
          account_id: input.message.account_id,
          // Pointer, not payload: the ledger indexes the proof, the filesystem
          // holds it.
          ...(input.proofPath ? { proof_path: input.proofPath } : {}),
          ...(input.extra ?? {}),
        },
      });
    } catch (err) {
      this.log.error({ err, attemptId: input.row.id }, 'Unsubscribe: ledger record failed (non-fatal)');
    }
  }

  /**
   * One scheduled cycle: reclaim stranded leases, materialize newly-flagged
   * senders, then work up to `maxPerRun` claimed attempts.
   *
   * The lease helper supplies the atomic claim, the expiry, and the backoff
   * (specs/behaviors/scheduled-work-leases.md); this loop supplies only the
   * translation from a `ProcessOutcome` back to the lease. Deferred attempts
   * are deliberately NOT released through `fail()` — the store already put them
   * back with a future `next_attempt_at`, and routing them through the failure
   * path would spend an attempt on being polite.
   */
  async runCycle(): Promise<CycleResult> {
    const result: CycleResult = {
      enqueued: 0,
      claimed: 0,
      succeeded: 0,
      needsReview: 0,
      skipped: 0,
      deferred: 0,
      failed: 0,
    };
    if (!this.config.enabled) {
      this.log.debug('Unsubscribe automation disabled; cycle skipped');
      return result;
    }
    const queue = this.deps.queue;
    if (!queue) {
      this.log.warn('Unsubscribe: no lease queue wired; cycle skipped');
      return result;
    }

    const reclaimed = await queue.reclaimExpired();
    if (reclaimed.length > 0) {
      this.log.warn({ count: reclaimed.length }, 'Unsubscribe: reclaimed expired leases');
    }

    result.enqueued = await this.enqueue();
    const claims = await queue.claim(this.config.maxPerRun);
    result.claimed = claims.length;

    for (const claim of claims) {
      const attemptId = Number(claim.id);
      try {
        const outcome = await this.processAttempt(attemptId);
        switch (outcome.kind) {
          case 'deferred':
            result.deferred += 1;
            break;
          case 'retry': {
            const released = await queue.fail(claim.id, outcome.error);
            result.failed += 1;
            if (released?.exhausted) {
              this.log.error(
                { attemptId, error: outcome.error },
                'Unsubscribe: attempt exhausted its retries'
              );
            }
            break;
          }
          default:
            if (outcome.status === 'succeeded') result.succeeded += 1;
            else if (outcome.status === 'needs_review') result.needsReview += 1;
            else result.skipped += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error({ attemptId, error }, 'Unsubscribe: attempt threw');
        await queue.fail(claim.id, message);
        result.failed += 1;
      }
    }
    return result;
  }

  /** Tier 3 — what a human still has to decide. */
  async reviewQueue(limit = 100): Promise<UnsubscribeAttemptRow[]> {
    return this.deps.store.listByStatus('needs_review', limit);
  }

  /** The attempt log by status — the read surface behind the routes. */
  async reviewQueueByStatus(status: AttemptStatus, limit = 100): Promise<UnsubscribeAttemptRow[]> {
    return this.deps.store.listByStatus(status, limit);
  }

  /** The weekly nudge. Returns how many cases are waiting. */
  async sendReviewDigest(): Promise<number> {
    const rows = await this.reviewQueue(50);
    if (rows.length === 0) {
      this.log.info('Unsubscribe review digest: queue empty, skipping');
      return 0;
    }
    const preview = rows
      .slice(0, 8)
      .map((r) => `• ${r.sender_email} — ${reasonOf(r.detail) ?? 'needs a decision'}`)
      .join('\n');
    if (this.deps.notify) {
      await this.deps.notify.notify({
        priority: 'notice',
        title: `Unsubscribe review · ${rows.length} case(s)`,
        body: `Flagged senders automation would not act on unattended:\n${preview}`,
      });
    } else {
      this.log.warn('Unsubscribe review digest composed but no dispatcher wired');
    }
    return rows.length;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function reasonOf(detail: UnsubscribeAttemptRow['detail']): string | null {
  const obj = typeof detail === 'string' ? (safeJson(detail) as Record<string, unknown>) : detail;
  const reason = obj?.reason;
  return typeof reason === 'string' ? reason : null;
}

// ── Postgres store ──────────────────────────────────────────────────────────

export class UnsubscribeStore implements UnsubscribeStoreLike {
  constructor(private readonly sql: postgres.Sql) {}

  /**
   * THE queue source, in one statement. Rows come from `sender_standing` with
   * standing = 'unsubscribe_queue' — the owner's explicit digest-page tap —
   * and from nowhere else. No classifier output, no heuristic over message
   * content, feeds this SELECT.
   *
   * Idempotent, and re-armable: an open attempt blocks a duplicate, a terminal
   * attempt created at or after the last tap blocks a re-run, but a FRESH tap
   * (a `set_at` newer than every attempt) legitimately re-arms the sender.
   */
  async enqueueFromQueue(limit: number): Promise<number> {
    const rows = await this.sql<{ id: number }[]>`
      INSERT INTO google.unsubscribe_attempts (sender_email, sender_domain, status)
      SELECT s.sender_email, split_part(s.sender_email, '@', 2), 'queued'
      FROM google.sender_standing s
      WHERE s.standing = 'unsubscribe_queue'
        AND NOT EXISTS (
          SELECT 1 FROM google.unsubscribe_attempts a
          WHERE a.sender_email = s.sender_email
            AND (a.status IN ('queued', 'running') OR a.created_at >= s.set_at)
        )
      ORDER BY s.set_at ASC
      LIMIT ${limit}
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    return rows.length;
  }

  async loadAttempt(id: number): Promise<UnsubscribeAttemptRow | null> {
    const [row] = await this.sql<UnsubscribeAttemptRow[]>`
      SELECT id, sender_email, sender_domain, account_id, email_id, tier, method,
             target_url, proof_path, status, detail, attempts, created_at, completed_at
      FROM google.unsubscribe_attempts
      WHERE id = ${id}
    `;
    return row ?? null;
  }

  /** The execution-time re-check of the owner's flag. */
  async standingFor(senderEmail: string): Promise<SenderStanding | null> {
    const [row] = await this.sql<{ standing: SenderStanding }[]>`
      SELECT standing FROM google.sender_standing
      WHERE sender_email = ${senderEmail.trim().toLowerCase()}
    `;
    return row?.standing ?? null;
  }

  async latestSenderMessage(senderEmail: string): Promise<SenderMessage | null> {
    const [row] = await this.sql<SenderMessage[]>`
      SELECT id, account_id, message_id, analysis
      FROM google.emails
      WHERE lower(from_address) = ${senderEmail.trim().toLowerCase()}
        AND account_id IS NOT NULL
      ORDER BY date DESC NULLS LAST
      LIMIT 1
    `;
    return row ?? null;
  }

  /**
   * Completion times of prior DISPATCHED actions against this domain. Gate
   * skips and review routing never touched the provider, so `detail.dispatched`
   * — set only where a request actually went out — is the filter.
   */
  async recentDomainActions(domain: string, since: Date): Promise<Date[]> {
    const rows = await this.sql<{ completed_at: Date }[]>`
      SELECT completed_at
      FROM google.unsubscribe_attempts
      WHERE sender_domain = ${domain}
        AND completed_at IS NOT NULL
        AND completed_at >= ${since}
        AND (detail ->> 'dispatched') = 'true'
      ORDER BY completed_at ASC
    `;
    return rows.map((r) => r.completed_at);
  }

  async finish(id: number, outcome: AttemptOutcome): Promise<void> {
    await this.sql`
      UPDATE google.unsubscribe_attempts SET
        status = ${outcome.status},
        tier = ${outcome.tier ?? null},
        method = ${outcome.method ?? null},
        target_url = COALESCE(${outcome.targetUrl ?? null}, target_url),
        proof_path = COALESCE(${outcome.proofPath ?? null}, proof_path),
        detail = ${this.sql.json(outcome.detail as never)},
        lease_owner = NULL,
        lease_expires_at = NULL,
        next_attempt_at = NULL,
        completed_at = NOW()
      WHERE id = ${id}
    `;
  }

  /**
   * Push a rate-limited attempt back to `queued` without burning an attempt.
   * Being paced is not a failure, so the attempt counter is rolled back — the
   * lease already incremented it at claim time.
   */
  async defer(id: number, until: Date, note: string): Promise<void> {
    await this.sql`
      UPDATE google.unsubscribe_attempts SET
        status = 'queued',
        attempts = GREATEST(attempts - 1, 0),
        lease_owner = NULL,
        lease_expires_at = NULL,
        next_attempt_at = ${until},
        last_error = ${note}
      WHERE id = ${id}
    `;
  }

  async listByStatus(status: AttemptStatus, limit = 100): Promise<UnsubscribeAttemptRow[]> {
    return this.sql<UnsubscribeAttemptRow[]>`
      SELECT id, sender_email, sender_domain, account_id, email_id, tier, method,
             target_url, proof_path, status, detail, attempts, created_at, completed_at
      FROM google.unsubscribe_attempts
      WHERE status = ${status}
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;
  }
}

/**
 * The lease queue over `google.unsubscribe_attempts`.
 *
 * `serializeBy: sender_domain` is the structural half of the rate limit: at
 * most one in-flight attempt per provider, whatever the window policy says,
 * while SKIP LOCKED still gives full parallelism across domains. `maxAttempts`
 * is low on purpose — an unsubscribe endpoint that fails repeatedly is a case
 * for a human, not for a longer retry budget.
 */
export function createUnsubscribeQueue(sql: postgres.Sql): LeaseQueue {
  return createLeaseQueue(sql, {
    schema: 'google',
    table: 'unsubscribe_attempts',
    readyStatus: 'queued',
    runningStatus: 'running',
    failedStatus: 'failed',
    serializeBy: 'sender_domain',
    maxAttempts: 3,
    leaseMs: 300_000,
    backoffBaseMs: 300_000,
    backoffMaxMs: 6 * 3_600_000,
    orderBy: 'created_at ASC',
    returning: ['sender_email', 'sender_domain'],
  });
}

// ── Gmail header source ─────────────────────────────────────────────────────

/**
 * Reads `List-Unsubscribe` / `List-Unsubscribe-Post` off a message with a
 * `format=metadata` fetch. Sync stores no raw headers, and adding a column
 * would only cover mail synced after the migration; fetching on demand covers
 * the whole corpus and costs one cheap API call per attempt.
 */
export class GmailHeaderSource implements MessageHeaderSource {
  constructor(private readonly authService: Pick<GmailAuthService, 'getGmailClient'>) {}

  async fetchHeaders(accountId: number, messageId: string): Promise<UnsubscribeHeaders> {
    const gmail = (await this.authService.getGmailClient(accountId)) as gmail_v1.Gmail;
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: UNSUBSCRIBE_HEADERS,
    });
    const headers = response.data.payload?.headers ?? [];
    const pick = (name: string): string | null =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
    return {
      listUnsubscribe: pick('List-Unsubscribe'),
      listUnsubscribePost: pick('List-Unsubscribe-Post'),
    };
  }
}
