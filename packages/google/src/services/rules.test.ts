import { describe, expect, it } from 'bun:test';
import { matchPattern, ruleMatches, firstMatchingRule } from './rules.js';
import type { TriageRule } from '../types.js';

function rule(overrides: Partial<TriageRule>): TriageRule {
  return {
    id: 1,
    account_id: 1,
    rule_id: 'r',
    name: 'r',
    description: null,
    from_patterns: null,
    subject_contains: null,
    body_contains: null,
    body_not_contains: null,
    action: 'archive',
    gmail_action: null,
    priority_level: null,
    digest_section: null,
    assess_against_topics: false,
    assigned_domain: null,
    assigned_type: null,
    skip_ai_triage: false,
    enabled: true,
    priority: 0,
    notes: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('matchPattern (glob)', () => {
  it('matches leading and trailing wildcards', () => {
    expect(matchPattern('user@example.com', '*@example.com')).toBe(true);
    expect(matchPattern('noreply@example.com', 'noreply@*')).toBe(true);
    expect(matchPattern('newsletter-weekly@x.com', '*newsletter*')).toBe(true);
  });
  it('anchors at both ends', () => {
    expect(matchPattern('a@example.com.evil.com', '*@example.com')).toBe(false);
    expect(matchPattern('evil.calendar.google.com', 'calendar.google.com')).toBe(false);
  });
  it('treats regex metacharacters literally', () => {
    expect(matchPattern('a+b@x.com', 'a+b@x.com')).toBe(true);
    expect(matchPattern('aXb@x.com', 'a+b@x.com')).toBe(false);
  });
});

describe('ruleMatches', () => {
  const email = {
    from_address: 'hello@acme-bank.example',
    subject: 'Your invoice is ready',
    body_text: 'Please review. To stop these, unsubscribe here.',
  };

  it('matches on from_patterns (OR within the clause)', () => {
    expect(ruleMatches(email, rule({ from_patterns: ['*@stripe.com', 'hello@acme-bank.example'] }))).toBe(true);
    expect(ruleMatches(email, rule({ from_patterns: ['*@stripe.com'] }))).toBe(false);
  });

  it('requires ALL present clauses to match (AND across clauses)', () => {
    // from matches but subject does not → no match
    expect(
      ruleMatches(email, rule({ from_patterns: ['*@acme-bank.example'], subject_contains: ['refund'] }))
    ).toBe(false);
    expect(
      ruleMatches(email, rule({ from_patterns: ['*@acme-bank.example'], subject_contains: ['invoice'] }))
    ).toBe(true);
  });

  it('honors body_not_contains as a negative gate', () => {
    expect(
      ruleMatches(email, rule({ subject_contains: ['invoice'], body_not_contains: ['unsubscribe'] }))
    ).toBe(false);
    expect(
      ruleMatches(email, rule({ subject_contains: ['invoice'], body_not_contains: ['refund'] }))
    ).toBe(true);
  });

  it('never matches a rule with no positive clauses (no accidental catch-all)', () => {
    expect(ruleMatches(email, rule({ body_not_contains: ['nope'] }))).toBe(false);
    expect(ruleMatches(email, rule({}))).toBe(false);
  });

  it('is case-insensitive on subject/body/from', () => {
    expect(
      ruleMatches(
        { from_address: 'HELLO@acme-bank.example', subject: 'INVOICE', body_text: '' },
        rule({ from_patterns: ['*@acme-bank.example'], subject_contains: ['invoice'] })
      )
    ).toBe(true);
  });
});

describe('firstMatchingRule', () => {
  it('returns the first rule that matches in the given (priority) order', () => {
    const rules = [
      rule({ id: 10, rule_id: 'client', from_patterns: ['*@client.org'] }),
      rule({ id: 20, rule_id: 'catch-newsletter', from_patterns: ['*'] }),
    ];
    const m = firstMatchingRule({ from_address: 'a@b.com', subject: '', body_text: '' }, rules);
    expect(m?.rule_id).toBe('catch-newsletter');

    const m2 = firstMatchingRule({ from_address: 'x@client.org', subject: '', body_text: '' }, rules);
    expect(m2?.rule_id).toBe('client');
  });

  it('returns null when nothing matches', () => {
    const rules = [rule({ from_patterns: ['*@client.org'] })];
    expect(firstMatchingRule({ from_address: 'a@b.com', subject: '', body_text: '' }, rules)).toBeNull();
  });
});
