import { AxiError } from "axi-sdk-js";

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Minimal flag parser. Flags are `--name value`, except those listed in
 * `booleanFlags`, which are bare `--name`. Everything else is a positional.
 * Repeated non-boolean flags keep the last value; use `collectFlag` when a
 * flag may appear multiple times (e.g. `--component`).
 */
export function parseArgs(args: string[], booleanFlags: string[] = []): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (booleanFlags.includes(name)) {
        flags[name] = true;
      } else {
        const value = args[++i];
        if (value === undefined) {
          throw new AxiError(`Flag --${name} requires a value`, "VALIDATION_ERROR");
        }
        flags[name] = value;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

/**
 * Collect every value passed for a repeatable `--name value` flag, in order.
 * Boolean flags in `booleanFlags` are skipped (bare, no value).
 */
export function collectFlag(args: string[], name: string, booleanFlags: string[] = []): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (booleanFlags.includes(key)) continue;
    const value = args[++i];
    if (key === name && value !== undefined) values.push(value);
  }
  return values;
}

/** Read a string flag, or throw a validation error if missing. */
export function requireFlag(flags: Record<string, string | boolean>, name: string, usage: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v === "") {
    throw new AxiError(`--${name} is required`, "VALIDATION_ERROR", [usage]);
  }
  return v;
}

/** Read a positional argument, or throw a validation error if missing. */
export function requirePositional(positionals: string[], index: number, label: string, usage: string): string {
  const v = positionals[index];
  if (!v) throw new AxiError(`${label} is required`, "VALIDATION_ERROR", [usage]);
  return v;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Validate a date/timestamp flag value before any network call. Accepts a
 * date-only `YYYY-MM-DD` or a full ISO 8601 timestamp, and confirms it's a real
 * calendar date. Returns the value unchanged so callers can pass it through.
 */
export function validateDate(value: string, flag: string, usage: string): string {
  const wellFormed = DATE_ONLY.test(value) || ISO_DATETIME.test(value);
  if (!wellFormed || Number.isNaN(Date.parse(value))) {
    throw new AxiError(`Invalid date for ${flag}: ${value}`, "VALIDATION_ERROR", [
      "Use YYYY-MM-DD (e.g. 2026-04-29) or a full ISO 8601 timestamp (e.g. 2026-04-29T14:30:00Z)",
      usage,
    ]);
  }
  return value;
}

/**
 * Parse a numeric flag value, rejecting non-numbers before any network call.
 * `opts.min`/`opts.max` bound the accepted range (inclusive) when supplied.
 */
export function parseNumberFlag(
  value: string,
  flag: string,
  usage: string,
  opts: { min?: number; max?: number } = {},
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new AxiError(`--${flag} must be a number (got ${value})`, "VALIDATION_ERROR", [usage]);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new AxiError(`--${flag} must be >= ${opts.min} (got ${n})`, "VALIDATION_ERROR", [usage]);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new AxiError(`--${flag} must be <= ${opts.max} (got ${n})`, "VALIDATION_ERROR", [usage]);
  }
  return n;
}

/** Parse a JSON flag/positional value, with a structured error on malformed input. */
export function parseJson(value: string, label: string, usage: string): unknown {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new AxiError(`${label} must be valid JSON: ${(err as Error).message}`, "VALIDATION_ERROR", [usage]);
  }
}

/** Split a comma-separated flag value into trimmed, non-empty parts. */
export function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pretty-printed raw JSON, for the `--json` escape hatch. */
export function rawJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
