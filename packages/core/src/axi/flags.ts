/**
 * The strict flag parser shared by the bundled AXI CLIs
 * (specs/behaviors/axi-cli-arguments-and-export.md § Declared arguments).
 *
 * A silently dropped flag is worse than an error: the agent gets output it
 * believes is filtered and carries on with wrong data. So every command
 * declares what it accepts, and anything else fails with exit 2 and the valid
 * flags listed, before any network call.
 *
 * Ported from nexudus-axi `src/flags.ts`. Differences: flag names are declared
 * and returned without the leading `--` (the convention these CLIs already
 * used), there is no global selector flag, and `--json-out[=path]` is handled
 * here so its path is validated at parse time.
 */
import { AxiError } from "axi-sdk-js";
import { requestJsonOut, type JsonOutTarget } from "./json-out.js";

export interface FlagSpec {
  /** Flags that take a value: `--limit 10` or `--limit=10`. */
  value?: string[];
  /** Standalone switches: `--closed`. */
  boolean?: string[];
  /** Repeatable value flags; every occurrence is collected, in order. */
  multi?: string[];
  /** Renamed, removed or commonly guessed flags, as typed (`--until`, `-n`), mapped to a hint. */
  deprecated?: Record<string, string>;
  /** How many positionals the command takes: a count, or `"many"`. Default 0. */
  positionals?: number | "many";
  /** Usage line shown when positionals are wrong. */
  usage?: string;
  /**
   * `true` when the command offers `--json-out[=path]`. A string refuses the
   * flag with that reason (a command with no JSON form). Default: refused.
   */
  jsonOut?: boolean | string;
}

export interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Values collected from `multi` flags, in the order given. */
  multi: Record<string, string[]>;
  /** The export this invocation asked for, already validated. */
  jsonOut?: JsonOutTarget;
}

/** Only `--<letter>` starts a flag; `---`, `-5` and `- item` are text. */
const LONG_FLAG = /^--[A-Za-z]/;
/** A lone short flag (`-n`). These CLIs have none, so it is always rejected. */
const SHORT_FLAG = /^-[A-Za-z]$/;

export type ParseFn = (command: string, argv: string[], spec: FlagSpec) => Parsed;

/** Build the parser for one CLI. `tool` names it in messages and names its export directory. */
export function createParser(tool: string): ParseFn {
  return (command, argv, spec) => parseFlags(tool, command, argv, spec);
}

