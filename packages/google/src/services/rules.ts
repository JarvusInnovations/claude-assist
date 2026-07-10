/**
 * Deterministic pre-AI triage rules.
 *
 * Rules match on sender / subject / body patterns BEFORE any model call. A
 * matching rule can pre-assign a digest section / domain / priority and, when
 * `skip_ai_triage` is set, short-circuit AI triage entirely (saving a Haiku
 * turn) with a deterministic plan.
 *
 * The matching predicates are pure and exported so they can be unit-tested
 * without a DB; `RulesService` only adds the per-account query + ordering.
 */

import type postgres from 'postgres';
import type { EmailRecord, TriageRule } from '../types.js';

/** Subset of an email the matcher reads. */
export interface MatchableEmail {
  from_address: string | null;
  subject: string | null;
  body_text: string | null;
}

/**
 * Glob-match a value against a pattern supporting `*` (any run) and `?` (any
 * single char). Everything else is matched literally. Anchored at both ends,
 * so `*@example.com` matches `user@example.com` and `noreply@*` matches
 * `noreply@example.com`.
 */
export function matchPattern(value: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  );
  return regex.test(value);
}

/**
 * True when a rule matches an email. All present clauses must match; within a
 * clause the patterns are OR'd. `body_not_contains` is a negative gate.
 */
export function ruleMatches(email: MatchableEmail, rule: TriageRule): boolean {
  if (rule.from_patterns && rule.from_patterns.length > 0) {
    const fromAddress = email.from_address?.toLowerCase() ?? '';
    const matches = rule.from_patterns.some((p) =>
      matchPattern(fromAddress, p.toLowerCase())
    );
    if (!matches) return false;
  }

  if (rule.subject_contains && rule.subject_contains.length > 0) {
    const subject = email.subject?.toLowerCase() ?? '';
    const matches = rule.subject_contains.some((k) =>
      subject.includes(k.toLowerCase())
    );
    if (!matches) return false;
  }

  if (rule.body_contains && rule.body_contains.length > 0) {
    const body = email.body_text?.toLowerCase() ?? '';
    const matches = rule.body_contains.some((k) => body.includes(k.toLowerCase()));
    if (!matches) return false;
  }

  if (rule.body_not_contains && rule.body_not_contains.length > 0) {
    const body = email.body_text?.toLowerCase() ?? '';
    const hasExcluded = rule.body_not_contains.some((k) =>
      body.includes(k.toLowerCase())
    );
    if (hasExcluded) return false;
  }

  // A rule with no pattern clauses at all never matches (guards against an
  // accidental catch-all).
  const hasAnyClause =
    (rule.from_patterns?.length ?? 0) > 0 ||
    (rule.subject_contains?.length ?? 0) > 0 ||
    (rule.body_contains?.length ?? 0) > 0;
  return hasAnyClause;
}

/**
 * Return the first enabled rule (highest priority first) that matches, or null.
 * Pure over a pre-loaded, already-ordered rule list.
 */
export function firstMatchingRule(
  email: MatchableEmail,
  rules: TriageRule[]
): TriageRule | null {
  for (const rule of rules) {
    if (ruleMatches(email, rule)) return rule;
  }
  return null;
}

export class RulesService {
  private sql: postgres.Sql;

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  /** Load enabled rules for an account, highest priority first. */
  async loadRules(accountId: number): Promise<TriageRule[]> {
    return this.sql<TriageRule[]>`
      SELECT * FROM google.triage_rules
      WHERE account_id = ${accountId} AND enabled = true
      ORDER BY priority DESC, id ASC
    `;
  }

  /** First matching enabled rule for an email, or null. */
  async matchRule(email: EmailRecord): Promise<TriageRule | null> {
    const rules = await this.loadRules(email.account_id);
    return firstMatchingRule(email, rules);
  }
}
