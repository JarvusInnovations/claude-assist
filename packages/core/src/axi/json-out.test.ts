import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { captureJson, describePayload, requestJsonOut, withJsonOut } from "./json-out.js";

const TOOL = "tool-axi";
const ROWS = [
  { id: 1, product_name: "oats", on_hand_fraction: 0.5 },
  { id: 2, product_name: "rice", note: "new" },
];

function failure(fn: () => unknown): AxiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AxiError) return err;
    throw err;
  }
  throw new Error("expected an AxiError");
}

/** A command that asks for an export the way the parser does, then captures a payload. */
function command(value: true | string | undefined, payload: unknown, view: string) {
  return withJsonOut(async () => {
    if (value !== undefined) requestJsonOut(TOOL, "items list", value);
    captureJson(payload);
    return view;
  });
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("--json-out", () => {
  let prevTmp: string | undefined;
  let scratch: string;
  beforeAll(() => {
    prevTmp = process.env.TMPDIR;
    scratch = mkdtempSync(join(tmpdir(), "axi-json-out-test-"));
    process.env.TMPDIR = scratch;
  });
  afterAll(() => {
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
    rmSync(scratch, { recursive: true, force: true });
  });
  afterEach(() => {
    process.exitCode = 0;
  });

  it("leaves the view untouched when the flag was not passed", async () => {
    expect(await command(undefined, ROWS, "items[2]{id}:\n  1\n  2")()).toBe("items[2]{id}:\n  1\n  2");
  });

  it("a bare flag writes a 0600 file in a 0700 <tmpdir>/<tool> directory, whatever the umask", async () => {
    const prevUmask = process.umask(0o022);
    let out: string;
    try {
      // A directory left group/world-open by an earlier run is tightened, not trusted as is.
      mkdirSync(join(scratch, TOOL), { recursive: true });
      chmodSync(join(scratch, TOOL), 0o755);
      out = await command(true, ROWS, "items[2]{id}:\n  1\n  2")();
    } finally {
      process.umask(prevUmask);
    }
    const wrote = /^wrote: (\S+) \(2 rows, 4 cols\)$/m.exec(out);
    expect(wrote).not.toBeNull();
    const path = wrote![1]!;
    expect(path.startsWith(join(scratch, TOOL) + "/")).toBe(true);
    expect(path).toMatch(/\/\d{4}-\d{2}-\d{2}T[\d-]+Z-items-list\.json$/);
    expect(mode(path)).toBe(0o600);
    expect(mode(join(scratch, TOOL))).toBe(0o700);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(ROWS);
  });

  it("adds only wrote:, columns: and one runnable jq hint to stdout", async () => {
    const view = "items[2]{id}:\n  1\n  2";
    const out = await command(true, ROWS, view)();
    const lines = out.split("\n");
    expect(lines.slice(0, 3).join("\n")).toBe(view);
    expect(lines[3]).toMatch(/^wrote: /);
    expect(lines[4]).toBe("columns: id, product_name, on_hand_fraction, note");
    expect(lines[5]).toBe("help[1]:");
    const hint = /^  Run `(jq '\.\[\]' \S+)` to process the full result$/.exec(lines[6]!);
    expect(hint).not.toBeNull();
    expect(lines).toHaveLength(7);

    // The printed command runs, and a column name from the table is a key in the file.
    const run = spawnSync("sh", ["-c", `${hint![1]!.replace("'.[]'", "'.[].product_name'")}`], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('"oats"\n"rice"\n');
  });

  it("joins the view's own help block instead of printing a second one", async () => {
    const out = await command(true, ROWS, "count: 2\nhelp[2]:\n  Run `a`\n  Run `b`")();
    const lines = out.split("\n");
    expect(lines[0]).toBe("count: 2");
    expect(lines[1]).toMatch(/^wrote: /);
    expect(lines[2]).toMatch(/^columns: /);
    expect(lines.slice(3, 6)).toEqual(["help[3]:", "  Run `a`", "  Run `b`"]);
    expect(lines[6]).toMatch(/^  Run `jq /);
    expect(out.match(/^help\[/gm)).toHaveLength(1);
  });

  it("never reuses an auto-named file", async () => {
    const now = new Date("2026-01-05T14:02:11.123Z");
    const run = withJsonOut(async () => {
      requestJsonOut(TOOL, "items list", true, now);
      captureJson(ROWS);
      return "v";
    });
    const first = /^wrote: (\S+)/m.exec(await run())![1]!;
    const second = /^wrote: (\S+)/m.exec(await run())![1]!;
    expect(first).toBe(join(scratch, TOOL, "2026-01-05T14-02-11-123Z-items-list.json"));
    expect(second).toBe(join(scratch, TOOL, "2026-01-05T14-02-11-123Z-items-list-2.json"));
  });

  it("writes an explicit path 0600 and reports replacing a file as overwrote:", async () => {
    const path = join(scratch, "explicit.json");
    const first = await command(path, { items: ROWS, total: 2 }, "v")();
    expect(first).toContain(`wrote: ${path} (1 object, 2 keys)`);
    expect(first).toContain("columns: items[2]{id,product_name,on_hand_fraction,note}, total");
    expect(first).toContain(`Run \`jq '.items[]' ${path}\``);
    expect(mode(path)).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ items: ROWS, total: 2 });

    chmodSync(path, 0o644);
    const second = await command(path, [], "v")();
    expect(second).toContain(`overwrote: ${path} (0 items)`);
    expect(mode(path)).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("[]\n");
  });

  it("refuses a path it could not write before the command does anything", async () => {
    const target = join(scratch, "real.json");
    writeFileSync(target, "keep");
    symlinkSync(target, join(scratch, "link.json"));
    mkdirSync(join(scratch, "adir"), { recursive: true });

    const cases: Array<[string, RegExp]> = [
      [join(scratch, "missing-dir", "out.json"), /the directory .* does not exist/],
      [join(scratch, "link.json"), /is a symlink/],
      [join(scratch, "adir"), /is a directory/],
      ["", /needs a path after the =/],
    ];
    for (const [value, message] of cases) {
      let worked = false;
      const run = withJsonOut(async () => {
        requestJsonOut(TOOL, "items add", value);
        worked = true; // the API call would be here
        return "v";
      });
      const err = await run().then(
        () => undefined,
        (e) => e as AxiError,
      );
      expect(err?.code).toBe("VALIDATION_ERROR");
      expect(err?.message).toMatch(message);
      expect(worked).toBe(false);
    }
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  it("refuses an auto directory that is not a real directory of the caller's", () => {
    const other = mkdtempSync(join(tmpdir(), "axi-json-out-link-"));
    try {
      symlinkSync(other, join(scratch, "linked-axi"));
      const err = failure(() => requestJsonOut("linked-axi", "home", true));
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err.message).toContain("is not a directory");
      expect(readdirSync(other)).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("keeps the view, adds export_error: and exits 1 when the write fails after the work", async () => {
    const dir = join(scratch, "vanishing");
    mkdirSync(dir);
    const path = join(dir, "out.json");
    const run = withJsonOut(async () => {
      requestJsonOut(TOOL, "items list", path);
      rmSync(dir, { recursive: true }); // the path was fine at parse time, and is gone by write time
      captureJson(ROWS);
      return "items[2]{id}:\n  1\n  2";
    });
    const out = await run();
    expect(out.startsWith("items[2]{id}:\n  1\n  2\n")).toBe(true);
    expect(out).toContain(`export_error: could not write ${path}: its directory does not exist`);
    expect(out).not.toContain("wrote:");
    expect(process.exitCode).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it("fails loudly when a command accepts the flag and captures nothing", async () => {
    const run = withJsonOut(async () => {
      requestJsonOut(TOOL, "items list", true);
      return "v";
    });
    const err = await run().then(
      () => undefined,
      (e) => e as AxiError,
    );
    expect(err?.code).toBe("INTERNAL_ERROR");
    expect(err?.message).toContain("produced no JSON payload");
  });

  it("does not carry a request over from a command that threw", async () => {
    const failing = withJsonOut(async () => {
      requestJsonOut(TOOL, "items list", true);
      throw new AxiError("down", "HTTP_ERROR");
    });
    await failing().catch(() => undefined);
    expect(await command(undefined, ROWS, "v")()).toBe("v");
  });
});

describe("describePayload", () => {
  it("describes arrays, objects with a record list, and scalars", () => {
    expect(describePayload([{ a: 1 }, { b: 2 }])).toEqual({ size: "2 rows, 2 cols", columns: ["a", "b"], filter: ".[]" });
    expect(describePayload(["x"])).toEqual({ size: "1 item", columns: [], filter: ".[]" });
    expect(describePayload({ today: "2026-01-05", totals: { calories: 1 }, days: [{ day: "d", calories: 2 }] })).toEqual({
      size: "1 object, 3 keys",
      columns: ["today", "totals{calories}", "days[1]{day,calories}"],
      filter: ".days[]",
    });
    expect(describePayload({ deleted: "01ABC" })).toEqual({ size: "1 object, 1 key", columns: ["deleted"], filter: "." });
    expect(describePayload({ "odd key": [{ a: 1 }] }).filter).toBe('.["odd key"][]');
    expect(describePayload(null)).toEqual({ size: "null", columns: [], filter: "." });
  });
});
