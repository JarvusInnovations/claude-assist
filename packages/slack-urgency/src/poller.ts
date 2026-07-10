/**
 * Ingestion — a poll loop that reads Chris's incoming Slack AS CHRIS.
 *
 * Why polling, not the bot socket: the chat bot's socket only receives
 * events for conversations the *bot* belongs to (its own DMs, its @mentions,
 * channels it was invited to). It never sees Chris's personal DMs from
 * teammates or @mentions of Chris the person. So urgency ingestion runs on a
 * user token (the same token the `slack-axi` CLI stores) via the Slack Web API,
 * which reads exactly what Chris sees.
 *
 * Rate-limit posture: per-conversation cursors make every poll incremental —
 * we only ask for messages newer than the last ts we saw. Calls are issued
 * sequentially (natural pacing) and DM enumeration is cached across cycles.
 * See the reader implementation and the PR body for the tier budget.
 *
 * READ-ONLY: this module calls only conversations.list / conversations.history
 * / conversations.replies / users.info / chat.getPermalink. It never posts,
 * reacts, or marks anything read.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { ChannelType, SlackCandidate } from './types.js';
import type { EvalContext, UrgencyPipeline } from './pipeline.js';
import type { UrgencyStore } from './store.js';
import type { ThreadContextLine } from './classifier.js';

/** A raw Slack message as the reader surfaces it (only fields we use). */
export interface RawSlackMessage {
  ts: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

export interface Conversation {
  id: string;
  type: ChannelType;
}

/**
 * The Slack read surface, abstracted so the poll loop is testable without a
 * live workspace. `history` returns messages strictly newer than `oldestTs`
 * (exclusive), ascending by ts.
 */
export interface SlackReader {
  listDmConversations(): Promise<Conversation[]>;
  history(channel: string, oldestTs: string | null, limit: number): Promise<RawSlackMessage[]>;
  permalink(channel: string, ts: string): Promise<string | null>;
  userName(userId: string): Promise<string | null>;
}

export interface PollerConfig {
  ownerId: string;
  /** Channel ids to watch beyond Chris's DMs (a small, deliberate list). */
  watchChannels: string[];
  /** Max messages pulled per conversation per cycle (bounds a burst). */
  historyLimit?: number;
  /** Preceding thread lines handed to the model. */
  contextLines?: number;
}

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_CONTEXT_LINES = 4;

/**
 * Build the candidate + evaluation context list from one conversation's fresh
 * history slice. Pure and testable. Also returns the ts to advance the cursor
 * to (the newest message seen, regardless of whether it produced a candidate).
 *
 * `mentionsOwner` and `ownerRepliedAfter` are derived from the batch: because a
 * poll pulls a window of messages at once, a teammate's ask and Chris's own
 * later reply usually land in the same slice — so "Chris already handled it" is
 * catchable, killing the most annoying false positive.
 */
export function buildCandidates(
  messages: RawSlackMessage[],
  conv: Conversation,
  ownerId: string,
  contextLines: number
): { items: Array<{ candidate: SlackCandidate; ctx: EvalContext }>; newestTs: string | null } {
  const ascending = [...messages].sort((a, b) => Number(a.ts) - Number(b.ts));
  const newestTs = ascending.length > 0 ? ascending[ascending.length - 1]!.ts : null;
  const mentionToken = `<@${ownerId}>`;
  const isDm = conv.type === 'im' || conv.type === 'mpim';

  const items: Array<{ candidate: SlackCandidate; ctx: EvalContext }> = [];

  for (let i = 0; i < ascending.length; i++) {
    const m = ascending[i]!;
    const text = m.text ?? '';
    const isBot = Boolean(m.bot_id) || m.subtype === 'bot_message';
    const sender = m.user ?? '';

    // Skip Chris's own messages and bots as *candidates* — but they still count
    // as context and as "owner replied after".
    if (!sender || sender === ownerId || isBot) continue;

    const threadKey = m.thread_ts ?? m.ts;

    // Did Chris send a later message in the same thread within this slice?
    const ownerRepliedAfter = ascending
      .slice(i + 1)
      .some((later) => later.user === ownerId && (later.thread_ts ?? later.ts) === threadKey);

    // Preceding lines in the same thread → model context.
    const threadContext: ThreadContextLine[] = ascending
      .slice(0, i)
      .filter((prev) => (prev.thread_ts ?? prev.ts) === threadKey && (prev.text ?? '').trim())
      .slice(-contextLines)
      .map((prev) => ({
        who: prev.user === ownerId ? 'Chris' : (prev.user ?? 'someone'),
        text: prev.text ?? '',
      }));

    const candidate: SlackCandidate = {
      channel: conv.id,
      ts: m.ts,
      threadTs: m.thread_ts ?? null,
      channelType: conv.type,
      sender,
      senderName: null,
      text,
      isBot: false,
    };
    const ctx: EvalContext = {
      isDirectMessage: isDm,
      mentionsOwner: text.includes(mentionToken),
      ownerRepliedAfter,
      threadContext,
    };
    items.push({ candidate, ctx });
  }

  return { items, newestTs };
}

export class UrgencyPoller {
  private historyLimit: number;
  private contextLines: number;
  private dmCache: Conversation[] | null = null;
  private running = false;

