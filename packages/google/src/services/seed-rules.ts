/**
 * Bootstrap seed content for the deterministic triage rules + topics of
 * interest.
 *
 * The database (`google.triage_rules` / `google.topics_of_interest`) is the
 * source of truth — rules and topics are edited there via the API and survive
 * restarts. This module only handles first-boot bootstrapping so a fresh
 * instance has something sensible to demonstrate the feature.
 *
 * Two sources, in precedence order:
 *   1. `GOOGLE_TRIAGE_SEED_FILE` — if set, a JSON file of the shape
 *      `{ "rules": CreateRulePayload[], "topics": CreateTopicPayload[] }` is
 *      loaded and used as the seed. This is how an operator ships their own
 *      instance-specific ruleset without baking it into the codebase.
 *   2. Otherwise the built-in EXAMPLE_TRIAGE_RULES / EXAMPLE_TOPICS below are
 *      used. These are deliberately generic placeholders — replace them via the
 *      rules API or by pointing GOOGLE_TRIAGE_SEED_FILE at your own file.
 *
 * Seeding is idempotent per account (ON CONFLICT DO NOTHING keyed on
 * account_id + rule_id / value), so hand-edits and rules added via the API are
 * never clobbered, and re-seeding on every boot is a no-op once rows exist.
 *
 * `priority` is set descending in source order so rules evaluate in that order
 * (higher priority evaluates first — first match wins).
 */

import { readFileSync } from 'node:fs';
import type postgres from 'postgres';
import type { CreateRulePayload, CreateTopicPayload } from '../types.js';

/** Parsed contents of a seed file (or the built-in examples). */
export interface SeedContent {
  rules: CreateRulePayload[];
  topics: CreateTopicPayload[];
}

/**
 * Generic EXAMPLE rules. These are NOT tuned for any particular inbox — they
 * exist to show the shape of a rule and give a fresh instance a harmless
 * starting point. Replace them via the rules API or GOOGLE_TRIAGE_SEED_FILE.
 */
export const EXAMPLE_TRIAGE_RULES: CreateRulePayload[] = [
  {
    // Purely mechanical: calendar invitation emails get archived and flagged
    // for the calendar digest, skipping AI triage entirely.
    rule_id: 'example-calendar-invitations',
    name: 'Example — Calendar Invitations',
    from_patterns: ['calendar.google.com'],
    subject_contains: ['invitation:', 'updated invitation', 'invitation with note'],
    action: 'archive',
    gmail_action: 'archive',
    priority_level: 'low',
    digest_section: 'calendar',
    skip_ai_triage: true,
    priority: 100,
    notes: 'EXAMPLE rule — replace with your own. Archives calendar invitations.',
  },
  {
    // Runs newsletters through AI relevance analysis against topics of interest:
    // archived if irrelevant, left in the inbox with a review tag if relevant.
    rule_id: 'example-newsletters',
    name: 'Example — Newsletters',
    from_patterns: ['*newsletter*', '*@substack.com'],
    subject_contains: ['newsletter', 'digest', 'weekly'],
    action: 'analyze_relevance',
    priority_level: 'low',
    digest_section: 'newsletters',
    assess_against_topics: true,
    priority: 90,
    notes: 'EXAMPLE rule — replace with your own. Analyzes newsletters against your topics of interest.',
  },
  {
    // Catches bulk marketing (anything with an unsubscribe footer) and leaves it
    // in the inbox for you to decide whether to keep or unsubscribe.
    rule_id: 'example-bulk-marketing',
    name: 'Example — Bulk Marketing',
    body_contains: ['unsubscribe', 'manage preferences'],
    action: 'leave',
    priority_level: 'low',
    digest_section: 'newsletters',
    priority: 10,
    notes: 'EXAMPLE rule — replace with your own. Flags bulk marketing for a keep/unsubscribe decision.',
  },
];

/**
 * Generic EXAMPLE topics of interest. `keyword` topics mark relevant subjects;
 * `exclude` topics mark subjects to filter out. Replace with your own.
 */
export const EXAMPLE_TOPICS: CreateTopicPayload[] = [
  { topic_type: 'keyword', value: 'open data' },
  { topic_type: 'keyword', value: 'data analytics' },
  { topic_type: 'keyword', value: 'API' },
  { topic_type: 'exclude', value: 'webinar invitation' },
];

