import { spawn } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Event hand-off (specs/modules/chat.md § Event hand-off).
 *
 * Slack events that are not the owner's direct messages are passed, one JSON
 * object per event on stdin, to an external command — no agent run — so
 * another consumer can act on them while this module keeps the app's only
 * Socket Mode connection.
 */

export const HANDOFF_EVENT_KINDS = ['app_mention', 'message', 'reaction_added'] as const;
export type HandoffEventKind = (typeof HANDOFF_EVENT_KINDS)[number];
export type HandoffAuthors = 'owner' | 'any';

export const DEFAULT_HANDOFF_TIMEOUT_MS = 10_000;

/** Channel types whose messages may be handed off. `im` never is. */
const HANDOFF_CHANNEL_TYPES = new Set(['channel', 'group', 'mpim']);

/** Message subtypes that are a post someone made, not an edit or system event. */
const HANDOFF_MESSAGE_SUBTYPES = new Set([undefined, 'file_share', 'thread_broadcast', 'bot_message']);

/** How many event ids to remember for retry de-duplication. */
const SEEN_EVENT_IDS_MAX = 1000;

export interface HandoffConfig {
  /** argv of the command; run without a shell. */
  command: string[];
  /** Event kinds to hand off. */
  events: HandoffEventKind[];
  /** `owner` (default) or `any`. */
  authors: HandoffAuthors;
  /** Kill a run after this long. */
  timeoutMs: number;
}

/** Envelope facts Bolt gives the listener alongside the event. */
export interface HandoffEnvelope {
  eventId?: string;
  teamId?: string;
}

/** The bot's own identity (from Bolt's context, filled by auth.test). */
export interface BotIdentity {
  botUserId?: string;
  botId?: string;
}

export interface HandoffPayload {
  type: string;
  channel: string | null;
  channel_type: string | null;
  user: string | null;
  ts: string | null;
  thread_ts: string | null;
  text: string | null;
  event_ts: string | null;
  team: string | null;
  is_owner: boolean;
  is_self: boolean;
  raw: unknown;
}

/** Loose view of the Slack event fields the hand-off reads. */
export interface SlackEventLike {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  ts?: string;
  thread_ts?: string;
  text?: string;
  event_ts?: string;
  team?: string;
  item?: { type?: string; channel?: string; ts?: string; channel_type?: string };
}

export interface HandoffStats {
  handedOff: number;
  failed: number;
  consecutiveFailures: number;
}

/** Runs the command with `input` on stdin. Rejects on non-zero exit, timeout, or spawn error. */
export type HandoffRunner = (command: string[], input: string, timeoutMs: number) => Promise<void>;

/**
 * Parse `CHAT_HANDOFF_EVENTS` (comma-separated). Unset → every kind. Unknown
 * kinds are reported through `onUnknown` and dropped.
 */
export function parseHandoffEvents(
  raw: string | undefined,
  onUnknown?: (kind: string) => void,
): HandoffEventKind[] {
  if (!raw || !raw.trim()) return [...HANDOFF_EVENT_KINDS];
  const kinds: HandoffEventKind[] = [];
  for (const part of raw.split(',')) {
    const kind = part.trim();
    if (!kind) continue;
    if ((HANDOFF_EVENT_KINDS as readonly string[]).includes(kind)) {
      if (!kinds.includes(kind as HandoffEventKind)) kinds.push(kind as HandoffEventKind);
    } else {
      onUnknown?.(kind);
    }
  }
  return kinds;
}

/**
 * Parse `CHAT_HANDOFF_AUTHORS`. Unset → `owner`. Anything other than `owner`
 * or `any` is reported through `onUnknown` and falls back to `owner`, the
 * narrower setting.
 */
export function parseHandoffAuthors(
  raw: string | undefined,
  onUnknown?: (value: string) => void,
): HandoffAuthors {
  const value = raw?.trim();
  if (!value || value === 'owner') return 'owner';
  if (value === 'any') return 'any';
  onUnknown?.(value);
  return 'owner';
}

/**
 * Decide whether an event is handed off and, if so, build its payload.
 * Pure — the whole selection rule lives here.
 */
