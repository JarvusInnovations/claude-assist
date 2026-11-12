/**
 * POST /api/screen — see `specs/modules/screen.md`.
 *
 * The route answers `200` with the verdict JSON, or a non-2xx error envelope
 * that never carries a verdict. Nothing of the draft, policy, passage or
 * reason is logged: one line per request with the draft's hash, the class,
 * the verdict or failure code, and the spend.
 */

import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ModelInvoker } from '@jarvus/claude-assist-core';
import { LIMITS, ScreenError, hashDraft, runScreen, validateRequest } from './screen.js';

export interface ScreenRoutesConfig {
  invoker: ModelInvoker;
  /** Shared bearer token every request must present. */
  token: string;
  /** Overrides the per-attempt model timeout (tests). */
  timeoutMs?: number;
}

/** Constant-time compare over digests, so length differences don't leak either. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

function sendError(reply: FastifyReply, err: ScreenError) {
  return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
}

export const registerScreenRoutes: FastifyPluginAsync<ScreenRoutesConfig> = async (fastify, config) => {
  if (!config.token) throw new Error('screen routes require a token');

  fastify.post(
    '/screen',
    {
      // Before the body is even parsed: an unauthenticated caller costs nothing.
      // Callback style, replying without calling done(), is Fastify's
      // documented early response from a hook.
      onRequest: (request, reply, done) => {
        const presented = bearer(request);
        if (presented === null || !tokenMatches(presented, config.token)) {
          request.log.warn({ screen: { code: 'unauthorized' } }, 'screen: rejected request');
          reply
            .status(401)
            .header('www-authenticate', 'Bearer')
            .send({ error: { code: 'unauthorized', message: 'A valid bearer token is required' } });
          return;
        }
        done();
      },
    },
    async (request, reply) => {
      const startedAt = Date.now();
      let classLabel: string | undefined;
      let draftSha256: string | undefined;
      try {
        const body = request.body as Record<string, unknown> | undefined;
        if (body && typeof body === 'object' && typeof body.draft === 'string') draftSha256 = hashDraft(body.draft);
        if (body && typeof body === 'object' && typeof body.destination_class === 'string') {
          classLabel = body.destination_class.slice(0, LIMITS.destination_class);
        }

        const req = validateRequest(request.body);
        const outcome = await runScreen(config.invoker, req, {
          ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        });

        request.log.info(
          {
            screen: {
              draft_sha256: draftSha256,
              destination_class: classLabel,
              verdict: outcome.verdict.verdict,
              model: outcome.model,
              cost_usd: outcome.costUsd,
              duration_ms: outcome.durationMs,
            },
          },
          'screen: verdict',
        );
        return reply.status(200).send(outcome.verdict);
      } catch (err) {
        const screenErr =
          err instanceof ScreenError
            ? err
            : new ScreenError(502, 'screen_failed', 'Screen failed unexpectedly; no verdict');
        request.log.warn(
          {
            screen: {
              draft_sha256: draftSha256,
              destination_class: classLabel,
              code: screenErr.code,
              duration_ms: Date.now() - startedAt,
            },
          },
          'screen: no verdict',
        );
        return sendError(reply, screenErr);
      }
    },
  );
};
