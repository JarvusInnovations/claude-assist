/**
 * Content sanitization for values extracted from transcripts before they hit
 * Postgres.
 *
 * Two real sessions (734c21a6, 970ea31c - a roborev-style code-review runner
 * whose prompt embedded a diff) each contained a literal "\u0000" escape
 * inside a JSON string in the raw JSONL. That's valid JSON - JSON.parse()
 * correctly turns it into an actual NUL (U+0000) character in the resulting
 * JS string - but Postgres's jsonb parser explicitly rejects it (a NUL byte
 * can't be represented in a text-backed type), so every insert of a jsonb
 * column built from that string failed with "PostgresError: unsupported
 * Unicode escape sequence" on every 5-minute sync cycle. Lone UTF-16
 * surrogates (unpaired high/low halves, e.g. from truncated multi-byte
 * emoji) hit the same class of failure when the driver re-encodes them as
 * UTF-8.
 *
 * `sanitizeText` replaces both with U+FFFD (the Unicode replacement
 * character) rather than stripping them, so string length/structure stays
 * predictable and the rest of the content - what actually matters for
 * search/outline - survives untouched.
 */

const REPLACEMENT_CHAR = '�';

/** Fast pre-check: NUL or any surrogate code unit (paired or not). */
const NEEDS_SANITIZE_RE = /[\u0000\uD800-\uDFFF]/;

/**
 * Replace NUL characters and unpaired UTF-16 surrogates with the Unicode
 * replacement character. Valid surrogate pairs (real astral-plane
 * characters, e.g. most emoji) are left untouched.
 */
export function sanitizeText(value: string): string {
  if (!NEEDS_SANITIZE_RE.test(value)) return value;

  let result = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);

    if (code === 0) {
      result += REPLACEMENT_CHAR;
      continue;
    }

    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate - valid only if immediately followed by a low surrogate.
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[i]! + value[i + 1];
        i++;
      } else {
        result += REPLACEMENT_CHAR;
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      // Lone low surrogate (no preceding high surrogate consumed it above).
      result += REPLACEMENT_CHAR;
      continue;
    }

    result += value[i];
  }
  return result;
}

/** Apply sanitizeText across an array of strings. */
export function sanitizeStringArray(values: readonly string[]): string[] {
  return values.map(sanitizeText);
}
