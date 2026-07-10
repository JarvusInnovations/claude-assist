/**
 * Redaction for session-control (RC takeover) links.
 *
 * herdr-rc returns a claude.ai takeover link of the form
 *   https://claude.ai/code/session_<token>
 * (see tools/herdr-rc). That link is a live session-control handle — anyone
 * holding it can take over the session — so it is treated as a secret: the
 * dispatcher DELIVERS it to the channel, but the notifications log stores only
 * a redacted form. `payload_hash` (below) lets a delivery be correlated to its
 * payload without persisting the secret.
 */

import { createHash } from 'node:crypto';

/** The claude.ai RC takeover link; the `session_<token>` segment is the secret. */
const CLAUDE_SESSION_RE = /https?:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/i;
const CLAUDE_SESSION_RE_G = /https?:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/gi;

/** Generic remote-control / takeover link shapes on any host. */
const RC_GENERIC_RE = /https?:\/\/[^\s/]+\/(?:rc|remote-control|takeover)\/[^\s]+/i;
const RC_GENERIC_RE_G = /https?:\/\/[^\s/]+\/(?:rc|remote-control|takeover)\/[^\s]+/gi;

/** True when a URL is a session-control link that must not be logged in plaintext. */
export function isSecretUrl(url: string): boolean {
  return CLAUDE_SESSION_RE.test(url) || RC_GENERIC_RE.test(url);
}

/**
 * Redact a single URL for storage. Secret links keep host + a stable prefix so
 * the log stays legible, but drop the token. Non-secret URLs pass through.
 */
export function redactUrl(url: string): string {
  const claudeMatch = url.match(/^(https?:\/\/claude\.ai\/code\/)session_[A-Za-z0-9_-]+/i);
  if (claudeMatch) return `${claudeMatch[1]}session_[redacted]`;

  if (isSecretUrl(url)) {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}/[redacted-session-link]`;
    } catch {
      return '[redacted-session-link]';
    }
  }

  return url;
}

/**
 * Redact any session-control links found inline in free text (title/body)
 * before it is written to the log. Non-secret URLs are left untouched.
 */
export function redactText(text: string): string {
  return text
    .replace(CLAUDE_SESSION_RE_G, (m) => redactUrl(m))
    .replace(RC_GENERIC_RE_G, (m) => redactUrl(m));
}

/**
 * Deterministic sha256 over the *real* (un-redacted) payload. Persisted so a
 * delivered notification can be correlated to its source without ever storing
 * the secret link.
 */
export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
