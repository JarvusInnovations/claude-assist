import { describe, expect, it } from 'bun:test';
import {
  derivePlanFromAnalysis,
  derivePlanFromRule,
  actionForMessageType,
  titleCase,
} from './plan.js';
import type { EmailAnalysis, TriageRule } from '../types.js';

function analysis(overrides: Partial<EmailAnalysis> = {}): EmailAnalysis {
  return {
    overview: 'x',
    mentioned_people: [],
    mentioned_organizations: [],
    potential_action_items: [],
    sender_type: 'automated',
    message_type: 'newsletter',
    unsubscribe_link: null,
    rationale: 'x',
    ...overrides,
  };
}

function rule(overrides: Partial<TriageRule>): TriageRule {
  return {
    id: 1, account_id: 1, rule_id: 'r', name: 'r', description: null,
    from_patterns: null, subject_contains: null, body_contains: null, body_not_contains: null,
    action: 'analyze_relevance', gmail_action: null, priority_level: null,
    digest_section: null, assess_against_topics: false, assigned_domain: null, assigned_type: null,
    skip_ai_triage: false, enabled: true, priority: 0, notes: null,
    created_at: new Date(), updated_at: new Date(),
    ...overrides,
  };
}

describe('titleCase', () => {
  it('camel-joins segments', () => {
    expect(titleCase('client')).toBe('Client');
    expect(titleCase('high')).toBe('High');
    expect(titleCase('data-analytics')).toBe('DataAnalytics');
  });
});

describe('actionForMessageType', () => {
  it('maps types to default gmail actions', () => {
    expect(actionForMessageType('spam')).toBe('spam');
    expect(actionForMessageType('newsletter')).toBe('archive');
    expect(actionForMessageType('alert')).toBe('archive');
    expect(actionForMessageType('personal')).toBe('leave');
    expect(actionForMessageType('group')).toBe('leave');
  });
});

describe('derivePlanFromAnalysis', () => {
  it('always includes AI/Triaged and a type label; archives newsletters into the newsletters digest', () => {
    const plan = derivePlanFromAnalysis(analysis(), null);
    expect(plan.plannedLabels).toContain('AI/Triaged');
    expect(plan.plannedLabels).toContain('AI/Type/Newsletter');
    expect(plan.gmailAction).toBe('archive');
    expect(plan.digestSection).toBe('newsletters');
  });

  it('tags personal human mail TODO/Respond and leaves it in place', () => {
    const plan = derivePlanFromAnalysis(
      analysis({ message_type: 'personal', sender_type: 'human' }),
      null
    );
    expect(plan.plannedLabels).toContain('TODO/Respond');
    expect(plan.gmailAction).toBe('leave');
    expect(plan.digestSection).toBe('personal');
  });

  it('lets a rule pre-assign domain, digest_section, and gmail_action', () => {
    const plan = derivePlanFromAnalysis(
      analysis({ message_type: 'alert' }),
      rule({ assigned_domain: 'client', digest_section: 'opportunities', gmail_action: 'leave' })
    );
    expect(plan.plannedLabels).toContain('AI/Domain/Client');
    expect(plan.gmailAction).toBe('leave');
    expect(plan.digestSection).toBe('opportunities');
  });

  it('respects a custom label prefix', () => {
    const plan = derivePlanFromAnalysis(analysis(), null, { ai: 'Hari', todo: 'DO' });
    expect(plan.plannedLabels).toContain('Hari/Triaged');
    expect(plan.plannedLabels).toContain('Hari/Type/Newsletter');
  });
});

describe('derivePlanFromRule (skip_ai_triage)', () => {
  it('builds a deterministic plan with no analysis', () => {
    const plan = derivePlanFromRule(
      rule({ action: 'archive', gmail_action: 'archive', digest_section: 'calendar', priority_level: 'low' })
    );
    expect(plan.plannedLabels).toContain('AI/Triaged');
    expect(plan.plannedLabels).toContain('AI/Priority/Low');
    expect(plan.gmailAction).toBe('archive');
    expect(plan.digestSection).toBe('calendar');
  });
});
