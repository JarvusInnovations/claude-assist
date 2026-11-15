import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parseFlags, type FlagSpec } from "./flags.js";
import { formatError } from "./errors.js";

const SPEC: FlagSpec = {
  value: ["limit", "note"],
  boolean: ["closed"],
  multi: ["component"],
  positionals: 1,
  usage: "tool-axi items show <id>",
  jsonOut: true,
};
const parse = (argv: string[], spec: FlagSpec = SPEC) => parseFlags("tool-axi", "items show", argv, spec);

function failure(fn: () => unknown): AxiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AxiError) return err;
    throw err;
  }
  throw new Error("expected an AxiError");
}

describe("strict flag parser", () => {
  let prevTmp: string | undefined;
  let scratch: string;
  beforeAll(() => {
    // A bare --json-out prepares <tmpdir>/<tool>; keep that inside a scratch dir.
    prevTmp = process.env.TMPDIR;
    scratch = mkdtempSync(join(tmpdir(), "axi-flags-test-"));
    process.env.TMPDIR = scratch;
  });
  afterAll(() => {
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
    rmSync(scratch, { recursive: true, force: true });
  });

  it("parses value flags in both forms, switches, repeatables and positionals", () => {
    const p = parse(["01ABC", "--limit", "5", "--note=hello", "--closed", "--component", "a=1", "--component=b=2"]);
    expect(p.positionals).toEqual(["01ABC"]);
    expect(p.flags).toEqual({ limit: "5", note: "hello", closed: true });
    expect(p.multi).toEqual({ component: ["a=1", "b=2"] });
    expect(p.jsonOut).toBeUndefined();
  });

  it("rejects an unknown flag with the command's valid flags", () => {
    const err = failure(() => parse(["--limt", "5"]));
    expect(err.code).toBe("UNKNOWN_FLAG");
    expect(err.message).toBe("unknown flag --limt for `items show`");
    expect(err.suggestions).toEqual([
      "valid flags for `items show`: --closed, --component, --json-out, --limit, --note (--help always allowed)",
    ]);
    expect(formatError(err).exitCode).toBe(2);
  });

  it("says so when a command takes no flags", () => {
    const err = failure(() => parse(["--x"], {}));
    expect(err.suggestions[0]).toBe("`items show` takes no flags (--help always allowed)");
  });

  it("hints --json at --json-out, and --json parses bare even as the last token", () => {
    // If the parser demanded a value for a flag it no longer knows, a trailing
    // --json would die with "requires a value" before the hint could fire.
    const err = failure(() => parse(["01ABC", "--json"]));
    expect(err.code).toBe("UNKNOWN_FLAG");
    expect(err.message).toBe("unknown flag --json for `items show`");
    expect(err.suggestions[0]).toContain("use --json-out");
    expect(failure(() => parse(["--json", "01ABC"])).suggestions[0]).toContain("use --json-out");
  });

  it("only points --json at --json-out on a command that offers it", () => {
    const none = failure(() => parse(["--json"], { jsonOut: false }));
    expect(none.suggestions[0]).toBe("--json is not supported, and `items show` has no JSON export");
    const why = failure(() => parse(["--json-out"], { jsonOut: "its output is plain text" }));
    expect(why.code).toBe("UNKNOWN_FLAG");
    expect(why.suggestions[0]).toBe("`items show` has no JSON export: its output is plain text");
  });

  it("uses a declared hint for a renamed flag, echoing the flag as typed", () => {
    const spec: FlagSpec = { value: ["to"], deprecated: { "--until": "--until is now --to", "-n": "-n is not a flag here; use --limit" } };
    expect(failure(() => parse(["--until", "x"], spec)).suggestions).toEqual(["--until is now --to"]);
    const short = failure(() => parse(["-n", "5"], spec));
    expect(short.message).toBe("unknown flag -n for `items show`");
    expect(short.suggestions).toEqual(["-n is not a flag here; use --limit"]);
  });

  it("rejects an undeclared short flag", () => {
    const err = failure(() => parse(["-n", "5"]));
    expect(err.code).toBe("UNKNOWN_FLAG");
    expect(err.suggestions[0]).toContain("short flags are not supported");
  });

  it("rejects a value flag with no value, and one followed by another flag", () => {
    expect(failure(() => parse(["--limit"])).code).toBe("USAGE");
    const err = failure(() => parse(["--limit", "--closed"]));
    expect(err.message).toBe("--limit requires a value");
    expect(formatError(err).exitCode).toBe(2);
  });

  it("rejects a switch given a value and a repeated non-repeatable flag", () => {
    expect(failure(() => parse(["--closed=yes"])).message).toBe("--closed is a switch and takes no value");
    const twice = failure(() => parse(["--limit", "1", "--limit", "2"]));
    expect(twice.code).toBe("USAGE");
    expect(twice.message).toBe("--limit was given more than once");
  });

  it("rejects extra positionals with the count and the usage line", () => {
    const err = failure(() => parse(["01ABC", "01DEF"]));
    expect(err.code).toBe("USAGE");
    expect(err.message).toBe("unexpected argument for `items show`: 01DEF");
    expect(err.suggestions[0]).toBe("`items show` takes 1 positional argument. Usage: tool-axi items show <id>");
    expect(failure(() => parse(["x"], {})).suggestions[0]).toBe("`items show` takes no positional arguments");
    expect(parse(["a", "b", "c"], { positionals: "many" }).positionals).toEqual(["a", "b", "c"]);
  });

  it("treats dash-led text and negative numbers as values, and -- as the end of flags", () => {
    expect(parse(["- item"]).positionals).toEqual(["- item"]);
    expect(parse(["---"]).positionals).toEqual(["---"]);
    expect(parse(["--limit", "-5"]).flags.limit).toBe("-5");
    expect(parse(["--note", "--- draft ---"]).flags.note).toBe("--- draft ---");
    expect(parse(["--note=--starts-with-dashes"]).flags.note).toBe("--starts-with-dashes");
    expect(parse(["--", "--closed"]).positionals).toEqual(["--closed"]);
    expect(parse(["--note", ""]).flags.note).toBe("");
  });

  it("ignores --help, which the SDK answers before a handler runs", () => {
    expect(parse(["--help"]).flags).toEqual({});
  });

  it("takes the --json-out path only with =", () => {
    expect(parse(["01ABC", "--json-out"]).jsonOut?.auto).toBe(true);
    const explicit = parse(["01ABC", `--json-out=${join(scratch, "out.json")}`]);
    expect(explicit.jsonOut).toMatchObject({ auto: false, path: join(scratch, "out.json") });

    // The space form: a path-looking token after the bare flag...
    const spaced = failure(() => parse(["--json-out", "out.json"]));
    expect(spaced.code).toBe("USAGE");
    expect(spaced.suggestions[0]).toContain("--json-out=<path>");
    // ...and any token that overflows the positionals because it followed the flag.
    const overflow = failure(() => parse(["01ABC", "--json-out", "somewhere"]));
    expect(overflow.suggestions[0]).toContain("--json-out=<path>");
    // A real positional after the bare flag is still a positional.
    expect(parse(["--json-out", "01ABC"]).positionals).toEqual(["01ABC"]);

    expect(failure(() => parse(["--json-out", "--json-out"])).message).toBe("--json-out was given more than once");
    expect(failure(() => parse(["--json-out="])).code).toBe("VALIDATION_ERROR");
  });

  it("checks the rest of the invocation before touching the filesystem for --json-out", () => {
    const missing = join(scratch, "no-such-dir", "out.json");
    // The unknown flag wins over the unwritable path: nothing was validated on disk.
    expect(failure(() => parse([`--json-out=${missing}`, "--bogus"])).code).toBe("UNKNOWN_FLAG");
    expect(failure(() => parse([`--json-out=${missing}`])).code).toBe("VALIDATION_ERROR");
  });
});

describe("formatError", () => {
  it("exits 2 for every usage code and 1 otherwise, rendering as the SDK does", () => {
    for (const code of ["VALIDATION_ERROR", "UNKNOWN_FLAG", "USAGE"]) {
      expect(formatError(new AxiError("bad", code)).exitCode).toBe(2);
    }
    expect(formatError(new AxiError("down", "HTTP_ERROR")).exitCode).toBe(1);
    expect(formatError(new Error("boom"))).toEqual({ output: "error: boom\ncode: UNKNOWN\n", exitCode: 1 });
    expect(formatError(new AxiError("bad", "USAGE", ["do this"])).output).toBe("error: bad\ncode: USAGE\nhelp[1]: do this\n");
  });
});
