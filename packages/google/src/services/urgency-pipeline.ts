/**
 * Email urgency pipeline — the policy that turns one triaged email into (at
 * most) one wrist-reaching interrupt and/or a "needs attention" briefing entry.
 *
 * Order of operations, each a place a tier is defended (mirrors slack-urgency's
 * pipeline shape):
 *   1. Opportunity path — a solicitation-class email is evaluated against the
 *      owner's interest spec FIRST (before the automated gate would drop a
 *      procurement portal's noreply). A match → ATTENTION (prominent when it's a
 *      watchlist-style HIGH hit); no-match → neither (the calm digest).
 *   2. Deterministic core (urgency.ts) — self/automated/no-standing → neither
 *      with no model call; a known+directed+keyword human → INTERRUPT with no
 *      model call; the ambiguous middle → hand to the model.
 *   3. Model residue — the "concrete ask of the owner that can't wait an hour?"
 *      judgment, once, on the cheap model.
 *   4. Thread promotion — an external reply on a thread the owner is on is at
 *      least ATTENTION.
 *   5. Quiet hours — an INTERRUPT raised in the quiet window is HELD (recorded,
 *      shown prominently in the morning briefing) unless the inference is a
 *      genuine emergency, which pierces.
 *
 * The pipeline reads/writes state through injected collaborators (store,
 * notifier, residue judge, opportunity evaluator) so the whole policy is
 * unit-testable without Postgres, the model, or the dispatcher. The caller
 * supplies per-account context (owner addresses, whitelist, client contacts,
 * team domains) and the precomputed thread-lookback flag.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { EmailRecord, EmailAnalysis } from '../types.js';
import {
  classifyEmailDeterministic,
  hasEmergencySignal,
  isQuietHours,
  type EmailTier,
  type QuietHoursConfig,
  type UrgencyInput,
} from './urgency.js';
import {
  scoreColdOutreach,
  DEFAULT_COLD_OUTREACH_CONFIG,
  type ColdOutreachConfig,
  type ColdOutreachResult,
} from './cold-outreach.js';
import { isSolicitationClass } from './solicitation.js';
import type { OpportunityJudge, OpportunityVerdict } from './opportunity.js';
import type { EmailResidueJudge } from './email-residue.js';
import type {
  EmailAttentionStore,
  AttentionTier,
  AttentionVerdict,
} from './attention-store.js';

export interface EmailUrgencyDecision {
  tier: EmailTier;
  /** Terminal disposition. 'neither' is never persisted to the attention store. */
  verdict: AttentionVerdict | 'neither';
  classifier: 'deterministic' | 'model';
  model: string | null;
  reason: string;
  gist: string;
  signals: string[];
  confidence: number | null;
  interrupted: boolean;
  quietHeld: boolean;
  /** Opportunity evaluation, when the solicitation path ran. */
  opportunity: OpportunityVerdict | null;
  /** Cold-outreach scoring, when the no-standing spam heuristic ran. */
  coldOutreach: ColdOutreachResult | null;
  /** True when the cold-outreach heuristic suggests treating this as spam. */
  spamSuggested: boolean;
}

/** Fires the interrupt through the notify dispatcher; returns notification id. */
export interface EmailInterruptNotifier {
  fire(decision: EmailUrgencyDecision, email: EmailRecord): Promise<number | null>;
}

export interface EvalContext {
  /** All owner addresses (every account). */
  ownerAddresses: ReadonlySet<string>;
  ownerLabel: string;
  whitelist: ReadonlySet<string>;
  clientContacts: ReadonlySet<string>;
  teamDomains: readonly string[];
  /** Precomputed lookback: has the owner participated earlier in this thread? */
  threadHasOwnerParticipation: boolean;
  /** Owner name tokens, for the cold-outreach personalization signal. */
  recipientNames: readonly string[];
  /** Parent-thread overview if any (context for the residue judge). */
  threadSummary?: string | null;
}

export interface EmailUrgencyPipelineConfig {
  quietHours: QuietHoursConfig;
  coldOutreach?: ColdOutreachConfig;
}

export class EmailUrgencyPipeline {
  private coldConfig: ColdOutreachConfig;

  constructor(
    private store: EmailAttentionStore,
    private residueJudge: EmailResidueJudge | null,
    private opportunity: OpportunityJudge | null,
    private notifier: EmailInterruptNotifier,
    private log: FastifyBaseLogger,
    private config: EmailUrgencyPipelineConfig
  ) {
    this.coldConfig = config.coldOutreach ?? DEFAULT_COLD_OUTREACH_CONFIG;
  }