export function parseFlags(tool: string, command: string, argv: string[], spec: FlagSpec): Parsed {
  const valueFlags = new Set(spec.value ?? []);
  const boolFlags = new Set(spec.boolean ?? []);
  const multiFlags = new Set(spec.multi ?? []);
  const deprecated = spec.deprecated ?? {};
  const offersJsonOut = spec.jsonOut === true;
  const label = command || "home";
  const known = [...valueFlags, ...boolFlags, ...multiFlags, ...(offersJsonOut ? ["json-out"] : [])]
    .sort()
    .map((f) => `--${f}`);

  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const multi: Record<string, string[]> = {};
  let jsonOutValue: true | string | undefined;
  /** Index in `positionals` of a token that directly followed a bare `--json-out`. */
  let afterBareJsonOut: number | undefined;

  const spaceFormHint = "--json-out takes its path with =: --json-out=<path> (a bare --json-out writes a temp file)";

  // The single place a flag is rejected, so a hint is always true of the
  // command printing it.
  const unknown = (typed: string): never => {
    let hint: string;
    if (deprecated[typed]) {
      hint = deprecated[typed]!;
    } else if (typed === "--json") {
      hint = offersJsonOut
        ? "--json is not supported; use --json-out to write the JSON to a file (--json-out=<path> to choose where)"
        : `--json is not supported, and \`${label}\` has no JSON export${typeof spec.jsonOut === "string" ? `: ${spec.jsonOut}` : ""}`;
    } else if (typed === "--json-out") {
      hint = `\`${label}\` has no JSON export${typeof spec.jsonOut === "string" ? `: ${spec.jsonOut}` : ""}`;
    } else if (SHORT_FLAG.test(typed)) {
      hint = `${typed} is not a flag of ${tool}; short flags are not supported. ${validList()}`;
    } else {
      hint = validList();
    }
    throw new AxiError(`unknown flag ${typed} for \`${label}\``, "UNKNOWN_FLAG", [hint]);
  };
  const validList = (): string =>
    known.length > 0
      ? `valid flags for \`${label}\`: ${known.join(", ")} (--help always allowed)`
      : `\`${label}\` takes no flags (--help always allowed)`;

  const takeValue = (name: string, inline: string | undefined, i: number): { value: string; next: number } => {
    if (inline !== undefined) return { value: inline, next: i };
    const next = argv[i + 1];
    if (next === undefined || LONG_FLAG.test(next)) {
      throw new AxiError(`--${name} requires a value`, "USAGE", [
        `Pass \`--${name} <value>\`, or \`--${name}=<value>\` when the value itself starts with --`,
      ]);
    }
    return { value: next, next: i + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (SHORT_FLAG.test(arg)) unknown(arg);
    if (!LONG_FLAG.test(arg)) {
      if (i > 0 && argv[i - 1] === "--json-out" && jsonOutValue === true) {
        // A path-looking token after the bare flag is the space form, not an argument.
        if (/\.json$/i.test(arg)) throw new AxiError(`--json-out does not take a separate value (got ${arg})`, "USAGE", [spaceFormHint]);
        afterBareJsonOut = positionals.length;
      }
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const typed = eq === -1 ? arg : arg.slice(0, eq);
    const name = typed.slice(2);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    if (name === "help") continue; // the SDK answers --help before a handler runs

    if (name === "json-out") {
      if (!offersJsonOut) unknown(typed);
      if (jsonOutValue !== undefined) throw new AxiError("--json-out was given more than once", "USAGE", ["Pass it once"]);
      jsonOutValue = inline === undefined ? true : inline;
      continue;
    }

    if (boolFlags.has(name)) {
      if (inline !== undefined) {
        throw new AxiError(`--${name} is a switch and takes no value`, "USAGE", [`Pass \`--${name}\` on its own`]);
      }
      flags[name] = true;
      continue;
    }

    if (valueFlags.has(name)) {
      if (name in flags) {
        throw new AxiError(`--${name} was given more than once`, "USAGE", [`\`${label}\` takes one --${name}`]);
      }
      const taken = takeValue(name, inline, i);
      flags[name] = taken.value;
      i = taken.next;
      continue;
    }

    if (multiFlags.has(name)) {
      const taken = takeValue(name, inline, i);
      (multi[name] ??= []).push(taken.value);
      i = taken.next;
      continue;
    }

    unknown(typed);
  }

  const max = spec.positionals ?? 0;
  if (max !== "many" && positionals.length > max) {
    const extra = positionals.slice(max);
    const takes =
      max === 0
        ? `\`${label}\` takes no positional arguments`
        : `\`${label}\` takes ${max} positional argument${max > 1 ? "s" : ""}`;
    const hints = [`${takes}${spec.usage ? `. Usage: ${spec.usage}` : ""}`];
    if (afterBareJsonOut !== undefined && afterBareJsonOut >= max) hints.unshift(spaceFormHint);
    throw new AxiError(`unexpected argument${extra.length > 1 ? "s" : ""} for \`${label}\`: ${extra.join(" ")}`, "USAGE", hints);
  }

  const parsed: Parsed = { positionals, flags, multi };
  // Last, so a malformed invocation never touches the filesystem.
  if (jsonOutValue !== undefined) parsed.jsonOut = requestJsonOut(tool, command, jsonOutValue);
  return parsed;
}
