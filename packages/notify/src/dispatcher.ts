/**
 * The single notification dispatcher. Every pipeline delivers through
 * `notify()`; no pipeline grows its own delivery code. Delivery is
 * Pushover-only (the Slack DM digest channel was retired):
 *   interrupt → Pushover high-priority   notice → Pushover normal
 *   digest    → batched, flushed on a schedule into one summarizing Pushover
 *               notice
 * `channelHints` can pin the channel set, but Pushover is the only channel.
 *
 * Every dispatch is logged to notify.notifications. Session-control links are
 * delivered but stored only in redacted form (see redact.ts).
 */

import type { FastifyBaseLogger } from 'fastify';
import type postgres from 'postgres';
import type {
  NotifyDispatcher,
  NotifyInput,
  NotifyResult,
  NotificationChannel,
} from '@jarvus/claude-assist-core';
import type { PushoverChannel } from './channels/pushover.js';
import { hashPayload, redactText, redactUrl } from './redact.js';

export interface DispatcherDeps {
  sql: postgres.Sql;
  log: FastifyBaseLogger;
  pushover: PushoverChannel | null;
}

export interface Dispatcher extends NotifyDispatcher {
  /** Flush batched digest notifications into one Pushover notice. Returns count sent. */
  flushDigest(): Promise<number>;
}

function defaultChannels(input: NotifyInput): NotificationChannel[] {
  if (input.channelHints && input.channelHints.length > 0) {
    return input.channelHints;
  }
  return ['pushover'];
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { sql, log, pushover } = deps;

  async function notify(input: NotifyInput): Promise<NotifyResult> {
    const channels = defaultChannels(input);
    const realUrl = input.url;

    // Hash the real payload; persist only redacted title/body/url.
    const payloadHash = hashPayload({
      priority: input.priority,
      title: input.title,
      body: input.body,
      url: realUrl ?? null,
      urlTitle: input.urlTitle ?? null,
      channels,
    });
    const titleRedacted = redactText(input.title);
    const bodyRedacted = redactText(input.body);
    const urlRedacted = realUrl ? redactUrl(realUrl) : null;

    const deliveredVia: NotificationChannel[] = [];
    const errors: string[] = [];

    // Digest tier batches: log as pending, flushed later by flushDigest().
    const batched = input.priority === 'digest';

    if (!batched) {
      for (const ch of channels) {
        try {
          if (ch === 'pushover') {
            if (!pushover) throw new Error('pushover channel not configured');
            await pushover.send({
              title: input.title,
              message: input.body,
              url: realUrl,
              urlTitle: input.urlTitle,
              priority: input.priority === 'interrupt' ? 1 : 0,
            });
          }
          deliveredVia.push(ch);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`${ch}: ${message}`);
          log.error({ err, channel: ch, title: titleRedacted }, 'Notification channel delivery failed');
        }
      }
    }

    const status = batched
      ? 'pending'
      : deliveredVia.length > 0
        ? 'sent'
        : 'error';

    const rows = await sql<{ id: number }[]>`
      INSERT INTO notify.notifications
        (priority, title, body, delivered_via, url_redacted, payload_hash, status, error)
      VALUES (
        ${input.priority},
        ${titleRedacted},
        ${bodyRedacted},
        ${deliveredVia as unknown as string[]},
        ${urlRedacted},
        ${payloadHash},
        ${status},
        ${errors.length > 0 ? errors.join('; ') : null}
      )
      RETURNING id
    `;
    const id = rows[0]!.id;

    return {
      id,
      priority: input.priority,
      deliveredVia,
      status,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  async function flushDigest(): Promise<number> {
    const pending = await sql<{ id: number; title: string; body: string; url_redacted: string | null }[]>`
      SELECT id, title, body, url_redacted
      FROM notify.notifications
      WHERE status = 'pending'
      ORDER BY ts ASC
    `;

    if (pending.length === 0) return 0;

    // Nothing to deliver through — leave rows pending for a later flush.
    if (!pushover) {
      log.warn('Digest flush skipped: pushover channel not configured');
      return 0;
    }

    // One summarizing Pushover notice for the whole batch. The button links to
    // the first pending item that carries one (the deep link is not a secret,
    // so its stored `url_redacted` is the real URL — see redact.ts).
    const title = `Digest · ${pending.length} update${pending.length === 1 ? '' : 's'}`;
    const body = pending.map((r) => `• ${r.title}`).join('\n');
    const linked = pending.find((r) => r.url_redacted)?.url_redacted ?? undefined;

    await pushover.send({
      title,
      message: body,
      url: linked,
      urlTitle: linked ? 'Open' : undefined,
      priority: 0,
    });

    const ids = pending.map((r) => r.id);
    await sql`
      UPDATE notify.notifications
      SET status = 'sent', delivered_via = ${['pushover'] as unknown as string[]}
      WHERE id = ANY(${ids as unknown as number[]})
    `;

    log.info({ count: pending.length }, 'Flushed digest notifications to Pushover');
    return pending.length;
  }

  return { notify, flushDigest };
}