/** The built-in example seed used when GOOGLE_TRIAGE_SEED_FILE is unset. */
export const EXAMPLE_SEED_CONTENT: SeedContent = {
  rules: EXAMPLE_TRIAGE_RULES,
  topics: EXAMPLE_TOPICS,
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Validate a parsed seed object into a SeedContent. Throws with a descriptive
 * message when the shape is wrong so a bad seed file is loud rather than
 * silently ignored. Only the required fields are checked strictly; optional
 * fields are passed through as-is and validated by the DB insert.
 */
export function validateSeedContent(parsed: unknown, source: string): SeedContent {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Seed file ${source} must be a JSON object with "rules" and "topics" arrays`);
  }
  const obj = parsed as Record<string, unknown>;
  const rawRules = obj.rules ?? [];
  const rawTopics = obj.topics ?? [];
  if (!Array.isArray(rawRules)) {
    throw new Error(`Seed file ${source}: "rules" must be an array`);
  }
  if (!Array.isArray(rawTopics)) {
    throw new Error(`Seed file ${source}: "topics" must be an array`);
  }

  const rules = rawRules.map((r, i): CreateRulePayload => {
    if (typeof r !== 'object' || r === null) {
      throw new Error(`Seed file ${source}: rules[${i}] must be an object`);
    }
    const rule = r as Record<string, unknown>;
    if (!isNonEmptyString(rule.rule_id)) {
      throw new Error(`Seed file ${source}: rules[${i}].rule_id is required`);
    }
    if (!isNonEmptyString(rule.name)) {
      throw new Error(`Seed file ${source}: rules[${i}].name is required`);
    }
    if (!isNonEmptyString(rule.action)) {
      throw new Error(`Seed file ${source}: rules[${i}].action is required`);
    }
    return rule as unknown as CreateRulePayload;
  });

  const topics = rawTopics.map((t, i): CreateTopicPayload => {
    if (typeof t !== 'object' || t === null) {
      throw new Error(`Seed file ${source}: topics[${i}] must be an object`);
    }
    const topic = t as Record<string, unknown>;
    if (!isNonEmptyString(topic.topic_type)) {
      throw new Error(`Seed file ${source}: topics[${i}].topic_type is required`);
    }
    if (!isNonEmptyString(topic.value)) {
      throw new Error(`Seed file ${source}: topics[${i}].value is required`);
    }
    return topic as unknown as CreateTopicPayload;
  });

  return { rules, topics };
}

/** Load + validate a seed file from disk. Throws on read/parse/shape errors. */
export function loadSeedFile(path: string): SeedContent {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read GOOGLE_TRIAGE_SEED_FILE at ${path}: ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`GOOGLE_TRIAGE_SEED_FILE at ${path} is not valid JSON: ${message}`);
  }
  return validateSeedContent(parsed, path);
}

/**
 * Resolve the seed content to use for bootstrapping: the file at
 * `seedFilePath` when provided, otherwise the built-in generic examples.
 * A no-op-friendly helper — when `seedFilePath` is undefined/empty it simply
 * returns the examples.
 */
export function resolveSeedContent(seedFilePath?: string): SeedContent {
  if (!seedFilePath) return EXAMPLE_SEED_CONTENT;
  return loadSeedFile(seedFilePath);
}

/**
 * Idempotently seed the given rules + topics for one account. Safe to call on
 * every startup; existing rows (by account_id + rule_id / value) are preserved.
 * Returns how many rules and topics were newly inserted.
 */
export async function seedAccountRules(
  sql: postgres.Sql,
  accountId: number,
  content: SeedContent = EXAMPLE_SEED_CONTENT
): Promise<{ rulesInserted: number; topicsInserted: number }> {
  let rulesInserted = 0;
  for (const r of content.rules) {
    const rows = await sql`
      INSERT INTO google.triage_rules (
        account_id, rule_id, name, description,
        from_patterns, subject_contains, body_contains, body_not_contains,
        action, gmail_action, priority_level,
        digest_section, assess_against_topics, assigned_domain, assigned_type,
        skip_ai_triage, enabled, priority, notes
      ) VALUES (
        ${accountId}, ${r.rule_id}, ${r.name}, ${r.description ?? null},
        ${r.from_patterns ?? null}, ${r.subject_contains ?? null},
        ${r.body_contains ?? null}, ${r.body_not_contains ?? null},
        ${r.action}, ${r.gmail_action ?? null}, ${r.priority_level ?? null},
        ${r.digest_section ?? null}, ${r.assess_against_topics ?? false},
        ${r.assigned_domain ?? null}, ${r.assigned_type ?? null},
        ${r.skip_ai_triage ?? false}, ${r.enabled ?? true},
        ${r.priority ?? 0}, ${r.notes ?? null}
      )
      ON CONFLICT (account_id, rule_id) DO NOTHING
      RETURNING id
    `;
    rulesInserted += rows.length;
  }

  let topicsInserted = 0;
  for (const t of content.topics) {
    const rows = await sql`
      INSERT INTO google.topics_of_interest (
        account_id, topic_type, value, description, enabled
      ) VALUES (
        ${accountId}, ${t.topic_type}, ${t.value}, ${t.description ?? null}, ${t.enabled ?? true}
      )
      ON CONFLICT (account_id, topic_type, value) DO NOTHING
      RETURNING id
    `;
    topicsInserted += rows.length;
  }

  return { rulesInserted, topicsInserted };
}
