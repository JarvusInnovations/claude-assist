import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { COMMANDS, COMMAND_HELP } from "./cli.js";
import { FLAG_SPECS } from "./flag-specs.js";
import type { FlagSpec } from "../../../core/src/axi/flags.js";

/**
 * Conformance with specs/behaviors/axi-cli-arguments-and-export.md, walked off
 * the declaration table so a new command is covered the day it is declared.
 * No test here reaches a server: every rejection happens at parse time, and
 * `fetch` is replaced with one that fails the test if it is called.
 */

const SPECS = FLAG_SPECS as Record<string, FlagSpec>;

/** `entries list` → the `entries` handler with `["list", …]`; `home`/`days` take their args directly. */
function run(command: string, extra: string[]): Promise<string> {
  const [group, ...sub] = command.split(" ");
  return COMMANDS[group!]!([...sub, ...extra], undefined) as Promise<string>;
}

async function failure(command: string, extra: string[]): Promise<AxiError> {
  try {
    await run(command, extra);
  } catch (err) {
    if (err instanceof AxiError) return err;
    throw err;
  }
  throw new Error(`expected \`${command} ${extra.join(" ")}\` to fail`);
}

describe("kitchen-axi argument conformance", () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  beforeAll(() => {
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("no network in this test");
    }) as unknown as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("rejects an unknown flag on every command, before any request, listing that command's flags", async () => {
    for (const [command, spec] of Object.entries(SPECS)) {
      const err = await failure(command, ["--bogus"]);
      expect(err.code).toBe("UNKNOWN_FLAG");
      expect(err.message).toBe(`unknown flag --bogus for \`${command}\``);
      const hint = err.suggestions.join(" ");
      for (const flag of [...(spec.value ?? []), ...(spec.boolean ?? []), ...(spec.multi ?? []), "json-out"]) {
        expect(hint).toContain(`--${flag}`);
      }
    }
    expect(calls).toBe(0);
  });

  it("answers --json on every command with the --json-out hint, bare and trailing", async () => {
    for (const command of Object.keys(SPECS)) {
      const err = await failure(command, ["--json"]);
      expect(err.code).toBe("UNKNOWN_FLAG");
      expect(err.suggestions[0]).toContain("use --json-out");
    }
    expect(calls).toBe(0);
  });

  it("rejects a positional beyond what the command takes", async () => {
    for (const [command, spec] of Object.entries(SPECS)) {
      if (spec.positionals === "many") continue;
      const extra = Array.from({ length: (spec.positionals ?? 0) + 1 }, (_, i) => `arg${i}`);
      const err = await failure(command, extra);
      expect(err.code).toBe("USAGE");
      expect(err.message).toContain(`unexpected argument for \`${command}\``);
    }
    expect(calls).toBe(0);
  });

  it("documents every declared flag in that group's --help", () => {
    for (const [command, spec] of Object.entries(SPECS)) {
      const help = COMMAND_HELP[command.split(" ")[0]!]!;
      expect(help).toBeDefined();
      for (const flag of [...(spec.value ?? []), ...(spec.boolean ?? []), ...(spec.multi ?? []), "json-out"]) {
        if (!help.includes(`--${flag}`)) throw new Error(`\`${command}\` declares --${flag}, which its --help does not mention`);
      }
      expect(help).not.toMatch(/--json(?!-out)/);
    }
  });

  it("declares every subcommand its dispatcher routes", async () => {
    // An undeclared subcommand would have no parser entry; an unknown one must
    // still fail as a validation error naming the group.
    const err = await failure("entries", ["nope"]);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("Unknown entries subcommand");
  });
});

describe("kitchen-axi binary", () => {
  it("exits 2 with the hint for --json, without contacting a server", () => {
    const home = mkdtempSync(join(tmpdir(), "kitchen-axi-home-"));
    try {
      const res = spawnSync(process.execPath, [join(import.meta.dir, "bin.ts"), "inventory", "list", "--json"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: home, CLAUDE_ASSIST_SERVER: "http://127.0.0.1:1" },
        timeout: 60_000,
      });
      expect(res.status).toBe(2);
      expect(res.stdout).toContain("error: unknown flag --json for `inventory list`");
      expect(res.stdout).toContain("code: UNKNOWN_FLAG");
      expect(res.stdout).toContain("use --json-out");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
