import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { COMMANDS, COMMAND_HELP } from "./cli.js";
import { FLAG_SPECS } from "./flag-specs.js";
import type { FlagSpec } from "../../../core/src/axi/flags.js";

/**
 * Conformance with specs/behaviors/axi-cli-arguments-and-export.md. `fetch` is
 * replaced throughout: the parse-time tests assert it is never called, and the
 * export tests serve fixed bodies from it. Nothing reaches a server.
 */

const SPECS = FLAG_SPECS as Record<string, FlagSpec>;
const run = (command: string, args: string[]) => COMMANDS[command]!(args, undefined) as Promise<string>;

async function failure(command: string, args: string[]): Promise<AxiError> {
  try {
    await run(command, args);
  } catch (err) {
    if (err instanceof AxiError) return err;
    throw err;
  }
  throw new Error(`expected \`${command} ${args.join(" ")}\` to fail`);
}

const SESSIONS = [
  {
    id: "7a2f1c3e-0000-4000-8000-000000000001",
    started_at: "2026-01-02T10:00:00Z",
    project_path: "/home/user/repos/acme",
    title: "Auth refactor",
    session_name: null,
    user_message_count: 12,
    tools_used: ["Bash", "Edit"],
    machine: "laptop",
  },
];
const SESSION_DETAIL = { ...SESSIONS[0], message_count: 40, raw_messages: [{ role: "user" }] };

