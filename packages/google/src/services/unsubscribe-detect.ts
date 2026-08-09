/**
 * Unsubscribe automation — the pure decision layer.
 *
 * Everything in this file is a total function over plain data: no database, no
 * network, no clock beyond an injected `now`. That is deliberate. The two
 * invariants that make this automation safe to run unattended —
 *
 *   1. a WHITELISTED sender is never auto-unsubscribed at any tier, and
 *   2. execution draws ONLY from the owner-flagged queue
 *      (`google.sender_standing.standing = 'unsubscribe_queue'`),
 *
 * — are decided here, by `gateSender`, so they can be proven by tests rather
 * than argued from code reading. The service layer applies the decision; it
 * does not re-derive it.
 *
 * There is NO model call anywhere in the unsubscribe path — not here and not in
 * the service. Tiering is header inspection, and the browser tier acts only on
 * an unambiguous page. Judgment cases route to a human instead.
 */

import type { SenderStanding } from './standing.js';

/** Increasing effort/judgment. Tier 3 is never auto-executed. */
export type UnsubscribeTier = 1 | 2 | 3;

export type UnsubscribeMethod = 'one_click' | 'browser_form' | 'review';

/** The two RFC 2369 / RFC 8058 headers the tiering reads. */
export interface UnsubscribeHeaders {
  /** `List-Unsubscribe: <https://…>, <mailto:…>` */
  listUnsubscribe?: string | null;
  /** `List-Unsubscribe-Post: List-Unsubscribe=One-Click` */
  listUnsubscribePost?: string | null;
}

export interface DetectedMethod {
  tier: UnsubscribeTier;
  method: UnsubscribeMethod;
  /** HTTPS endpoint to POST (tier 1) or open (tier 2); null for tier 3. */
  url: string | null;
  /** A mailto: unsubscribe target, when the sender offered one. Never fired. */
  mailto: string | null;
  /** Machine-readable why, carried into the attempt's `detail`. */
  reason: string;
}

/**
 * Split a `List-Unsubscribe` header into its `<uri>` entries.
 *
 * Tolerant on purpose: real-world senders emit bare URIs without angle
 * brackets, stray whitespace, and occasionally a trailing comma. Anything that
 * is not an http(s) or mailto URI is dropped rather than guessed at.
 */
export function parseListUnsubscribe(header: string | null | undefined): {
  https: string[];
  mailtos: string[];
} {
  const https: string[] = [];
  const mailtos: string[] = [];
  if (!header) return { https, mailtos };

  // Prefer bracketed entries; fall back to comma-splitting when a sender
  // omitted the brackets entirely.
  const bracketed = [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim());
  const entries = bracketed.length > 0 ? bracketed : header.split(',').map((s) => s.trim());

  for (const raw of entries) {
    const uri = raw.replace(/^<|>$/g, '').trim();
    if (!uri) continue;
    if (/^https:\/\//i.test(uri)) {
      https.push(uri);
    } else if (/^http:\/\//i.test(uri)) {
      // Plaintext HTTP is not a channel we fire a POST down; it is still a
      // usable page for the browser tier, so keep it — the tier-1 gate below
      // requires https explicitly.
      https.push(uri);
    } else if (/^mailto:/i.test(uri)) {
      mailtos.push(uri);
    }
  }
  return { https, mailtos };
}

/** RFC 8058: one-click is opt-in via an explicit `List-Unsubscribe-Post` value. */
export function isOneClickPost(header: string | null | undefined): boolean {
  if (!header) return false;
  return /list-unsubscribe\s*=\s*one-click/i.test(header);
}

/**
 * Decide which tier a sender's unsubscribe offer falls into.
 *
 * - **Tier 1** needs BOTH `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
 *   and an `https://` target. That pair is the sender's own machine-readable
 *   promise that a bare POST is the correct, complete action — the only case
 *   where firing without a human looking at a page is honest.
 * - **Tier 2** is any remaining http(s) target: a page a browser must render.
 *   `fallbackLink` (the triage-extracted footer link) feeds this when the
 *   sender published no headers at all.
 * - **Tier 3** is everything else, including mailto-only. A mailto unsubscribe
 *   would mean sending mail FROM the owner's account, which is an outbound
 *   communication in its own right and not something to do unattended.
 */
