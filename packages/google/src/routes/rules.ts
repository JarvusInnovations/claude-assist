/**
 * Rules + Topics Routes
 *
 * CRUD + bulk import for triage rules and topics of interest. Restored from the
 * deleted design (eb5369c8^:packages/google/src/routes/rules.ts), modernized to
 * today's types (digest_section / assigned_domain are free VARCHARs now).
 */

import type { FastifyPluginAsync } from 'fastify';
import type postgres from 'postgres';
import type { Scheduler } from '@jarvus/claude-assist-core';
import type {
  TriageRule,
  TopicOfInterest,
  CreateRulePayload,
  CreateTopicPayload,
} from '../types.js';

declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
  }
}

export const registerRuleRoutes: FastifyPluginAsync = async (fastify) => {
  // ---- Triage rules --------------------------------------------------------

  fastify.get<{ Params: { id: string } }>(
    '/google/accounts/:id/rules',
    async (request) => {
      const accountId = parseInt(request.params.id, 10);
      return fastify.sql<TriageRule[]>`
        SELECT * FROM google.triage_rules
        WHERE account_id = ${accountId}
        ORDER BY priority DESC, created_at ASC
      `;
    }
  );

  fastify.post<{ Params: { id: string }; Body: CreateRulePayload }>(
    '/google/accounts/:id/rules',
    async (request, reply) => {
      const accountId = parseInt(request.params.id, 10);
      const r = request.body;
      try {
        const [rule] = await fastify.sql<TriageRule[]>`
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
          RETURNING *
        `;
        return rule;
      } catch (error) {
        if (error instanceof Error && error.message.includes('unique constraint')) {
          return reply.status(409).send({ error: 'Rule ID already exists' });
        }
        throw error;
      }
    }
  );

  fastify.patch<{ Params: { ruleId: string }; Body: Partial<CreateRulePayload> }>(
    '/google/rules/:ruleId',
    async (request, reply) => {
      const ruleId = parseInt(request.params.ruleId, 10);
      const u = request.body;
      const [rule] = await fastify.sql<TriageRule[]>`
        UPDATE google.triage_rules SET
          name = COALESCE(${u.name ?? null}, name),
          description = COALESCE(${u.description ?? null}, description),
          from_patterns = COALESCE(${u.from_patterns ?? null}, from_patterns),
          subject_contains = COALESCE(${u.subject_contains ?? null}, subject_contains),
          body_contains = COALESCE(${u.body_contains ?? null}, body_contains),
          body_not_contains = COALESCE(${u.body_not_contains ?? null}, body_not_contains),
          action = COALESCE(${u.action ?? null}, action),
          gmail_action = COALESCE(${u.gmail_action ?? null}, gmail_action),
          priority_level = COALESCE(${u.priority_level ?? null}, priority_level),
          digest_section = COALESCE(${u.digest_section ?? null}, digest_section),
          assess_against_topics = COALESCE(${u.assess_against_topics ?? null}, assess_against_topics),
          assigned_domain = COALESCE(${u.assigned_domain ?? null}, assigned_domain),
          assigned_type = COALESCE(${u.assigned_type ?? null}, assigned_type),
          skip_ai_triage = COALESCE(${u.skip_ai_triage ?? null}, skip_ai_triage),
          enabled = COALESCE(${u.enabled ?? null}, enabled),
          priority = COALESCE(${u.priority ?? null}, priority),
          notes = COALESCE(${u.notes ?? null}, notes)
        WHERE id = ${ruleId}
        RETURNING *
      `;
      if (!rule) return reply.status(404).send({ error: 'Rule not found' });
      return rule;
    }
  );

  fastify.delete<{ Params: { ruleId: string } }>(
    '/google/rules/:ruleId',
    async (request, reply) => {
      const ruleId = parseInt(request.params.ruleId, 10);
      const result = await fastify.sql`
        DELETE FROM google.triage_rules WHERE id = ${ruleId}
      `;
      if (result.count === 0) return reply.status(404).send({ error: 'Rule not found' });
      return { success: true };
    }
  );

  fastify.post<{ Params: { id: string }; Body: { rules: CreateRulePayload[] } }>(
    '/google/accounts/:id/rules/import',
    async (request) => {
      const accountId = parseInt(request.params.id, 10);
      const { rules } = request.body;
      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];
      for (const r of rules) {
        try {
          const rows = await fastify.sql`
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
          if (rows.length > 0) imported++;
          else skipped++;
        } catch (error) {
          skipped++;
          errors.push(`${r.rule_id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { imported, skipped, errors };
    }
  );

  // ---- Topics of interest --------------------------------------------------

  fastify.get<{ Params: { id: string } }>(
    '/google/accounts/:id/topics',
    async (request) => {
      const accountId = parseInt(request.params.id, 10);
      return fastify.sql<TopicOfInterest[]>`
        SELECT * FROM google.topics_of_interest
        WHERE account_id = ${accountId}
        ORDER BY topic_type, value
      `;
    }
  );

  fastify.post<{ Params: { id: string }; Body: CreateTopicPayload }>(
    '/google/accounts/:id/topics',
    async (request) => {
      const accountId = parseInt(request.params.id, 10);
      const t = request.body;
      const [topic] = await fastify.sql<TopicOfInterest[]>`
        INSERT INTO google.topics_of_interest (
          account_id, topic_type, value, description, enabled
        ) VALUES (
          ${accountId}, ${t.topic_type}, ${t.value}, ${t.description ?? null}, ${t.enabled ?? true}
        )
        ON CONFLICT (account_id, topic_type, value) DO NOTHING
        RETURNING *
      `;
      return topic ?? { skipped: true };
    }
  );

  fastify.delete<{ Params: { topicId: string } }>(
    '/google/topics/:topicId',
    async (request, reply) => {
      const topicId = parseInt(request.params.topicId, 10);
      const result = await fastify.sql`
        DELETE FROM google.topics_of_interest WHERE id = ${topicId}
      `;
      if (result.count === 0) return reply.status(404).send({ error: 'Topic not found' });
      return { success: true };
    }
  );
};
