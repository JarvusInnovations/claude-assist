import type { FastifyRequest } from 'fastify';

/**
 * Resolve the externally-visible base URL for building page links (publish
 * response + notify dispatch). Falls back to the reverse-proxy forwarded
 * headers, same derivation the sessions module's share pages use, so an
 * explicit override is only needed when those headers aren't trustworthy.
 */
export function resolveBaseUrl(request: FastifyRequest, override?: string): string {
  if (override) return override.replace(/\/+$/, '');
  const proto = (request.headers['x-forwarded-proto'] as string) ?? 'https';
  const host =
    (request.headers['x-forwarded-host'] as string) ?? request.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

export function pageUrl(request: FastifyRequest, slug: string, override?: string): string {
  return `${resolveBaseUrl(request, override)}/pages/${encodeURIComponent(slug)}`;
}
