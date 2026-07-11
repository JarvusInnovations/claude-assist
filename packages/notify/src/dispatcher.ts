/**
 * The single notification dispatcher. Every pipeline delivers through
 * `notify()`; no pipeline grows its own delivery code. Priority chooses the
 * default channel (interrupts-are-earned):
 *   interrupt → Pushover high-priority   notice → Pushover normal
 *   digest    → Slack DM (batched)
 * `channelHints` overrides the default set (e.g. fan a single dispatch out to
 * both channels).
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
import type { SlackChannel } from './channels/slack.js';
import { hashPayload, redactText, redactUrl } from './redact.js';

export interface DispatcherDeps {
  sql: postgres.Sql;
  log: FastifyBaseLogger;
  pushover: PushoverChannel | null;
  slack: SlackChannel | null;
}

export interface Dispatcher extends NotifyDispatcher {
  /** Flush batched digest notifications into one Slack DM. Returns count sent. */
  flushDigest(): Promise<number>;
}

function defaultChannels(input: NotifyInput): NotificationChannel[] {
  if (input.channelHints && input.channelHints.length > 0) {
    return input.channelHints;
  }
  return input.priority === 'digest' ? ['slack'] : ['pushover'];
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { sql, log, pushover, slack } = deps;

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
          } else if (ch === 'slack') {
            if (!slack) throw new Error('slack channel not configured');
            await slack.send({ title: input.title, body: input.body, url: realUrl });
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
    if (!slack) {
      log.warn('Digest flush skipped: slack channel not configured');
      return 0;
    }

    const items = pending.map((r) => {
      const link = r.url_redacted ? `\n${r.url_redacted}` : '';
      return `*${r.title}*\n${r.body}${link}`;
    });

    await slack.sendDigest(items);

    const ids = pending.map((r) => r.id);
    await sql`
      UPDATE notify.notifications
      SET status = 'sent', delivered_via = ${['slack'] as unknown as string[]}
      WHERE id = ANY(${ids as unknown as number[]})
    `;

    log.info({ count: pending.length }, 'Flushed digest notifications to Slack');
    return pending.length;
  }

  return { notify, flushDigest };
}
