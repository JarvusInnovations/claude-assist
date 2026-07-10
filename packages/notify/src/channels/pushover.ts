/**
 * Pushover channel — the interrupt + notice tiers (phone + watch).
 * Plain REST; credentials come from the existing pushover MCP config
 * (PUSHOVER_TOKEN / PUSHOVER_USER).
 */

const PUSHOVER_API = 'https://api.pushover.net/1/messages.json';

export interface PushoverConfig {
  token: string;
  user: string;
}

/** Pushover priority: 1 = high (bypasses quiet hours), 0 = normal. */
export type PushoverPriority = 1 | 0;

export interface PushoverMessage {
  title: string;
  message: string;
  priority: PushoverPriority;
  url?: string;
}

export interface PushoverChannel {
  send(msg: PushoverMessage): Promise<void>;
}

export function createPushoverChannel(config: PushoverConfig): PushoverChannel {
  return {
    async send({ title, message, priority, url }) {
      const form = new URLSearchParams();
      form.set('token', config.token);
      form.set('user', config.user);
      form.set('title', title);
      form.set('message', message);
      form.set('priority', String(priority));
      if (url) {
        form.set('url', url);
        form.set('url_title', 'Open');
      }

      const res = await fetch(PUSHOVER_API, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Pushover ${res.status}: ${detail}`);
      }
    },
  };
}