  /** Full pipeline for one email: evaluate, (maybe) dispatch, persist. */
  async process(
    email: EmailRecord,
    analysis: EmailAnalysis,
    ctx: EvalContext,
    now = new Date()
  ): Promise<EmailUrgencyDecision> {
    const decision = await this.evaluate(email, analysis, ctx, now);

    if (decision.tier === 'neither') {
      this.log.debug(
        { emailId: email.id, reason: decision.reason },
        'Email urgency: neither tier (no attention entry)'
      );
      return decision;
    }

    let notificationId: number | null = null;
    if (decision.interrupted) {
      notificationId = await this.notifier.fire(decision, email);
    }

    const tier: AttentionTier = decision.tier === 'interrupt' ? 'interrupt' : 'attention';
    await this.store.record({
      emailId: email.id,
      accountId: email.account_id,
      tier,
      verdict: decision.verdict as AttentionVerdict,
      classifier: decision.classifier,
      model: decision.model,
      reason: decision.reason,
      gist: decision.gist || null,
      signals: decision.signals,
      confidence: decision.confidence,
      fromName: email.from_name,
      fromAddress: email.from_address,
      subject: email.subject,
      overview: analysis.overview ?? null,
      opportunityMatch: decision.opportunity?.match ?? false,
      opportunityHigh: decision.opportunity?.high ?? false,
      interrupted: decision.interrupted,
      quietHeld: decision.quietHeld,
      notificationId,
      messageDate: email.date,
    });

    this.log.info(
      {
        emailId: email.id,
        tier,
        verdict: decision.verdict,
        interrupted: decision.interrupted,
        quietHeld: decision.quietHeld,
      },
      'Email urgency decision'
    );
    return decision;
  }

