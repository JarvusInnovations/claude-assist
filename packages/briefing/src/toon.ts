/**
 * Decode the TOON output of the `-axi` CLIs (`gws-axi`, `hq-axi`) into row
 * records, using the canonical `@toon-format/toon` decoder.
 *
 * The CLIs emit the reference TOON format wrapped in decoration:
 *
 *   account: user@example.com
 *   count: 3
 *   range: "2026-07-20T04:00:00.000Z → 2026-07-21T04:00:00.000Z"
 *   events[3]{id,summary,start,end,my_response,attendees,location,description,hangoutLink}:
 *     abc_20260720,Office,2026-07-20,2026-07-21,"","","","",""
 *     ...
 *   help[3]:
 *     Run `gws-axi calendar get <id>` …
 *
 * We slice out just the named `name[N]{…}:` block (its header line plus the
 * indented rows that follow, stopping at the first flush-left line) and decode
 * *that*, rather than the whole document. Two reasons:
 *
 *   1. The strict decoder rejects the whole document over the surrounding
 *      decoration — e.g. the trailing `help[N]:` footer whose plain lines don't
 *      satisfy its declared item count.
 *   2. Isolating the block keeps the decoder's strict row-count validation on
 *      the data we actually consume while ignoring the noise around it.
 *
 * Why the canonical decoder (and not a hand-rolled CSV splitter): TOON quotes
 * fields with JSON-style backslash escaping (`\"`, `\n`, …), not RFC-4180
 * doubled quotes (`""`). A hand-rolled splitter that assumed `""` truncated any
 * row at the first `\"` — e.g. an HTML anchor in a meeting description — and
 * dropped every column after it, silently declassifying linked meetings so they
 * vanished from both join-alerts and briefings. `decode()` round-trips `\"` and
 * `\n` correctly and keeps every column.
 *
 * `decodeToonRows` returns `null` when the named block is absent (a clean "no
 * rows" signal). It *throws* `ToonDecodeError` on malformed block content; the
 * fetch wrappers that call the parsers run inside a try/catch and convert that
 * throw into `{ rows: [], error }`, preserving graceful degradation.
 */

import { decode, type JsonValue } from '@toon-format/toon';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Slice the `name[N]{…}:` block out of a decorated CLI document: the header
 * line plus the run of indented lines that follow it, stopping at the first
 * flush-left (or blank) line so a trailing `help[N]:` block never leaks in.
 * Returns null when no such block is present.
 */
export function sliceNamedBlock(output: string, name: string): string | null {
  const lines = output.split('\n');
  const headerRe = new RegExp(`^${escapeRegExp(name)}\\[\\d+\\]\\{[^}]*\\}:`);
  const start = lines.findIndex((l) => headerRe.test(l));
  if (start === -1) return null;

  const block = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    // Rows are indented under the header; the first flush-left/blank line ends
    // the block (e.g. the next scalar, another table, or the help footer).
    if (!/^\s/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

/**
 * Decode the named tabular block and return its rows as string-keyed records.
 *
 * Returns null when the block is absent. Throws `ToonDecodeError` when the block
 * is present but malformed (callers degrade via their try/catch).
 *
 * Decoded cell values are coerced to strings to match the string-oriented
 * consumers: a bare `null` token (which `decode()` yields as JS `null`) and any
 * missing value become `''`; unquoted numbers become their string form.
 */
export function decodeToonRows(output: string, name: string): Array<Record<string, string>> | null {
  const block = sliceNamedBlock(output, name);
  if (block == null) return null;
  const decoded = decode(block) as Record<string, JsonValue>;
  const rows = decoded[name];
  if (!Array.isArray(rows)) return null;
  return rows.map((row) => toStringRecord(row));
}

/** Coerce a decoded row object to a `{ column: string }` record (null → ''). */
function toStringRecord(row: JsonValue): Record<string, string> {
  const rec: Record<string, string> = {};
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    for (const [key, value] of Object.entries(row)) {
      rec[key] = value == null ? '' : String(value);
    }
  }
  return rec;
}
