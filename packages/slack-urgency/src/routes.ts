/**
 * Slack urgency routes — the one-tap correction path.
 *
 *   POST /api/slack-urgency/:id/correct   { verdict: "should_interrupt" | "should_not" }
 *   GET  /api/slack-urgency/near-misses   digest / review surface
 *   GET  /api/slack-urgency/interrupts    recently fired interrupts (review)
 *
 * A correction nudges per-sender and per-channel weights, which the
 * deterministic core reads to promote/demote future borderline (residue)
 * calls for that sender/channel. Precision drifts and is personal; this plus
 * the near-miss digest are the containment, not classifier perfection.
 *
 * `:id` is the candidate key `"<channel>-<ts>"` (Slack channel ids carry no
 * dash; the ts carries a dot), e.g. `C0ABC123-1720620000.001200`.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { UrgencyStore } from './store.js';

export interface UrgencyRoutesConfig {
  store: UrgencyStore;
  /** Weight nudges per correction. Sender moves more than channel. */
  senderDelta?: number;
  channelDelta?: number;
}

const DEFAULT_SENDER_DELTA = 0.5;
const DEFAULT_CHANNEL_DELTA = 0.25;

interface CorrectBody {
  verdict?: string;
}

/** Split "<channel>-<ts>" on the first dash. */
function parseCandidateId(id: string): { channel: string; ts: string } | null {
  const dash = id.indexOf('-');
  if (dash <= 0 || dash >= id.length - 1) return null;
  return { channel: id.slice(0, dash), ts: id.slice(dash + 1) };
}

export const registerUrgencyRoutes: FastifyPluginAsync<UrgencyRoutesConfig> = async (
  fastify,
  { store, senderDelta = DEFAULT_SENDER_DELTA, channelDelta = DEFAULT_CHANNEL_DELTA }
) => {
  fastify.post<{ Params: { id: string }; Body: CorrectBody }>(
    '/slack-urgency/:id/correct',
    {
      schema: {
        body: {
          type: 'object',
          required: ['verdict'],
          additionalProperties: false,
          properties: {
            verdict: { type: 'string', enum: ['should_interrupt', 'should_not'] },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = parseCandidateId(request.params.id);
      if (!parsed) {
        reply.status(400);
        return { error: 'id must be "<channel>-<ts>"' };
      }

      const candidate = await store.getCandidate(parsed.channel, parsed.ts);
      if (!candidate) {
        reply.status(404);
        return { error: 'Candidate not found' };
      }

      // should_interrupt = this was a false negative → lean toward interrupting
      // this sender/channel next time. should_not = false positive → lean away.
      const sign = request.body.verdict === 'should_interrupt' ? 1 : -1;
      const newSenderWeight = await store.adjustWeight('sender', candidate.sender, sign * senderDelta);
      const newChannelWeight = await store.adjustWeight(
        'channel',
        candidate.channel,
        sign * channelDelta
      );

      return {
        corrected: request.body.verdict,
        sender: candidate.sender,
        channel: candidate.channel,
        sender_weight: newSenderWeight,
        channel_weight: newChannelWeight,
      };
    }
  );

  fastify.get<{ Querystring: { limit?: string } }>(
    '/slack-urgency/near-misses',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'string', pattern: '^[0-9]+$' } },
        },
      },
    },
    async (request) => {
      const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
      const nearMisses = await store.listNearMisses(limit);
      return { near_misses: nearMisses, count: nearMisses.length };
    }
  );

  fastify.get<{ Querystring: { limit?: string } }>(
    '/slack-urgency/interrupts',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'string', pattern: '^[0-9]+$' } },
        },
      },
    },
    async (request) => {
      const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
      const interrupts = await store.listInterrupts(limit);
      return { interrupts, count: interrupts.length };
    }
  );
};
