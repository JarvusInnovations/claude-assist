/**
 * Urgency pipeline — the policy that turns a candidate message into (at most)
 * one wrist-reaching interrupt.
 *
 * Order of operations, each a place the interrupt bar is defended:
 *   1. Boundaries — never interrupt for a message Chris sent, a bot message, or
 *      a message Chris has already replied to after (the poll interval makes the
 *      "already replied" check feasible and it kills the most annoying false
 *      positive).
 *   2. Deterministic tier (urgency.ts) — drop pure noise cheaply; promote clear
 *      asks; hand the ambiguous middle to the model.
 *   3. Model residue — the regret test on a strong-enough model, once.
 *   4. Quiet hours — ordinary urgency batches to a near-miss overnight; only the
 *      emergency tier pierces it.
 *   5. Thread dedup / cooldown — the first qualifying message in a thread
 *      interrupts; rapid followups fold in.
 *
 * The pipeline reads state (weights, prior interrupts) and drives side effects
 * (dispatch, permalink, persist) through injected collaborators so the whole
 * policy is unit-testable without Slack, Postgres, or the model.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { Decision, SlackCandidate, UrgencyTier, Verdict } from './types.js';
import type { UrgencyStore } from './store.js';
import type { Roster } from './roster.js';
import type { ResidueJudge, ThreadContextLine } from './classifier.js';
import { classifyDeterministic, isQuietHours, type QuietHoursConfig } from './urgency.js';

/** Fires the actual interrupt. Returns the notify.notifications row id (or null). */
export interface UrgencyNotifier {
  fire(decision: Decision, permalink: string | null): Promise<number | null>;
}

/** Resolves an https permalink for a message (deep link carried in the alert). */
export interface PermalinkResolver {
  resolve(channel: string, ts: string): Promise<string | null>;
}

/** Everything the poller knows about a candidate that the pipeline can't derive. */
export interface EvalContext {
  isDirectMessage: boolean;
  mentionsOwner: boolean;
  /** A later message in the same thread was sent by Chris → he's handled it. */
  ownerRepliedAfter: boolean;
  /** Preceding thread lines (oldest → newest) for the model's context. */
  threadContext: ThreadContextLine[];
}

export interface PipelineConfig {
  /** Slack user id of Chris. Messages from this id never interrupt. */
  ownerId: string;
  quietHours: QuietHoursConfig;
  /** Per-thread interrupt cooldown in ms (default 30 min). */
  cooldownMs?: number;
}

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

export class UrgencyPipeline {
  private cooldownMs: number;

