/**
 * Team roster — the set of Slack user ids whose directed messages are eligible
 * to interrupt. Precision comes from this gate: a directed message from a
 * teammate can earn an interrupt; the same words from a stranger cannot.
 *
 * The roster is configured, not guessed. Two sources, in order:
 *   1. SLACK_URGENCY_ROSTER env — a CSV of `U0123ABCD=Julia Stone` pairs.
 *   2. HQ contacts (read-only) — Chris can periodically dump the team's Slack
 *      ids into that env var from `hq-axi`; this module never writes to HQ
 *      (personal/team firewall) and never reads a name off a transcript.
 *
 * A bare id with no `=name` is allowed (membership without a display name).
 */

import type { RosterEntry } from './types.js';

export class Roster {
  private byId: Map<string, RosterEntry>;

  constructor(entries: RosterEntry[]) {
    this.byId = new Map(entries.map((e) => [e.id, e]));
  }

  /** Is this Slack user id a known teammate? */
  has(userId: string): boolean {
    return this.byId.has(userId);
  }

  /** Resolved display name for a teammate, or null. */
  nameOf(userId: string): string | null {
    return this.byId.get(userId)?.name ?? null;
  }

  get size(): number {
    return this.byId.size;
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }
}

/**
 * Parse the SLACK_URGENCY_ROSTER env format: comma- or newline-separated
 * `id=Name` pairs (the `=Name` is optional). Blank entries are ignored.
 *
 *   "U01=Julia Stone, U02=Laurie Wang\nU03"
 */
export function parseRoster(raw: string | undefined): RosterEntry[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const eq = chunk.indexOf('=');
      if (eq === -1) return { id: chunk, name: chunk };
      return {
        id: chunk.slice(0, eq).trim(),
        name: chunk.slice(eq + 1).trim() || chunk.slice(0, eq).trim(),
      };
    })
    .filter((e) => e.id.length > 0);
}
