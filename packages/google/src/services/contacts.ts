/**
 * Pluggable client-contacts source.
 *
 * Individual client contacts get "known sender" standing in the urgency bar —
 * substantive mail from them (e.g. an accounts-payable thread) can reach the
 * ATTENTION tier even without an explicit deadline phrase. WHO those contacts
 * are is instance data, so this is pluggable exactly like the briefing's
 * commitments source: point it at either a plain file of addresses (one per
 * line) or any CLI that prints addresses to stdout. The owner wires their own
 * source privately; the toolkit only knows "a list of contact emails".
 *
 * Degrades to an empty set (no error thrown) when nothing is configured or a
 * configured source fails, so a missing contacts feed never breaks triage.
 */

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ContactsSourceConfig {
  /** Path to a newline-delimited file of contact email addresses. */
  file?: string;
  /** Path to a CLI that prints contact addresses (one per line) to stdout. */
  bin?: string;
  /** Args for the CLI (default none). */
  args?: string[];
  timeoutMs?: number;
}

/** Parse a blob of text into a lowercased set of well-formed addresses. */
export function parseContacts(text: string): Set<string> {
  const out = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().toLowerCase();
    if (!line || line.startsWith('#')) continue;
    // Accept "Name <addr>" or a bare address; extract the address part.
    const m = line.match(/<([^>]+)>/);
    const addr = (m ? m[1]! : line).trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) out.add(addr);
  }
  return out;
}

/**
 * Load the configured client contacts. Returns an empty set when neither a file
 * nor a bin is set, or when the configured source fails (logged by the caller).
 */
export async function loadClientContacts(config: ContactsSourceConfig): Promise<Set<string>> {
  if (config.file) {
    const text = readFileSync(config.file, 'utf8');
    return parseContacts(text);
  }
  if (config.bin) {
    const { stdout } = await execFileAsync(config.bin, config.args ?? [], {
      timeout: config.timeoutMs ?? 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseContacts(stdout);
  }
  return new Set();
}
