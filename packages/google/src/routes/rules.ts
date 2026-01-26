/**
 * Rules Routes
 *
 * Endpoints for triage rules and topics of interest management:
 * - CRUD operations for triage rules
 * - CRUD operations for topics of interest
 * - Bulk import endpoints
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

// Ensure module augmentation is applied
declare module 'fastify' {
  interface FastifyInstance {
    sql: postgres.Sql;
    scheduler: Scheduler;
  }
}

export const registerRuleRoutes: FastifyPluginAsync = async (fastify) => {
  // ==========================================
  // Triage Rules
  // ==========================================

  // GET /google/accounts/:id/rules - List rules for account
  fastify.get<{ Params: { id: string } }>(
    '/google/accounts/:id/rules',
    async (request) => {
      const accountId = parseInt(request.params.id, 10);

      const rules = await fastify.sql<TriageRule[]>`
        SELECT * FROM google.triage_rules
        WHERE account_id = ${accountId}
        ORDER BY priority DESC, created_at ASC
      `;

      return rules;
    }
  );

  // POST /google/accounts/:id/rules - Create rule
  fastify.post<{ Params: { id: string }; Body: CreateRulePayload }>(
    '/google/accounts/:id/rules',
    async (request, reply) => {
      const accountId = parseInt(request.params.id, 10);
      const payload = request.body;

      try {
        const [rule] = await fastify.sql<TriageRule[]>`
          INSERT INTO google.triage_rules (
            account_id, rule_id, name, description,
            from_patterns, subject_contains, body_contains, body_not_contains,
            action, gmail_action, priority_level,
            digest_section, assess_against_topics, assigned_domain, assigned_type,
            skip_ai_triage, enabled, priority, notes
          ) VALUES (
            ${accountId},
            ${payload.rule_id},
            ${payload.name},
            ${payload.description ?? null},
            ${payload.from_patterns ?? null},
            ${payload.subject_contains ?? null},
            ${payload.body_contains ?? null},
            ${payload.body_not_contains ?? null},
            ${payload.action},
            ${payload.gmail_action ?? null},
            ${payload.priority_level ?? null},
            ${payload.digest_section ?? null},
            ${payload.assess_against_topics ?? false},
            ${payload.assigned_domain ?? null},
            ${payload.assigned_type ?? null},
            ${payload.skip_ai_triage ?? false},
            ${payload.enabled ?? true},
            ${payload.priority ?? 0},
            ${payload.notes ?? null}
          )
          RETURNING *
        `;
        return rule;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('unique constraint')
        ) {
          return reply.status(409).send({ error: 'Rule ID already exists' });
        }
        throw error;
      }
    }
  );

  // GET /google/rules/:ruleId - Get single rule
  fastify.get<{ Params: { ruleId: string } }>(
    '/google/rules/:ruleId',
    async (request, reply) => {
      const ruleId = parseInt(request.params.ruleId, 10);

      const [rule] = await fastify.sql<TriageRule[]>`
        SELECT * FROM google.triage_rules WHERE id = ${ruleId}
      `;

      if (!rule) {
        return reply.status(404).send({ error: 'Rule not found' });
      }

      return rule;
    }
  );

  // PATCH /google/rules/:ruleId - Update rule
  fastify.patch<{ Params: { ruleId: string }; Body: Partial<CreateRulePayload> }>(
    '/google/rules/:ruleId',
    async (request, reply) => {
      const ruleId = parseInt(request.params.ruleId, 10);
      const updates = request.body;

      const [rule] = await fastify.sql<TriageRule[]>`
        UPDATE google.triage_rules SET
          name = COALESCE(${updates.name ?? null}, name),
          description = COALESCE(${updates.description ?? null}, description),
          from_patterns = COALESCE(${updates.from_patterns ?? null}, from_patterns),
          subject_contains = COALESCE(${updates.subject_contains ?? null}, subject_contains),
          body_contains = COALESCE(${updates.body_contains ?? null}, body_contains),
          body_not_contains = COALESCE(${updates.body_not_contains ?? null}, body_not_contains),
          action = COALESCE(${updates.action ?? null}, action),
          gmail_action = COALESCE(${updates.gmail_action ?? null}, gmail_action),
          priority_level = COALESCE(${updates.priority_level ?? null}, priority_level),
          digest_section = COALESCE(${updates.digest_section ?? null}, digest_section),
          assess_against_topics = COALESCE(${updates.assess_against_topics ?? null}, assess_against_topics),
          assigned_domain = COALESCE(${updates.assigned_domain ?? null}, assigned_domain),
          assigned_type = COALESCE(${updates.assigned_type ?? null}, assigned_type),
          skip_ai_triage = COALESCE(${updates.skip_ai_triage ?? null}, skip_ai_triage),
          enabled = COALESCE(${updates.enabled ?? null}, enabled),
          priority = COALESCE(${updates.priority ?? null}, priority),
          notes = COALESCE(${updates.notes ?? null}, notes)
        WHERE id = ${ruleId}
        RETURNING *
      `;

      if (!rule) {
        return reply.status(404).send({ error: 'Rule not found' });
      }

      return rule;
    }
  );

  // DELETE /google/rules/:ruleId - Delete rule
  fastify.delete<{ Params: { ruleId: string } }>(
    '/google/rules/:ruleId',
    async (request, reply) => {
      const ruleId = parseInt(request.params.ruleId, 10);

      const result = await fastify.sql`
        DELETE FROM google.triage_rules WHERE id = ${ruleId}
      `;

      if (result.count === 0) {
        return reply.status(404).send({ error: 'Rule not found' });
      }

      return { success: true };
    }
  );

  // POST /google/accounts/:id/rules/import - Bulk import rules
  fastify.post<{
    Params: { id: string };
    Body: { rules: CreateRulePayload[] };
  }>('/google/accounts/:id/rules/import', async (request) => {
    const accountId = parseInt(request.params.id, 10);
    const { rules } = request.body;

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const rule of rules) {
      try {
        await fastify.sql`
          INSERT INTO google.triage_rules (
            account_id, rule_id, name, description,
            from_patterns, subject_contains, body_contains, body_not_contains,
            action, gmail_action, priority_level,
            digest_section, assess_against_topics, assigned_domain, assigned_type,
            skip_ai_triage, enabled, priority, notes
          ) VALUES (
            ${accountId},
            ${rule.rule_id},
            ${rule.name},
            ${rule.description ?? null},
            ${rule.from_patterns ?? null},
            ${rule.subject_contains ?? null},
            ${rule.body_contains ?? null},
            ${rule.body_not_contains ?? null},
            ${rule.action},
            ${rule.gmail_action ?? null},
            ${rule.priority_level ?? null},
            ${rule.digest_section ?? null},
            ${rule.assess_against_topics ?? false},
            ${rule.assigned_domain ?? null},
            ${rule.assigned_type ?? null},
            ${rule.skip_ai_triage ?? false},
            ${rule.enabled ?? true},
            ${rule.priority ?? 0},
            ${rule.notes ?? null}
          )
          ON CONFLICT (account_id, rule_id) DO NOTHING
        `;
        imported++;
      } catch (error) {
        skipped++;
        errors.push(`${rule.rule_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { imported, skipped, errors };
  });

  // ==========================================
  // Topics of Interest
  // ==========================================

  // GET /google/accounts/:id/topics - List topics for account
  fastify.get<{ Params: { id: string } }>(
    '/google/accounts/:id/topics',
    async (request) => {
      const accountId = parseInt(request.params.id, 10);

      const topics = await fastify.sql<TopicOfInterest[]>`
        SELECT * FROM google.topics_of_interest
        WHERE account_id = ${accountId}
        ORDER BY topic_type, value
      `;

      return topics;
    }
  );

  // POST /google/accounts/:id/topics - Create topic
  fastify.post<{ Params: { id: string }; Body: CreateTopicPayload }>(
    '/google/accounts/:id/topics',
    async (request) => {
      const accountId = parseInt(request.params.id, 10);
      const payload = request.body;

      const [topic] = await fastify.sql<TopicOfInterest[]>`
        INSERT INTO google.topics_of_interest (
          account_id, topic_type, value, description, enabled
        ) VALUES (
          ${accountId},
          ${payload.topic_type},
          ${payload.value},
          ${payload.description ?? null},
          ${payload.enabled ?? true}
        )
        RETURNING *
      `;

      return topic;
    }
  );

  // DELETE /google/topics/:topicId - Delete topic
  fastify.delete<{ Params: { topicId: string } }>(
    '/google/topics/:topicId',
    async (request, reply) => {
      const topicId = parseInt(request.params.topicId, 10);

      const result = await fastify.sql`
        DELETE FROM google.topics_of_interest WHERE id = ${topicId}
      `;

      if (result.count === 0) {
        return reply.status(404).send({ error: 'Topic not found' });
      }

      return { success: true };
    }
  );

  // PATCH /google/topics/:topicId - Update topic
  fastify.patch<{
    Params: { topicId: string };
    Body: Partial<CreateTopicPayload>;
  }>('/google/topics/:topicId', async (request, reply) => {
    const topicId = parseInt(request.params.topicId, 10);
    const updates = request.body;

    const [topic] = await fastify.sql<TopicOfInterest[]>`
      UPDATE google.topics_of_interest SET
        topic_type = COALESCE(${updates.topic_type ?? null}, topic_type),
        value = COALESCE(${updates.value ?? null}, value),
        description = COALESCE(${updates.description ?? null}, description),
        enabled = COALESCE(${updates.enabled ?? null}, enabled)
      WHERE id = ${topicId}
      RETURNING *
    `;

    if (!topic) {
      return reply.status(404).send({ error: 'Topic not found' });
    }

    return topic;
  });

  // POST /google/accounts/:id/topics/import - Bulk import topics
  fastify.post<{
    Params: { id: string };
    Body: { topics: CreateTopicPayload[] };
  }>('/google/accounts/:id/topics/import', async (request) => {
    const accountId = parseInt(request.params.id, 10);
    const { topics } = request.body;

    let imported = 0;
    const errors: string[] = [];

    for (const topic of topics) {
      try {
        await fastify.sql`
          INSERT INTO google.topics_of_interest (
            account_id, topic_type, value, description, enabled
          ) VALUES (
            ${accountId},
            ${topic.topic_type},
            ${topic.value},
            ${topic.description ?? null},
            ${topic.enabled ?? true}
          )
        `;
        imported++;
      } catch (error) {
        errors.push(
          `${topic.value}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return { imported, errors };
  });
};
