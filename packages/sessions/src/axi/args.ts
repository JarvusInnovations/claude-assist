import { AxiError } from "axi-sdk-js";
import { createParser, type Parsed } from "../../../core/src/axi/flags.js";
import { FLAG_SPECS, type CommandName } from "./flag-specs.js";

export { captureJson } from "../../../core/src/axi/json-out.js";
export type { Parsed };

const parse = createParser("sessions-axi");

/**
 * Parse one command's argv against its declaration in `flag-specs.ts`. Unknown
 * flags and extra positionals fail here, before any network call
 * (specs/behaviors/axi-cli-arguments-and-export.md).
 */
export function parseArgs(command: CommandName, args: string[]): Parsed {
  return parse(command, args, FLAG_SPECS[command]);
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
 * calendar date. Rejects everything else with a structured error and exit 2.
 * Returns the value unchanged so callers can pass it straight through.
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