export function detectUnsubscribeMethod(
  headers: UnsubscribeHeaders,
  fallbackLink?: string | null
): DetectedMethod {
  const { https, mailtos } = parseListUnsubscribe(headers.listUnsubscribe);
  const mailto = mailtos[0] ?? null;

  const oneClickUrl = https.find((u) => /^https:\/\//i.test(u));
  if (isOneClickPost(headers.listUnsubscribePost) && oneClickUrl) {
    return {
      tier: 1,
      method: 'one_click',
      url: oneClickUrl,
      mailto,
      reason: 'list-unsubscribe-post one-click',
    };
  }

  const pageUrl =
    https[0] ??
    (fallbackLink && /^https?:\/\//i.test(fallbackLink.trim()) ? fallbackLink.trim() : null);
  if (pageUrl) {
    return {
      tier: 2,
      method: 'browser_form',
      url: pageUrl,
      mailto,
      reason: headers.listUnsubscribe ? 'list-unsubscribe link only' : 'body unsubscribe link',
    };
  }

  return {
    tier: 3,
    method: 'review',
    url: null,
    mailto,
    reason: mailto ? 'mailto-only unsubscribe' : 'no unsubscribe method found',
  };
}

/** Everything after the '@', lowercased. Empty string when unparseable. */
export function senderDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).trim().toLowerCase();
}

// ── The gate ────────────────────────────────────────────────────────────────

export interface GateInput {
  senderEmail: string;
  /** The sender's row in `google.sender_standing`, or null if it has none. */
  standing: SenderStanding | null;
  /**
   * The action-layer whitelist: reply history + contacts + any external source
   * (see WhitelistService), UNION the explicit `whitelist` standings.
   */
  whitelist: ReadonlySet<string>;
  /** Team domains — whitelisted by domain per the architecture's definition. */
  teamDomains?: readonly string[];
}

export type GateBlockReason =
  | 'whitelisted-address'
  | 'whitelisted-domain'
  | 'not-queued';

export type GateDecision =
  | { allowed: true }
  | { allowed: false; reason: GateBlockReason; detail: string };

/**
 * The hard gate. Both invariants, in one place, checked in this order.
 *
 * The whitelist is checked FIRST and wins outright — including over an explicit
 * owner tap. That ordering is the point: the flag and the whitelist are set at
 * different times from different surfaces, and when they disagree the safe
 * reading is that the owner corresponds with this sender. Such a sender is not
 * dropped on the floor; the service routes it to the tier-3 review queue where
 * a human resolves the contradiction. "Never auto-unsubscribed" is satisfied
 * without losing the request.
 */
export function gateSender(input: GateInput): GateDecision {
  const email = input.senderEmail.trim().toLowerCase();

  if (input.whitelist.has(email)) {
    return {
      allowed: false,
      reason: 'whitelisted-address',
      detail: 'sender is on the action-layer whitelist',
    };
  }

  const domain = senderDomain(email);
  for (const raw of input.teamDomains ?? []) {
    const d = raw.trim().toLowerCase();
    if (d && (domain === d || domain.endsWith(`.${d}`))) {
      return {
        allowed: false,
        reason: 'whitelisted-domain',
        detail: `sender domain matches whitelisted team domain ${d}`,
      };
    }
  }

  if (input.standing !== 'unsubscribe_queue') {
    return {
      allowed: false,
      reason: 'not-queued',
      detail:
        input.standing === null
          ? 'sender was never flagged for unsubscribe by the owner'
          : `sender standing is '${input.standing}', not 'unsubscribe_queue'`,
    };
  }

  return { allowed: true };
}

// ── Rate limiting ───────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Rolling window, in minutes. */
  windowMinutes: number;
  /** Max executed actions against one sender-domain inside the window. */
  maxPerDomain: number;
}

export type RateDecision =
  | { allowed: true }
  | { allowed: false; retryAfter: Date; recent: number };

/**
 * Per-sender-domain rate limit over a rolling window.
 *
 * `recentTimestamps` are the completion times of prior EXECUTED actions against
 * the same domain (tier-3 routing and gate skips are not actions and are not
 * counted — they touched nobody's server). A limited attempt is deferred to
 * when the oldest in-window action ages out, not failed: the sender is still
 * queued, we are just being polite to their provider.
 */
export function checkRateLimit(
  recentTimestamps: readonly (Date | string)[],
  config: RateLimitConfig,
  now: Date = new Date()
): RateDecision {
  const windowMs = Math.max(0, config.windowMinutes) * 60_000;
  const cutoff = now.getTime() - windowMs;
  const inWindow = recentTimestamps
    .map((t) => (t instanceof Date ? t.getTime() : new Date(t).getTime()))
    .filter((t) => Number.isFinite(t) && t > cutoff)
    .sort((a, b) => a - b);

  if (inWindow.length < config.maxPerDomain) return { allowed: true };

  // The window frees a slot when the oldest in-window action falls out of it.
  const oldest = inWindow[0]!;
  return {
    allowed: false,
    retryAfter: new Date(oldest + windowMs),
    recent: inWindow.length,
  };
}