  constructor(
    private reader: SlackReader,
    private pipeline: UrgencyPipeline,
    private store: UrgencyStore,
    private log: FastifyBaseLogger,
    private config: PollerConfig
  ) {
    this.historyLimit = config.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.contextLines = config.contextLines ?? DEFAULT_CONTEXT_LINES;
  }

  /** One poll cycle over every DM + watched channel. Returns messages processed. */
  async pollOnce(now = new Date()): Promise<{ processed: number; interrupts: number }> {
    if (this.running) {
      this.log.info('Slack urgency poll already in progress - skipping');
      return { processed: 0, interrupts: 0 };
    }
    this.running = true;
    try {
      const conversations = await this.conversationsToPoll();
      let processed = 0;
      let interrupts = 0;

      for (const conv of conversations) {
        try {
          const result = await this.pollConversation(conv, now);
          processed += result.processed;
          interrupts += result.interrupts;
        } catch (err) {
          // A single bad conversation (e.g. lost access) must not sink the cycle.
          this.log.warn({ conv: conv.id, err }, 'Slack urgency: conversation poll failed');
        }
      }
      return { processed, interrupts };
    } finally {
      this.running = false;
    }
  }

  private async conversationsToPoll(): Promise<Conversation[]> {
    if (!this.dmCache) {
      this.dmCache = await this.reader.listDmConversations();
    }
    const watch: Conversation[] = this.config.watchChannels.map((id) => ({
      id,
      type: 'channel' as ChannelType,
    }));
    // De-dupe in case a watched id is also a DM.
    const seen = new Set<string>();
    const all = [...this.dmCache, ...watch].filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
    return all;
  }

  /** Force a refresh of the DM conversation cache on the next cycle. */
  invalidateDmCache(): void {
    this.dmCache = null;
  }

  private async pollConversation(
    conv: Conversation,
    now: Date
  ): Promise<{ processed: number; interrupts: number }> {
    const cursor = await this.store.getCursor(conv.id);

    // First sight of a conversation: seed the cursor to the newest message and
    // process nothing — no historical backfill, so booting never storms alerts.
    if (cursor === null) {
      const latest = await this.reader.history(conv.id, null, 1);
      const newest = latest[0]?.ts;
      await this.store.setCursor(conv.id, newest ?? nowTs(now));
      return { processed: 0, interrupts: 0 };
    }

    const fresh = await this.reader.history(conv.id, cursor, this.historyLimit);
    const { items, newestTs } = buildCandidates(fresh, conv, this.config.ownerId, this.contextLines);

    let interrupts = 0;
    for (const { candidate, ctx } of items) {
      const name = candidate.sender ? await this.reader.userName(candidate.sender) : null;
      const decision = await this.pipeline.process({ ...candidate, senderName: name }, ctx, now);
      if (decision.interrupted) interrupts++;
    }

    if (newestTs) await this.store.setCursor(conv.id, newestTs);
    return { processed: items.length, interrupts };
  }
}

function nowTs(now: Date): string {
  return (now.getTime() / 1000).toFixed(6);
}
