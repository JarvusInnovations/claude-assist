/**
 * Helpers for the pages-axi CLI (bin/pages-axi.ts). Kept in src/ so they are
 * compiled + unit-testable; the bin is a thin bun-executable wrapper.
 *
 * Output follows the repo's TOON conventions (see the google package's axi
 * renderer): labeled `key: value` blocks for single objects, `label[N]{cols}:`
 * tables for collections, and an indented `help[N]:` block of next steps.
 * Hand-rolled here (rather than importing an encoder) to keep the CLI
 * dependency-free — the subset we emit is flat objects and flat-object rows.
 */

export const DEFAULT_SERVER = 'http://localhost:2529';

/** Server base URL from CLAUDE_ASSIST_SERVER (same convention as the other axi CLIs). */
export function resolveServer(env: Record<string, string | undefined> = process.env): string {
  const value = env.CLAUDE_ASSIST_SERVER?.trim();
  return (value || DEFAULT_SERVER).replace(/\/+$/, '');
}

// ── Minimal TOON rendering ───────────────────────────────────────────────────

function toonValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = value instanceof Date ? value.toISOString() : String(value);
  // Quote anything that would be ambiguous in a TOON scalar/CSV cell.
  if (s === '' || /[",:\n{}[\]]/.test(s) || /^\s|\s$/.test(s)) return JSON.stringify(s);
  return s;
}

/** Render a single labeled object: `label:` + indented `key: value` lines. */
export function renderObject(label: string, obj: Record<string, unknown>): string {
  const lines = [`${label}:`];
  for (const [key, value] of Object.entries(obj)) {
    lines.push(`  ${key}: ${toonValue(value)}`);
  }
  return lines.join('\n');
}

/** Render a labeled collection as a TOON table: `label[N]{cols}:` + CSV rows. */
export function renderTable(
  label: string,
  rows: Record<string, unknown>[],
  cols?: string[]
): string {
  const keys = cols ?? Object.keys(rows[0] ?? {});
  if (rows.length === 0) return `${label}[0]`;
  const header = `${label}[${rows.length}]{${keys.join(',')}}:`;
  const body = rows.map((row) => `  ${keys.map((k) => toonValue(row[k])).join(',')}`);
  return [header, ...body].join('\n');
}

/** Render next-step suggestions as an indented help block. */
export function renderHelp(lines: string[]): string {
  const clean = lines.filter(Boolean);
  if (clean.length === 0) return '';
  return `help[${clean.length}]:\n${clean.map((l) => `  ${l}`).join('\n')}`;
}

/** Join TOON blocks into a single stdout payload, dropping empties. */
export function renderOutput(blocks: string[]): string {
  return blocks.filter(Boolean).join('\n');
}

/** Human relative time for a timestamp (e.g. "3d ago"). */
export function formatRelativeTime(value: unknown, nowMs = Date.now()): string {
  if (!value) return 'unknown';
  const then = new Date(value as string).getTime();
  if (isNaN(then)) return 'unknown';
  const diffSec = Math.floor((nowMs - then) / 1000);
  const past = diffSec >= 0;
  const s = Math.abs(diffSec);
  const fmt = (n: number, unit: string) => (past ? `${n}${unit} ago` : `in ${n}${unit}`);
  if (s < 60) return past ? 'just now' : 'soon';
  const min = Math.floor(s / 60);
  if (min < 60) return fmt(min, 'm');
  const hr = Math.floor(min / 60);
  if (hr < 24) return fmt(hr, 'h');
  const day = Math.floor(hr / 24);
  if (day < 30) return fmt(day, 'd');
  const mon = Math.floor(day / 30);
  if (mon < 12) return fmt(mon, 'mo');
  return fmt(Math.floor(mon / 12), 'y');
}

// ── Flag parsing ─────────────────────────────────────────────────────────────

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Tiny flag parser: `--name value` for flags listed in valueFlags, `--name`
 * for flags listed in boolFlags; everything else is positional. Throws on an
 * unknown flag or a value flag with no value.
 */
export function parseFlags(
  argv: string[],
  valueFlags: string[],
  boolFlags: string[] = []
): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (boolFlags.includes(name)) {
      flags[name] = true;
    } else if (valueFlags.includes(name)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for --${name}`);
      flags[name] = value;
    } else {
      throw new Error(`unknown flag --${name}`);
    }
  }
  return { positional, flags };
}

// ── Publish helpers ──────────────────────────────────────────────────────────

/** Pull the document title out of an HTML string, if present. */
export function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = match?.[1]?.trim();
  // The <title> element's text is HTML-ENCODED in the source. A page title is
  // stored and consumed as PLAIN TEXT — the index, the CLI table, notifications
  // — and the HTML renderer escapes it again on output. Lifting the encoded form
  // verbatim is what put `&amp;` in front of readers everywhere but the page.
  return title ? decodeHtmlEntities(title) : null;
}

/**
 * Decode the entities an authored `<title>` can legitimately carry. Deliberately
 * NOT a general HTML parser: only the five XML predefined entities plus numeric
 * references, which is everything a title needs and nothing that could turn
 * stored text into markup.
 */
export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    // Ampersand LAST: decoding it first would let `&amp;lt;` become `<`.
    .replace(/&amp;/g, '&');
}

/** Fallback title for a slug: kebab-case → Title Case. */
export function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}
