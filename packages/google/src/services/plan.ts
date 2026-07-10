/**
 * Deterministic plan derivation.
 *
 * Turns an AI analysis (or a matched rule) into the concrete plan the executor
 * will apply: full Gmail label paths, a gmail_action, and a digest section.
 * Pure and side-effect-free so it can be unit-tested without a DB or Gmail
 * client; the model is never called here.
 *
 * Label scheme
 * ------------
 * `planned_labels` are stored as FULL nested Gmail label paths, already
 * namespaced with the account's configured prefixes (default `AI` and `TODO`):
 *   - `<AI>/Triaged`              — always present; marks the message processed
 *                                    so full-sync's `-label:<AI>/Triaged`
 *                                    exclusion becomes real once executed.
 *   - `<AI>/Type/<MessageType>`   — Newsletter | Alert | Spam | Group | Personal
 *   - `<AI>/Domain/<Domain>`      — from a rule's assigned_domain
 *   - `<AI>/Priority/<Level>`     — from a rule's priority_level
 *   - `<TODO>/Respond`            — the email needs a reply / action
 *   - `<TODO>/Review`             — an opportunity/newsletter worth a look
 * The executor ensures each nested path exists (creating ancestors) and applies
 * the leaf label id.
 */

import type { EmailAnalysis, GmailAction, MessageType, TriageRule } from '../types.js';

export interface LabelPrefixes {
  /** Classification tree prefix (default 'AI'). */
  ai: string;
  /** Action/TODO tree prefix (default 'TODO'). */
  todo: string;
}

export interface DerivedPlan {
  plannedLabels: string[];
  gmailAction: GmailAction;
  digestSection: string;
}

export const DEFAULT_LABEL_PREFIXES: LabelPrefixes = { ai: 'AI', todo: 'TODO' };

/** Capitalize the first letter of each `/`-separated, `-`/space-split segment. */
export function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

/** The label every processed email carries (drives the full-sync exclusion). */
export function triagedLabel(prefixes: LabelPrefixes): string {
  return `${prefixes.ai}/Triaged`;
}

/**
 * Map an AI message_type to its default gmail_action. Newsletters and alerts
 * are staged for archive (they go to the digest); spam is quarantined; group
 * and personal mail is left in the inbox by default.
 */
export function actionForMessageType(type: MessageType): GmailAction {
  switch (type) {
    case 'spam':
      return 'spam';
    case 'newsletter':
    case 'alert':
      return 'archive';
    case 'group':
    case 'personal':
    default:
      return 'leave';
  }
}

/** Map an AI message_type to its default digest section. */
export function digestSectionForMessageType(type: MessageType): string {
  switch (type) {
    case 'newsletter':
      return 'newsletters';
    case 'spam':
      return 'spam';
    case 'alert':
      return 'notifications';
    case 'group':
      return 'notifications';
    case 'personal':
    default:
      return 'personal';
  }
}

/**
 * Derive a plan from a completed AI analysis, optionally refined by the rule
 * that pre-matched the email (a non-skip_ai_triage rule can still pre-assign a
 * digest section / domain / priority / gmail_action).
 */
export function derivePlanFromAnalysis(
  analysis: EmailAnalysis,
  rule: TriageRule | null,
  prefixes: LabelPrefixes = DEFAULT_LABEL_PREFIXES
): DerivedPlan {
  const labels = new Set<string>([triagedLabel(prefixes)]);

  labels.add(`${prefixes.ai}/Type/${titleCase(analysis.message_type)}`);

  if (rule?.assigned_domain) {
    labels.add(`${prefixes.ai}/Domain/${titleCase(rule.assigned_domain)}`);
  }
  if (rule?.priority_level) {
    labels.add(`${prefixes.ai}/Priority/${titleCase(rule.priority_level)}`);
  }

  // Action tags: something the recipient must act on.
  if (analysis.message_type === 'personal' && analysis.sender_type === 'human') {
    labels.add(`${prefixes.todo}/Respond`);
  } else if (analysis.potential_action_items.length > 0) {
    labels.add(`${prefixes.todo}/Respond`);
  } else if (rule?.action === 'analyze_relevance') {
    labels.add(`${prefixes.todo}/Review`);
  }

  const gmailAction: GmailAction =
    rule?.gmail_action ?? actionForMessageType(analysis.message_type);

  const digestSection =
    rule?.digest_section ?? digestSectionForMessageType(analysis.message_type);

  return {
    plannedLabels: [...labels].sort(),
    gmailAction,
    digestSection,
  };
}

const MESSAGE_TYPES: readonly MessageType[] = [
  'spam',
  'newsletter',
  'alert',
  'group',
  'personal',
];

function isMessageType(value: string | null | undefined): value is MessageType {
  return !!value && (MESSAGE_TYPES as readonly string[]).includes(value);
}

/**
 * Synthesize a minimal EmailAnalysis for a skip_ai_triage rule match.
 *
 * No model call happens on this path, but `analysis->>'message_type'` is the
 * only thing the admin UI's stats/table queries (and the digest) filter on —
 * without this, a deterministically-triaged email is fully invisible to every
 * per-type view even though the executor still archives/labels it. Falls back
 * to the rule's own `action` when `assigned_type` isn't set (most skip rules
 * only assign a digest_section + gmail_action), and finally to 'alert' since
 * skip_ai_triage rules by definition match low-touch automated mail.
 */
export function analysisFromRule(rule: TriageRule): EmailAnalysis {
  const messageType: MessageType = isMessageType(rule.assigned_type)
    ? rule.assigned_type
    : rule.action === 'spam'
      ? 'spam'
      : 'alert';

  return {
    overview: `Matched deterministic rule "${rule.name}" (skip_ai_triage) — no AI turn ran.`,
    mentioned_people: [],
    mentioned_organizations: [],
    potential_action_items: [],
    sender_type: 'automated',
    message_type: messageType,
    unsubscribe_link: null,
    rationale: `Rule ${rule.rule_id} matched before any AI analysis.`,
  };
}

/**
 * Derive a plan directly from a skip_ai_triage rule (no AI analysis available).
 * Mirrors the deleted `applyRuleResult`, modernized onto the AI/* + TODO/* tree.
 */
export function derivePlanFromRule(
  rule: TriageRule,
  prefixes: LabelPrefixes = DEFAULT_LABEL_PREFIXES
): DerivedPlan {
  const labels = new Set<string>([triagedLabel(prefixes)]);

  if (rule.assigned_type) {
    labels.add(`${prefixes.ai}/Type/${titleCase(rule.assigned_type)}`);
  }
  if (rule.assigned_domain) {
    labels.add(`${prefixes.ai}/Domain/${titleCase(rule.assigned_domain)}`);
  }
  if (rule.priority_level) {
    labels.add(`${prefixes.ai}/Priority/${titleCase(rule.priority_level)}`);
  }

  const gmailAction: GmailAction =
    rule.gmail_action ?? (rule.action === 'spam' ? 'spam' : rule.action === 'leave' ? 'leave' : 'archive');

  return {
    plannedLabels: [...labels].sort(),
    gmailAction,
    digestSection: rule.digest_section ?? 'notifications',
  };
}
