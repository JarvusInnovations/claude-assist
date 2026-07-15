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
 * we only ask for messages newer than the last ts we saw. `conversations.history`
 * calls are issued strictly one at a time (never concurrent) and staggered
 * evenly (+ small jitter) across a configurable cycle window, so a ~20-30
 * conversation watch list never bursts a minute's worth of calls at once — it
 * was doing exactly that before, and production showed the per-token history
 * budget is far tighter than the original Tier-3 (~50/min) assumption. DM
 * enumeration is cached across cycles.
 *
 * Coverage has two legs. The conversation loop above covers DMs + a small
 * watch-channel list; a directed @mention anywhere else in the workspace would
 * be invisible to it, and polling every channel is impossible under rate
 * limits. So each cycle also runs ONE `search.messages` sweep for the owner's
 * @mentions workspace-wide (see sweepMentions) before the conversation loop.
 *
 * READ-ONLY: this module calls only conversations.list / conversations.history
 * / conversations.replies / search.messages / users.info / chat.getPermalink.
 * It never posts, reacts, or marks anything read.
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

/** One `search.messages` match of an owner @mention, normalized. */
export interface MentionHit {
  channel: string;
  channelType: ChannelType;
  ts: string;
  user?: string;
  text?: string;
  bot_id?: string;
  /** Search results carry their own permalink — no extra API call needed. */
  permalink: string | null;
}

/**
 * The Slack read surface, abstracted so the poll loop is testable without a
 * live workspace. `history` returns messages strictly newer than `oldestTs`
 * (exclusive), ascending by ts. `searchMentions` returns the newest @mentions
 * of `ownerId` workspace-wide (first search page only), newest first.
 */
export interface SlackReader {
  listDmConversations(): Promise<Conversation[]>;
  history(channel: string, oldestTs: string | null, limit: number): Promise<RawSlackMessage[]>;
  searchMentions(ownerId: string, count: number): Promise<MentionHit[]>;
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
  /**
   * Target wall-clock time (ms) to sweep every watched conversation once.
   * `conversations.history` calls are spaced evenly across this window
   * (+ jitter) instead of firing back-to-back, so the effective request rate
   * stays conservative regardless of how many DMs + watch channels are live.
   * Default keeps a ~20-30 conversation set to a handful of calls/min.
   */
  cycleIntervalMs?: number;
  /** Max search matches pulled per mention sweep (first page only). */
  mentionSweepCount?: number;
}

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_CONTEXT_LINES = 4;
const DEFAULT_MENTION_SWEEP_COUNT = 50;
/** Synthetic conversation id the mention-sweep cursor is stored under. */
export const MENTION_SWEEP_CURSOR_ID = 'mention-sweep';
/** Full-sweep target: conservative even for Slack's tightened non-Marketplace
 *  history tiers, not just the legacy Tier 3 (~50/min) the module launched with. */
const DEFAULT_CYCLE_INTERVAL_MS = 5 * 60_000;
/** Floor spacing between calls regardless of conversation count, so a small
 *  watch list (or a misconfigured short cycle) can't still burst. */