  /** Pure-ish decision (may call the model). No dispatch, no persist. */
  async evaluate(
    email: EmailRecord,
    analysis: EmailAnalysis,
    ctx: EvalContext,
    now = new Date()
  ): Promise<EmailUrgencyDecision> {
    const base: EmailUrgencyDecision = {
      tier: 'neither',
      verdict: 'neither',
      classifier: 'deterministic',
      model: null,
      reason: '',
      gist: '',
      signals: [],
      confidence: null,
      interrupted: false,
      quietHeld: false,
      opportunity: null,
      coldOutreach: null,
      spamSuggested: false,
    };

    // 1. Opportunity path — evaluate solicitation-class mail against the owner's
    // interest spec before the automated gate can drop a procurement notice.
    if (this.opportunity && isSolicitationClass(emailForSolicit(email))) {
      try {
        const verdict = await this.opportunity.evaluate({
          fromName: email.from_name,
          fromAddress: email.from_address,
          subject: email.subject,
          bodyText: email.body_text,
          snippet: email.snippet,
        });
        if (verdict.match) {
          return {
            ...base,
            tier: 'attention',
            verdict: 'attention',
            classifier: 'model',
            model: verdict.model,
            reason: verdict.high
              ? `opportunity match (HIGH / watchlist): ${verdict.reasoning}`
              : `opportunity match: ${verdict.reasoning}`,
            gist: verdict.reasoning,
            signals: verdict.high ? ['opportunity', 'opportunity-high'] : ['opportunity'],
            confidence: null,
            opportunity: verdict,
          };
        }
        // No-match: calm. The existing digest_section / archive flow handles it.
        return {
          ...base,
          reason: `opportunity no-match: ${verdict.reasoning}`,
          classifier: 'model',
          model: verdict.model,
          signals: ['opportunity', 'opportunity-nomatch'],
          opportunity: verdict,
        };
      } catch (err) {
        // A failed opportunity eval falls through to the ordinary gates rather
        // than dropping the mail — logged, not fatal.
        this.log.warn({ emailId: email.id, err }, 'Opportunity evaluation failed; falling through');
      }
    }

    // 2. Deterministic core.
    const input: UrgencyInput = {
      ownerAddresses: ctx.ownerAddresses,
      senderAddress: email.from_address,
      senderType: analysis.sender_type,
      subject: email.subject,
      bodyText: email.body_text,
      snippet: email.snippet,
      toAddresses: email.to_addresses ?? [],
      ccAddresses: email.cc_addresses ?? [],
      actionItems: analysis.potential_action_items ?? [],
      whitelist: ctx.whitelist,
      clientContacts: ctx.clientContacts,
      teamDomains: ctx.teamDomains,
      // We don't store raw headers; the model-extracted unsubscribe link is a
      // reliable proxy for a List-Unsubscribe presence.
      listUnsubscribe: Boolean(analysis.unsubscribe_link),
      gmailLabels: email.gmail_labels ?? [],
      threadHasOwnerParticipation: ctx.threadHasOwnerParticipation,
    };
    const det = classifyEmailDeterministic(input);
    const signals = det.signals;

    // Cold-outreach: score no-standing first-contact mail for a spam suggestion.
    // Doesn't change the tier (no standing is already neither) — it surfaces the
    // Chewy/cold-outreach class for the caller's spam suggestion + logging.
    let coldOutreach: ColdOutreachResult | null = null;
    if (det.standing === 'none' && !det.automated) {
      coldOutreach = scoreColdOutreach(
        {
          senderAddress: email.from_address,
          subject: email.subject,
          bodyText: email.body_text,
          snippet: email.snippet,
          recipientNames: ctx.recipientNames,
          firstContact: !ctx.threadHasOwnerParticipation,
          bodyLength: (email.body_text ?? email.snippet ?? '').length,
        },
        this.coldConfig
      );
    }
    const spamSuggested = coldOutreach?.isColdOutreach ?? false;

    // Deterministic terminal tiers (no model).
    if (det.tier === 'interrupt') {
      return this.applyQuietHours(
        {
          ...base,
          tier: 'interrupt',
          verdict: 'interrupt',
          reason: det.reason,
          gist: gistFrom(analysis, email),
          signals,
          coldOutreach,
          spamSuggested,
        },
        hasEmergencySignal(email.subject, email.body_text, email.snippet),
        now
      );
    }
    if (det.tier === 'attention') {
      return {
        ...base,
        tier: 'attention',
        verdict: 'attention',
        reason: det.reason,
        gist: gistFrom(analysis, email),
        signals,
        coldOutreach,
        spamSuggested,
      };
    }

    // 3. Model residue — the ambiguous middle.
    if (det.needsModel) {
      if (!this.residueJudge) {
        // Conservative degrade with no model: a directed message with an
        // extracted action item is attention; otherwise stay calm.
        if (det.directedTo && (analysis.potential_action_items?.length ?? 0) > 0) {
          return {
            ...base,
            tier: 'attention',
            verdict: 'attention',
            reason: 'directed ask (no residue model configured)',
            gist: gistFrom(analysis, email),
            signals,
            coldOutreach,
            spamSuggested,
          };
        }
        return { ...base, reason: 'no residue model; deferred to digest', signals, coldOutreach, spamSuggested };
      }

      const verdict = await this.residueJudge.judge({
        ownerLabel: ctx.ownerLabel,
        ownerAddresses: [...ctx.ownerAddresses],
        fromName: email.from_name,
        fromAddress: email.from_address,
        toAddresses: email.to_addresses ?? [],
        ccAddresses: email.cc_addresses ?? [],
        subject: email.subject,
        bodyText: email.body_text,
        snippet: email.snippet,
        standing: det.standing,
        threadSummary: ctx.threadSummary ?? null,
      });

      const modelBase: EmailUrgencyDecision = {
        ...base,
        classifier: 'model',
        model: verdict.model,
        gist: verdict.gist || gistFrom(analysis, email),
        confidence: verdict.confidence,
        signals,
        coldOutreach,
        spamSuggested,
      };

      if (verdict.directedAsk && verdict.cannotWaitAnHour) {
        return this.applyQuietHours(
          { ...modelBase, tier: 'interrupt', verdict: 'interrupt', reason: verdict.rationale },
          verdict.emergency,
          now
        );
      }
      if (verdict.directedAsk || ctx.threadHasOwnerParticipation) {
        return {
          ...modelBase,
          tier: 'attention',
          verdict: 'attention',
          reason: verdict.directedAsk
            ? verdict.rationale
            : `${verdict.rationale} (thread promotion)`,
        };
      }
      return { ...modelBase, reason: verdict.rationale };
    }

    // Deterministic neither.
    return { ...base, reason: det.reason, signals, coldOutreach, spamSuggested };
  }

  /**
   * An INTERRUPT in quiet hours is HELD (recorded, shown prominently in the
   * morning briefing) unless the inference is a genuine emergency, which pierces.
   */
  private applyQuietHours(
    decision: EmailUrgencyDecision,
    emergency: boolean,
    now: Date
  ): EmailUrgencyDecision {
    if (!emergency && isQuietHours(now, this.config.quietHours)) {
      return {
        ...decision,
        verdict: 'quiet_held',
        interrupted: false,
        quietHeld: true,
        reason: `${decision.reason} — held for quiet hours`,
        signals: [...decision.signals, 'quiet-held'],
      };
    }
    return {
      ...decision,
      interrupted: true,
      signals: emergency ? [...decision.signals, 'emergency'] : decision.signals,
    };
  }
}

function gistFrom(analysis: EmailAnalysis, email: EmailRecord): string {
  const action = analysis.potential_action_items?.[0];
  if (action) return action;
  if (analysis.overview) return analysis.overview;
  return email.subject ?? '(no subject)';
}

function emailForSolicit(email: EmailRecord) {
  return {
    subject: email.subject,
    bodyText: email.body_text,
    snippet: email.snippet,
    senderAddress: email.from_address,
  };
}
