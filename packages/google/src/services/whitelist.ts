/**
 * Sender whitelist — the set of addresses eligible to trip the urgent-alert
 * bar (and, in future, auto-execute). Derived conservatively so a too-broad
 * list can't auto-act on strangers; it expands naturally from reply history.
 *
 * Sources (per architecture.md → Email):
 *   - Reply history: addresses the owner has actually corresponded with —
 *     recipients of the owner's sent mail, plus senders in any thread the owner
 *     participated in.
 *   - Team domains: matched by domain in the classifier (urgency.ts), not
 *     enumerated here.
 *   - External contacts: OPTIONAL — `deriveWhitelist` accepts an injected
 *     contact list, so an external CRM/contacts source can feed it later
 *     (via a sync) without changing this module. Left empty when none is wired.
 *
 * NOTE: Gmail sync only ingests `in:inbox`, so the owner's Sent mailbox is not
 * (yet) in `google.emails`. The reply-history query therefore leans on the
 * thread-participation heuristic; syncing Sent mail would make it complete
 * (tracked as a follow-up).
 */

import type postgres from 'postgres';

/** Lowercase, trim, and keep only well-formed addresses; dedup into a Set. */
export function buildWhitelist(addresses: Iterable<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const raw of addresses) {
    if (!raw) continue;
    const addr = raw.trim().toLowerCase();
    // Minimal validity: local@domain.tld — guards against display-name noise.
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
      out.add(addr);
    }
  }
  return out;
}

export interface WhitelistServiceConfig {
  /** Extra contact addresses (e.g. an external contacts sync); merged into the set. */
  externalContacts?: string[];
}

export class WhitelistService {
  private sql: postgres.Sql;
  private externalContacts: string[];

  constructor(sql: postgres.Sql, config: WhitelistServiceConfig = {}) {
    this.sql = sql;
    this.externalContacts = config.externalContacts ?? [];
  }

  /**
   * Compute the whitelist for an account: everyone the owner has corresponded
   * with, plus any injected external contacts.
   */
  async deriveWhitelist(accountId: number): Promise<Set<string>> {
    const [account] = await this.sql<{ email: string }[]>`
      SELECT email FROM google.accounts WHERE id = ${accountId}
    `;
    if (!account) return new Set();
    const owner = account.email.toLowerCase();

    // Recipients of the owner's own sent mail (present only if Sent is synced).
    const repliedTo = await this.sql<{ addr: string }[]>`
      SELECT DISTINCT lower(addr) AS addr
      FROM google.emails e, unnest(e.to_addresses) AS addr
      WHERE e.account_id = ${accountId}
        AND lower(e.from_address) = ${owner}
    `;

    // Senders in any thread the owner participated in (reply-history proxy).
    const correspondents = await this.sql<{ addr: string }[]>`
      SELECT DISTINCT lower(e.from_address) AS addr
      FROM google.emails e
      WHERE e.account_id = ${accountId}
        AND e.from_address IS NOT NULL
        AND lower(e.from_address) <> ${owner}
        AND e.thread_id IN (
          SELECT thread_id FROM google.emails
          WHERE account_id = ${accountId}
            AND thread_id IS NOT NULL
            AND lower(from_address) = ${owner}
        )
    `;

    return buildWhitelist([
      ...repliedTo.map((r) => r.addr),
      ...correspondents.map((r) => r.addr),
      ...this.externalContacts,
    ]);
  }
}
