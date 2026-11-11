import { isHandledSubtype } from './attachments.js';
import type { BotIdentity, Handoff, HandoffEnvelope, SlackEventLike } from './handoff.js';

/**
 * Routes each Slack event to exactly one place (specs/modules/chat.md § Who
 * and where): the owner's direct messages to the agent, everything the
 * hand-off accepts to the hand-off command, and the rest nowhere.
 */
export interface EventRouter {
  message(event: SlackEventLike, envelope: HandoffEnvelope, self: BotIdentity): Promise<void>;
  appMention(event: SlackEventLike, envelope: HandoffEnvelope, self: BotIdentity): Promise<void>;
  reactionAdded(event: SlackEventLike, envelope: HandoffEnvelope, self: BotIdentity): Promise<void>;
}

/** An owner's direct message that should start or continue an agent turn. */
export function isOwnerDirectMessage(event: SlackEventLike, ownerUserId: string): boolean {
  if (!isHandledSubtype(event.subtype)) return false;
  if (event.channel_type !== 'im') return false;
  if (event.bot_id) return false;
  if (event.user !== ownerUserId) return false;
  return true;
}

export function createEventRouter<E extends SlackEventLike>(opts: {
  ownerUserId: string;
  handoff: Handoff | null;
  onDirectMessage: (event: E) => Promise<void>;
}): EventRouter {
  const { ownerUserId, handoff, onDirectMessage } = opts;
  return {
    async message(event, envelope, self) {
      if (event.channel_type === 'im') {
        // Direct messages are never handed off: the owner's are answered,
        // anyone else's (and every bot's) are ignored.
        if (isOwnerDirectMessage(event, ownerUserId)) await onDirectMessage(event as E);
        return;
      }
      await handoff?.dispatch('message', event, envelope, self);
    },
    async appMention(event, envelope, self) {
      await handoff?.dispatch('app_mention', event, envelope, self);
    },
    async reactionAdded(event, envelope, self) {
      await handoff?.dispatch('reaction_added', event, envelope, self);
    },
  };
}

/** Pull the envelope facts the hand-off needs out of a Bolt event body. */
export function envelopeFromBody(body: unknown): HandoffEnvelope {
  const b = (body ?? {}) as { event_id?: unknown; team_id?: unknown };
  return {
    ...(typeof b.event_id === 'string' ? { eventId: b.event_id } : {}),
    ...(typeof b.team_id === 'string' ? { teamId: b.team_id } : {}),
  };
}
