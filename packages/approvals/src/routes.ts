/**
 * HTTP surface for approvals. Same auth posture as the rest of /api.
 *
 *   POST /api/approvals              — raise a gate (returns immediately)
 *   GET  /api/approvals              — list, filterable by status and kind
 *   GET  /api/approvals/:id          — read one
 *   POST /api/approvals/:id/resolve  — approve or deny
 */

import type { FastifyPluginAsync } from 'fastify';
import {
  ApprovalConflictError,
  type ApprovalService,
  type ApprovalStatus,
} from '@jarvus/claude-assist-core';

export interface ApprovalRoutesConfig {
  service: ApprovalService;
}

const STATUSES: ApprovalStatus[] = ['pending', 'approved', 'denied', 'expired', 'cancelled'];

export const registerApprovalRoutes: FastifyPluginAsync<ApprovalRoutesConfig> = async (
  fastify,
  { service },
) => {
  fastify.get<{ Querystring: { status?: ApprovalStatus; kind?: string; limit?: string } }>(
    '/approvals',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: STATUSES },
            kind: { type: 'string' },
            limit: { type: 'string', pattern: '^[0-9]+$' },
          },
        },
      },
    },
    async (request) => {
      const { status, kind, limit } = request.query;
      const approvals = await service.list({
        status,
        kind,
        limit: limit ? parseInt(limit, 10) : undefined,
      });
      return { approvals, count: approvals.length };
    },
  );

  fastify.get<{ Params: { id: string } }>('/approvals/:id', async (request, reply) => {
    const record = await service.get(request.params.id);
    if (!record) return reply.code(404).send({ error: 'Approval not found' });
    return record;
  });

  fastify.post<{
    Body: {
      kind: string;
      requestedBy: string;
      title: string;
      body: string;
      payload?: Record<string, unknown>;
      dedupeKey?: string;
      expiresInMs?: number;
      priority?: 'interrupt' | 'notice' | 'digest';
      url?: string;
    };
  }>(
    '/approvals',
    {
      schema: {
        body: {
          type: 'object',
          required: ['kind', 'requestedBy', 'title', 'body'],
          additionalProperties: false,
          properties: {
            kind: { type: 'string', minLength: 1 },
            requestedBy: { type: 'string', minLength: 1 },
            title: { type: 'string', minLength: 1 },
            body: { type: 'string' },
            payload: { type: 'object' },
            dedupeKey: { type: 'string' },
            expiresInMs: { type: 'integer', minimum: 1000 },
            priority: { type: 'string', enum: ['interrupt', 'notice', 'digest'] },
            url: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const record = await service.request(request.body);
      return reply.code(201).send(record);
    },
  );

  fastify.post<{
    Params: { id: string };
    Body: { decision: 'approved' | 'denied'; note?: string; params?: Record<string, unknown>; resolvedBy?: string };
  }>(
    '/approvals/:id/resolve',
    {
      schema: {
        body: {
          type: 'object',
          required: ['decision'],
          additionalProperties: false,
          properties: {
            decision: { type: 'string', enum: ['approved', 'denied'] },
            note: { type: 'string' },
            params: { type: 'object' },
            resolvedBy: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { decision, note, params, resolvedBy } = request.body;
      try {
        return await service.resolve(
          request.params.id,
          { decision, ...(note ? { note } : {}), ...(params ? { params } : {}) },
          resolvedBy,
        );
      } catch (err) {
        if (err instanceof ApprovalConflictError) {
          // 409, never a silent overwrite: a request that is already resolved
          // or expired has an answer, and reporting success would invent a
          // second one.
          return reply.code(409).send({ error: err.message, status: err.status });
        }
        throw err;
      }
    },
  );
};