describe("sessions-axi", () => {
  const realFetch = globalThis.fetch;
  let requests: string[] = [];
  let prevTmp: string | undefined;
  let prevServer: string | undefined;
  let scratch: string;

  beforeAll(() => {
    prevTmp = process.env.TMPDIR;
    prevServer = process.env.CLAUDE_ASSIST_SERVER;
    scratch = mkdtempSync(join(tmpdir(), "sessions-axi-test-"));
    process.env.TMPDIR = scratch;
    process.env.CLAUDE_ASSIST_SERVER = "http://sessions.invalid";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/api/sessions") return Response.json(SESSIONS);
      if (url.pathname.endsWith("/transcript") && url.searchParams.has("around")) {
        return Response.json({ lines: ["[U] hi"], more_before: 0, more_after: 0, head: "u1", tail: "u1" });
      }
      if (url.pathname.startsWith("/api/sessions/7a2f")) return Response.json(SESSION_DETAIL);
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
    if (prevServer === undefined) delete process.env.CLAUDE_ASSIST_SERVER;
    else process.env.CLAUDE_ASSIST_SERVER = prevServer;
    rmSync(scratch, { recursive: true, force: true });
  });
  afterEach(() => {
    requests = [];
    process.exitCode = 0;
  });

  describe("declared arguments", () => {
    it("rejects an unknown flag on every command, before any request, listing that command's flags", async () => {
      for (const [command, spec] of Object.entries(SPECS)) {
        const err = await failure(command, ["--bogus"]);
        expect(err.code).toBe("UNKNOWN_FLAG");
        expect(err.message).toBe(`unknown flag --bogus for \`${command}\``);
        const hint = err.suggestions.join(" ");
        for (const flag of [...(spec.value ?? []), ...(spec.boolean ?? []), "json-out"]) expect(hint).toContain(`--${flag}`);
      }
      expect(requests).toEqual([]);
    });

    it("no longer runs an unfiltered search for a misspelled flag (#99)", async () => {
      const err = await failure("search", ["--querry", "auth"]);
      expect(err.code).toBe("UNKNOWN_FLAG");
      expect(err.suggestions[0]).toContain("--query");
      expect(requests).toEqual([]);
    });

    it("answers --json on every command with the --json-out hint, bare and trailing", async () => {
      for (const command of Object.keys(SPECS)) {
        const err = await failure(command, ["--json"]);
        expect(err.code).toBe("UNKNOWN_FLAG");
        expect(err.suggestions[0]).toContain("use --json-out");
      }
      expect(requests).toEqual([]);
    });

    it("rejects a positional beyond what the command takes", async () => {
      for (const [command, spec] of Object.entries(SPECS)) {
        if (spec.positionals === "many") continue;
        const extra = Array.from({ length: (spec.positionals ?? 0) + 1 }, (_, i) => `arg${i}`);
        const err = await failure(command, extra);
        expect(err.code).toBe("USAGE");
        expect(err.message).toContain(`unexpected argument for \`${command}\``);
      }
      expect(requests).toEqual([]);
    });

    it("documents every declared flag in that command's --help, and --json nowhere", () => {
      for (const [command, spec] of Object.entries(SPECS)) {
        const help = COMMAND_HELP[command]!;
        expect(help).toBeDefined();
        for (const flag of [...(spec.value ?? []), ...(spec.boolean ?? []), "json-out"]) {
          if (!help.includes(`--${flag}`)) throw new Error(`\`${command}\` declares --${flag}, which its --help does not mention`);
        }
        expect(help).not.toMatch(/--json(?!-out)/);
      }
    });
  });

  describe("--json-out", () => {
    it("search writes the API rows to a 0600 temp file and keeps the TOON view", async () => {
      const plain = await run("search", ["--query", "auth"]);
      const out = await run("search", ["--query", "auth", "--json-out"]);

      const path = /^wrote: (\S+) \(1 row, 8 cols\)$/m.exec(out)?.[1];
      expect(path).toBeDefined();
      expect(path!.startsWith(join(scratch, "sessions-axi") + "/")).toBe(true);
      expect(statSync(path!).mode & 0o777).toBe(0o600);
      expect(statSync(join(scratch, "sessions-axi")).mode & 0o777).toBe(0o700);
      expect(JSON.parse(readFileSync(path!, "utf8"))).toEqual(SESSIONS);

      // The rows are byte-identical; only wrote:, columns: and one help line are added.
      const rows = (text: string) => text.slice(0, text.indexOf("help["));
      expect(rows(out).replace(/wrote: .*\ncolumns: .*\n/, "")).toBe(rows(plain));
      expect(out).toContain("columns: id, started_at, project_path, title, session_name, user_message_count, tools_used, machine");
      expect(out).toContain(`  Run \`jq '.[]' ${path}\` to process the full result`);
      expect(out.match(/^help\[/gm)).toHaveLength(1);

      // The printed hint runs as printed.
      const jq = spawnSync("sh", ["-c", `jq -r '.[] | .user_message_count' ${path}`], { encoding: "utf8" });
      expect(jq.status).toBe(0);
      expect(jq.stdout).toBe("12\n");
    });

    it("names plain columns after their data keys", async () => {
      const out = await run("search", ["--query", "auth"]);
      const header = /^sessions\[1\]\{([^}]+)\}:$/m.exec(out)![1]!.split(",");
      expect(header).toEqual(["id", "started_at", "project", "title", "user_message_count", "tools_used", "machine"]);
      // `project` is computed (the last segment of project_path); every other column is a key.
      for (const column of header.filter((c) => c !== "project")) expect(Object.keys(SESSIONS[0]!)).toContain(column);
    });

    it("validates an explicit path before the request is sent", async () => {
      const err = await failure("search", [`--json-out=${join(scratch, "missing", "out.json")}`]);
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err.message).toContain("does not exist");
      expect(requests).toEqual([]);
    });

    it("details --raw puts the raw messages in the file, and needs --json-out to do it", async () => {
      const id = SESSIONS[0]!.id;
      const err = await failure("details", [id, "--raw"]);
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err.suggestions[0]).toContain(`details ${id} --raw --json-out`);
      expect(requests).toEqual([]);

      const path = join(scratch, "detail.json");
      const out = await run("details", [id, "--raw", `--json-out=${path}`]);
      expect(requests[0]).toContain("with_raw_messages=true");
      expect(out).toContain("session:"); // the TOON view, not raw JSON
      expect(out).toContain(`wrote: ${path} (1 object, `);
      expect(JSON.parse(readFileSync(path, "utf8")).raw_messages).toEqual([{ role: "user" }]);
    });

    it("engagement --blocks needs --json-out, since the blocks only go to the file", async () => {
      const err = await failure("engagement", ["--from", "2026-01-01", "--to", "2026-01-02", "--blocks"]);
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err.message).toContain("--blocks");
      expect(requests).toEqual([]);
    });

    it("transcript refuses the export for plain text and offers it for an --around window", async () => {
      const err = await failure("transcript", [SESSIONS[0]!.id, "--json-out"]);
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err.message).toContain("plain text");
      expect(requests).toEqual([]);

      const out = await run("transcript", [SESSIONS[0]!.id, "--around", "u1", "--json-out"]);
      expect(out).toContain("around u1:");
      expect(out).toMatch(/^wrote: \S+-transcript\.json \(1 object, 5 keys\)$/m);
    });
  });
});

describe("sessions-axi binary", () => {
  it("exits 2 with the hint for --json, without contacting a server", () => {
    const home = mkdtempSync(join(tmpdir(), "sessions-axi-home-"));
    try {
      const res = spawnSync(process.execPath, [join(import.meta.dir, "bin.ts"), "search", "--query", "x", "--json"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: home, CLAUDE_ASSIST_SERVER: "http://127.0.0.1:1" },
        timeout: 60_000,
      });
      expect(res.status).toBe(2);
      expect(res.stdout).toContain("error: unknown flag --json for `search`");
      expect(res.stdout).toContain("code: UNKNOWN_FLAG");
      expect(res.stdout).toContain("use --json-out");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
