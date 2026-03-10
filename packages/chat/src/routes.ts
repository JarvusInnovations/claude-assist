import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { Chat } from 'chat';

interface WebhookRoutesConfig {
  bot: Chat<any, any>;
}

/**
 * Register webhook routes for the Chat SDK.
 * The Slack adapter handles signature verification internally.
 */
export const registerWebhookRoutes: FastifyPluginAsync<WebhookRoutesConfig> = async (
  fastify,
  { bot }
) => {
  // Tell Fastify to give us the raw body as a string (not parsed JSON)
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => { done(null, body); }
  );
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => { done(null, body); }
  );

  // Slack webhook endpoint
  // The Chat SDK expects a standard Request object and returns a Response
  fastify.post('/webhooks/slack', async (request: FastifyRequest, reply: FastifyReply) => {
    const webhookHandler = bot.webhooks.slack;
    if (!webhookHandler) {
      return reply.status(404).send({ error: 'Slack adapter not configured' });
    }

    // Convert Fastify request to standard Web Request for the Chat SDK
    const url = `${request.protocol}://${request.hostname}${request.url}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value != null) {
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
    }

    const webRequest = new Request(url, {
      method: 'POST',
      headers,
      body: request.body as string,
    });

    // Let the Chat SDK handle the webhook (includes signature verification)
    const response = await webhookHandler(webRequest);

    // Convert standard Response back to Fastify reply
    reply.status(response.status);
    for (const [key, value] of response.headers.entries()) {
      reply.header(key, value);
    }

    const body = await response.text();
    return reply.send(body);
  });

  // Health check for webhook endpoint
  fastify.get('/webhooks/slack', async () => {
    return { status: 'ok', adapter: 'slack' };
  });
};