  constructor(
    private store: UrgencyStore,
    private classifier: ResidueJudge | null,
    private roster: Roster,
    private notifier: UrgencyNotifier,
    private permalinks: PermalinkResolver,
    private log: FastifyBaseLogger,
    private config: PipelineConfig
  ) {
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  /**
   * Full pipeline for one candidate: evaluate, (maybe) dispatch, persist.
   * `knownPermalink` lets a caller that already holds the message's permalink
   * (e.g. the mention sweep — search results carry one) skip the resolver call.
   */
  async process(
    candidate: SlackCandidate,
    ctx: EvalContext,
    now = new Date(),
    knownPermalink?: string | null
  ): Promise<Decision> {
    const decision = await this.evaluate(candidate, ctx, now);

    // A boundary suppression or pure drop is noise — don't even persist the drop
    // rows (they'd dwarf the signal); a suppressed-boundary is logged, not stored.
    if (decision.verdict === 'drop' || decision.verdict === 'suppressed') {
      this.log.debug(
        { channel: candidate.channel, ts: candidate.ts, verdict: decision.verdict, reason: decision.reason },
        'Slack urgency: no-op'
      );
      return decision;
    }

    // A deep link rides along on both interrupts and near-misses (the digest
    // wants it too). We only pay the API call when there's something to link to
    // and the caller didn't already have one.
    const permalink =
      knownPermalink !== undefined && knownPermalink !== null
        ? knownPermalink
        : await this.permalinks.resolve(candidate.channel, candidate.ts);

    let notificationId: number | null = null;
    if (decision.interrupted) {
      notificationId = await this.notifier.fire(decision, permalink);
    }

    await this.store.recordCandidate({
      decision,
      permalink,
      notificationId,
      messageTs: tsToDate(candidate.ts),
    });

    this.log.info(
      {
        channel: candidate.channel,
        ts: candidate.ts,
        tier: decision.tier,
        verdict: decision.verdict,
        interrupted: decision.interrupted,
      },
      'Slack urgency decision'
    );
    return decision;
  }

  /** Pure-ish decision (reads weights/dedup + may call the model). No dispatch. */
  async evaluate(candidate: SlackCandidate, ctx: EvalContext, now = new Date()): Promise<Decision> {
    // 1. Boundaries.
    if (candidate.sender === this.config.ownerId) {
      return boundary(candidate, 'self');
    }
    if (candidate.isBot) {
      return boundary(candidate, 'bot', 'drop');
    }
    if (ctx.ownerRepliedAfter) {
      return boundary(candidate, 'owner-already-replied');
    }

    const senderIsTeam = this.roster.has(candidate.sender);
    const senderName = candidate.senderName ?? this.roster.nameOf(candidate.sender);
    const weight =
      (await this.store.getWeight('sender', candidate.sender)) +
      (await this.store.getWeight('channel', candidate.channel));

    // 2. Deterministic tier.
    const det = classifyDeterministic({
      candidate: { ...candidate, senderName },
      isDirectMessage: ctx.isDirectMessage,
      mentionsOwner: ctx.mentionsOwner,
      senderIsTeam,
      weight,
    });

    const base = {
      candidate: { ...candidate, senderName },
      tier: det.tier,
      signals: det.signals,
      gist: det.gist,
      classifier: 'deterministic' as const,
      model: null as string | null,
      rationale: null as string | null,
      confidence: null as number | null,
    };

    if (det.tier === 'drop') {
      return { ...base, verdict: 'drop', interrupted: false, nearMiss: false };
    }

    // 3. Model residue — the regret test.
    let wantInterrupt: boolean;
    let ignoreQuiet = false;
    let gist = det.gist;
    let classifier: 'deterministic' | 'model' = 'deterministic';
    let model: string | null = null;
    let rationale: string | null = null;
    let confidence: number | null = null;

    if (det.tier === 'emergency') {
      wantInterrupt = true;
      ignoreQuiet = true; // the only tier that pierces quiet hours
    } else if (det.tier === 'urgent') {
      wantInterrupt = true;
    } else {
      // residue → let the model judge; if there's no model, be conservative and
      // treat it as a near-miss (digest backstop) rather than interrupt.
      if (!this.classifier) {
        wantInterrupt = false;
        rationale = 'No residue classifier configured; deferred to digest.';
      } else {
        const verdict = await this.classifier.classify(
          { ...candidate, senderName },
          ctx.threadContext
        );
        classifier = 'model';
        model = verdict.model;
        confidence = verdict.confidence;
        rationale = verdict.rationale;
        if (verdict.gist) gist = verdict.gist;
        wantInterrupt = verdict.urgent;
      }
    }

    const decided = {
      ...base,
      gist,
      classifier,
      model,
      rationale,
      confidence,
    };

    if (!wantInterrupt) {
      // Plausible but judged non-urgent → near-miss backstop for the digest.
      return { ...decided, verdict: 'near_miss', interrupted: false, nearMiss: true };
    }

    // 4. Quiet hours (ordinary urgency only).
    if (!ignoreQuiet && isQuietHours(now, this.config.quietHours)) {
      return { ...decided, verdict: 'near_miss', interrupted: false, nearMiss: true };
    }

    // 5. Thread dedup / cooldown.
    const threadKey = candidate.threadTs ?? candidate.ts;
    const since = new Date(now.getTime() - this.cooldownMs);
    const already = await this.store.threadInterruptedSince(candidate.channel, threadKey, since);
    if (already) {
      return { ...decided, verdict: 'folded', interrupted: false, nearMiss: false };
    }

    return { ...decided, verdict: 'interrupt', interrupted: true, nearMiss: false };
  }
}

function boundary(
  candidate: SlackCandidate,
  reason: string,
  verdict: Verdict = 'suppressed'
): Decision {
  return {
    candidate,
    tier: 'drop' as UrgencyTier,
    verdict,
    classifier: 'deterministic',
    model: null,
    gist: '',
    signals: [],
    rationale: null,
    confidence: null,
    interrupted: false,
    nearMiss: false,
    reason,
  };
}

/** Slack ts ("1720620000.001200") → Date. */
export function tsToDate(ts: string): Date {
  return new Date(parseFloat(ts) * 1000);
}