export function selectHandoff(
  kind: HandoffEventKind,
  event: SlackEventLike,
  opts: { config: HandoffConfig; ownerUserId: string; self: BotIdentity; envelope: HandoffEnvelope },
): HandoffPayload | null {
  const { config, ownerUserId, self, envelope } = opts;
  if (!config.events.includes(kind)) return null;

  const isSelf =
    (self.botUserId !== undefined && event.user === self.botUserId) ||
    (self.botId !== undefined && event.bot_id === self.botId);
  const isOwner = event.user !== undefined && event.user === ownerUserId;
  const isOtherBot = !isSelf && event.bot_id !== undefined;

  let channel: string | undefined;
  let channelType: string | undefined;
  let ts: string | undefined;
  let threadTs: string | undefined;
  let text: string | undefined;

  switch (kind) {
    case 'message':
      if (!event.channel_type || !HANDOFF_CHANNEL_TYPES.has(event.channel_type)) return null;
      if (!HANDOFF_MESSAGE_SUBTYPES.has(event.subtype)) return null;
      channel = event.channel;
      channelType = event.channel_type;
      ts = event.ts;
      threadTs = event.thread_ts;
      text = event.text;
      break;
    case 'app_mention':
      channel = event.channel;
      channelType = event.channel_type;
      ts = event.ts;
      threadTs = event.thread_ts;
      text = event.text;
      break;
    case 'reaction_added':
      // The bot's own reactions are its status markers (thinking_face, …).
      if (isSelf) return null;
      channel = event.item?.channel;
      channelType = event.item?.channel_type;
      ts = event.item?.ts;
      break;
  }

  // `owner`: the owner's events plus the bot's own posts (a consumer needs its
  // own top-level posts to know which threads it started); other bots never.
  // `any`: every author, other bots included.
  if (config.authors === 'owner') {
    const selfMessage = isSelf && kind === 'message';
    if (isOtherBot || (!isOwner && !selfMessage)) return null;
  }

  return {
    type: kind,
    channel: channel ?? null,
    channel_type: channelType ?? null,
    user: event.user ?? null,
    ts: ts ?? null,
    thread_ts: threadTs ?? null,
    text: text ?? null,
    event_ts: event.event_ts ?? null,
    team: event.team ?? envelope.teamId ?? null,
    is_owner: isOwner,
    is_self: isSelf,
    raw: event,
  };
}

/** Default runner: spawn without a shell, write stdin, enforce the timeout. */
export const spawnRunner: HandoffRunner = (command, input, timeoutMs) =>
  new Promise<void>((resolve, reject) => {
    const [file, ...args] = command;
    if (!file) {
      reject(new Error('empty command'));
      return;
    }
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { stdio: ['pipe', 'ignore', 'pipe'], shell: false });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 500) stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => finish(err));
    child.on('close', (code, signal) => {
      if (code === 0) finish();
      else {
        const detail = stderr.trim().replace(/\s+/g, ' ').slice(0, 200);
        finish(new Error(`exited with ${code ?? signal}${detail ? `: ${detail}` : ''}`));
      }
    });
    // A command that exits without reading stdin closes the pipe; that is its business.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });

export interface Handoff {
  /**
   * Hand off one event if it qualifies. Never throws: failures are logged and
   * counted. Resolves once the run finished (or was skipped).
   */
  dispatch(kind: HandoffEventKind, event: SlackEventLike, envelope: HandoffEnvelope, self: BotIdentity): Promise<void>;
  stats(): HandoffStats;
}

export function createHandoff(opts: {
  config: HandoffConfig;
  ownerUserId: string;
  log: Pick<FastifyBaseLogger, 'info' | 'error' | 'debug'>;
  runner?: HandoffRunner;
}): Handoff {
  const { config, ownerUserId, log } = opts;
  const runner = opts.runner ?? spawnRunner;
  const seen = new Set<string>();
  const counts: HandoffStats = { handedOff: 0, failed: 0, consecutiveFailures: 0 };

  function remember(eventId: string): boolean {
    if (seen.has(eventId)) return false;
    seen.add(eventId);
    if (seen.size > SEEN_EVENT_IDS_MAX) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  }

  return {
    async dispatch(kind, event, envelope, self) {
      try {
        const payload = selectHandoff(kind, event, { config, ownerUserId, self, envelope });
        if (!payload) return;
        // Dedupe on the Slack event id; without one, fall back to type+channel+ts.
        const key = envelope.eventId ?? `${kind}:${payload.channel}:${payload.ts}:${event.event_ts}`;
        if (!remember(key)) {
          log.debug({ eventId: envelope.eventId, type: kind }, 'Slack hand-off: duplicate event skipped');
          return;
        }
        try {
          await runner(config.command, JSON.stringify(payload) + '\n', config.timeoutMs);
          counts.handedOff += 1;
          counts.consecutiveFailures = 0;
        } catch (err) {
          counts.failed += 1;
          counts.consecutiveFailures += 1;
          log.error(
            {
              eventId: envelope.eventId,
              type: kind,
              reason: err instanceof Error ? err.message : String(err),
              handoff: { ...counts },
            },
            'Slack event hand-off failed',
          );
        }
      } catch (err) {
        // Defensive: nothing in the hand-off may reach the listener.
        counts.failed += 1;
        counts.consecutiveFailures += 1;
        log.error({ eventId: envelope.eventId, type: kind, err, handoff: { ...counts } }, 'Slack event hand-off failed');
      }
    },
    stats() {
      return { ...counts };
    },
  };
}