const MIN_STAGGER_MS = 2_000;
/** ± this fraction of the base stagger, so cycles don't lock into an exact cadence. */
const JITTER_RATIO = 0.2;

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
  private cycleIntervalMs: number;
  private mentionSweepCount: number;
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
    this.cycleIntervalMs = config.cycleIntervalMs ?? DEFAULT_CYCLE_INTERVAL_MS;
    this.mentionSweepCount = config.mentionSweepCount ?? DEFAULT_MENTION_SWEEP_COUNT;
  }

  /**
   * One poll cycle over every DM + watched channel. `conversations.history`
   * calls are issued strictly one at a time, staggered evenly (+ jitter)
   * across `cycleIntervalMs` — a full cycle takes roughly that long by
   * design, so most scheduler ticks land mid-cycle and skip below (routine,
   * not a sign of trouble). Returns messages processed.
   */
  async pollOnce(now = new Date()): Promise<{ processed: number; interrupts: number }> {
    if (this.running) {
      this.log.debug('Slack urgency poll already in progress - skipping');
      return { processed: 0, interrupts: 0 };
    }
    this.running = true;
    try {
      let processed = 0;
      let interrupts = 0;

      // Mention sweep first: it's a single API call covering the whole
      // workspace, so it must not queue behind a stagger sweep that can take
      // minutes. A sweep failure never sinks the conversation cycle.
      try {
        const sweep = await this.sweepMentions(now);
        processed += sweep.processed;
        interrupts += sweep.interrupts;
      } catch (err) {
        this.log.warn({ err }, 'Slack urgency: mention sweep failed');
      }

      const conversations = await this.conversationsToPoll();
      const staggerMs = Math.max(MIN_STAGGER_MS, this.cycleIntervalMs / Math.max(conversations.length, 1));

      for (let i = 0; i < conversations.length; i++) {
        const conv = conversations[i]!;
        if (i > 0) await sleep(staggerMs + jitter(staggerMs));
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

  /**
   * Workspace-wide @mention sweep — the coverage leg for every channel the
   * conversation loop does NOT watch. One `search.messages` call per cycle;
   * its cursor lives in the store under a synthetic conversation id.
   *
   * Rules mirrored from pollConversation:
   *   - First sight (no cursor): seed to the newest mention and process
   *     nothing, so booting never storms alerts with historical mentions.
   *   - Only matches strictly newer than the cursor are processed; the cursor
   *     then advances to the newest ts seen.
   *   - The owner's own messages and bot messages never become candidates.
   *
   * Dedup with the conversation loop: a mention in a DM or watched channel is
   * seen by both legs. Recorded candidates are keyed on (channel, ts), so the
   * sweep skips anything already in the store; anything the sweep records
   * first is folded/overwritten idempotently if the conversation loop
   * re-evaluates it (recordCandidate upserts, thread cooldown blocks a second
   * interrupt).
   */
  async sweepMentions(now = new Date()): Promise<{ processed: number; interrupts: number }> {
    const hits = await this.reader.searchMentions(this.config.ownerId, this.mentionSweepCount);
    const cursor = await this.store.getCursor(MENTION_SWEEP_CURSOR_ID);
    const newestTs = hits.reduce<string | null>(
      (max, h) => (max === null || Number(h.ts) > Number(max) ? h.ts : max),
      null
    );

    if (cursor === null) {
      await this.store.setCursor(MENTION_SWEEP_CURSOR_ID, newestTs ?? nowTs(now));
      return { processed: 0, interrupts: 0 };
    }

    const fresh = hits
      .filter((h) => Number(h.ts) > Number(cursor))
      .sort((a, b) => Number(a.ts) - Number(b.ts));

    let processed = 0;
    let interrupts = 0;
    for (const hit of fresh) {
      if (!hit.user || hit.user === this.config.ownerId || hit.bot_id) continue;
      // Already pipelined by the conversation loop (or a prior sweep).
      if (await this.store.getCandidate(hit.channel, hit.ts)) continue;

      const senderName = await this.reader.userName(hit.user);
      const candidate: SlackCandidate = {
        channel: hit.channel,
        ts: hit.ts,
        threadTs: null,
        channelType: hit.channelType,
        sender: hit.user,
        senderName,
        text: hit.text ?? '',
        isBot: false,
      };
      // Search returns lone matches with no surrounding history, so thread
      // context is empty and ownerRepliedAfter can't be derived here — the
      // pipeline's thread cooldown still folds rapid followups.
      const ctx: EvalContext = {
        isDirectMessage: hit.channelType === 'im' || hit.channelType === 'mpim',
        mentionsOwner: true,
        ownerRepliedAfter: false,
        threadContext: [],
      };
      const decision = await this.pipeline.process(candidate, ctx, now, hit.permalink);
      processed++;
      if (decision.interrupted) interrupts++;
    }

    if (newestTs !== null && Number(newestTs) > Number(cursor)) {
      await this.store.setCursor(MENTION_SWEEP_CURSOR_ID, newestTs);
    }
    return { processed, interrupts };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A random offset in [-base*JITTER_RATIO, +base*JITTER_RATIO]. */
function jitter(base: number): number {
  return (Math.random() * 2 - 1) * JITTER_RATIO * base;
}
