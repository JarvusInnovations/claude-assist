import { describe, expect, it } from "bun:test";
import { AxiError } from "axi-sdk-js";
import { DEFAULT_SERVER, resolveServer, buildMultipartForm } from "./client.js";
import { parseArgs, collectFlag, parseNumberFlag, splitCsv } from "./args.js";
import { sumEffective, effectiveMacro } from "./format.js";
import { commandReferenceText, COMMAND_GROUPS } from "./reference.js";
import { spliceGeneratedRegions, commandReferenceMarkdown } from "./skill.js";
import { buildLogEntryFields, buildPatchBody } from "./commands/entries.js";

describe("resolveServer", () => {
  it("defaults to localhost and strips trailing slashes from the env override", () => {
    expect(resolveServer({})).toBe(DEFAULT_SERVER);
    expect(resolveServer({ CLAUDE_ASSIST_SERVER: "http://box:2529/" })).toBe("http://box:2529");
    expect(resolveServer({ CLAUDE_ASSIST_SERVER: "  " })).toBe(DEFAULT_SERVER);
  });
});

describe("args", () => {
  it("parses value flags, boolean flags, and positionals", () => {
    const { positionals, flags } = parseArgs(["show", "01ABC", "--limit", "5", "--json"], ["json"]);
    expect(positionals).toEqual(["show", "01ABC"]);
    expect(flags.limit).toBe("5");
    expect(flags.json).toBe(true);
  });

  it("rejects unknown flags by name when the command declares its flags (fail loud)", () => {
    // A silently dropped flag would hand the agent plausible-looking but
    // unscoped output — e.g. `inventory list --stat closed` must not run
    // the unfiltered query.
    expect(() => parseArgs(["--stat", "closed"], ["json", "closed"], ["state", "limit"])).toThrow(/Unknown flag --stat/);
    try {
      parseArgs(["--stat", "closed"], ["json", "closed"], ["state", "limit"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as AxiError).suggestions.join(" ")).toContain("--state");
    }
    // Known flags still pass, and legacy two-arg calls stay permissive.
    expect(parseArgs(["--state", "open"], ["json"], ["state"]).flags.state).toBe("open");
    expect(parseArgs(["--anything", "x"], ["json"]).flags.anything).toBe("x");
  });

  it("collects a repeatable flag in order", () => {
    const args = ["--component", "rice=150", "--component", "chicken=120", "--json"];
    expect(collectFlag(args, "component", ["json"])).toEqual(["rice=150", "chicken=120"]);
  });

  it("parseNumberFlag enforces bounds and rejects non-numbers", () => {
    expect(parseNumberFlag("0.5", "multiplier", "usage", { min: 0, max: 20 })).toBe(0.5);
    expect(() => parseNumberFlag("nope", "multiplier", "usage")).toThrow(AxiError);
    expect(() => parseNumberFlag("21", "multiplier", "usage", { max: 20 })).toThrow(AxiError);
  });

  it("splitCsv trims and drops empties", () => {
    expect(splitCsv("a, b ,,c")).toEqual(["a", "b", "c"]);
  });
});

describe("effective macros (base × multiplier)", () => {
  const base = { calories: 400, protein_g: 30, fat_g: 10, sat_fat_g: 3, carbs_g: 40, sodium_mg: 500 };

  it("scales one field by the multiplier, leaving base untouched", () => {
    expect(effectiveMacro({ ...base, portion_multiplier: 0.5 }, "calories")).toBe(200);
    expect(effectiveMacro({ ...base, portion_multiplier: 1 }, "protein_g")).toBe(30);
  });

  it("returns null for a null base field (nulls are not zeroed)", () => {
    expect(effectiveMacro({ calories: null, portion_multiplier: 2 }, "calories")).toBeNull();
  });

  it("re-adjusting the multiplier always rescales from the base (idempotent, never compounds)", () => {
    // 0.5 then 0.75 must be 0.75×base, not 0.375×base — the wire stays base-only.
    const afterHalf = { ...base, portion_multiplier: 0.5 };
    const afterThreeQuarter = { ...base, portion_multiplier: 0.75 };
    expect(effectiveMacro(afterHalf, "calories")).toBe(200);
    expect(effectiveMacro(afterThreeQuarter, "calories")).toBe(300);
  });

  it("sums effective macros across entries, skipping null bases", () => {
    const totals = sumEffective([
      { ...base, portion_multiplier: 0.5 },
      { calories: 100, protein_g: null, portion_multiplier: 2 },
    ]);
    expect(totals.calories).toBe(400); // 200 + 200
    expect(totals.protein_g).toBe(15); // 15 + (null skipped)
  });
});

describe("receipts scan multipart part-type rule", () => {
  it("sends the receipt meta as a form FIELD, not a file part", async () => {
    const form = await buildMultipartForm("receipt", { ulid: "01ABC", store: "Corner Market" }, []);
    const meta = form.get("receipt");
    // A form field round-trips as a string; a file part would be a File/Blob.
    expect(typeof meta).toBe("string");
    expect(meta).not.toBeInstanceOf(Blob);
    expect(JSON.parse(meta as string)).toEqual({ ulid: "01ABC", store: "Corner Market" });
  });
});

describe("entries --at wiring (claude-assist#111)", () => {
  it("buildLogEntryFields carries --at through as logged_at", () => {
    const { positionals, flags } = parseArgs(
      ["had", "eggs", "--at", "2026-07-18T08:00:00Z"],
      ["json"],
      ["recipe", "component", "at"],
    );
    const entry = buildLogEntryFields(positionals, flags, []);
    expect(entry.note).toBe("had eggs");
    expect(entry.logged_at).toBe("2026-07-18T08:00:00Z");
  });

  it("buildLogEntryFields accepts a date-only --at and omits logged_at when absent", () => {
    const withAt = parseArgs(["snack", "--at", "2026-07-18"], ["json"], ["recipe", "component", "at"]);
    expect(buildLogEntryFields(withAt.positionals, withAt.flags, []).logged_at).toBe("2026-07-18");

    const withoutAt = parseArgs(["snack"], ["json"], ["recipe", "component", "at"]);
    expect(buildLogEntryFields(withoutAt.positionals, withoutAt.flags, []).logged_at).toBeUndefined();
  });

  it("buildLogEntryFields rejects an unparseable --at before any network call", () => {
    const { positionals, flags } = parseArgs(["snack", "--at", "not-a-date"], ["json"], ["recipe", "component", "at"]);
    expect(() => buildLogEntryFields(positionals, flags, [])).toThrow(AxiError);
  });

  it("buildPatchBody carries --at through as logged_at, composable with other fields", () => {
    const { flags } = parseArgs(
      ["01ABC", "--multiplier", "0.5", "--at", "2026-07-01T12:00:00Z"],
      ["json"],
      ["note", "label", "portion-basis", "calories", "protein", "fat", "sat-fat", "carbs", "sodium", "multiplier", "at"],
    );
    const body = buildPatchBody(flags);
    expect(body.logged_at).toBe("2026-07-01T12:00:00Z");
    expect(body.portion_multiplier).toBe(0.5);
  });

  it("buildPatchBody with only --at never touches note/label/macro fields (metadata-only edit)", () => {
    const { flags } = parseArgs(
      ["01ABC", "--at", "2026-06-15"],
      ["json"],
      ["note", "label", "portion-basis", "calories", "protein", "fat", "sat-fat", "carbs", "sodium", "multiplier", "at"],
    );
    const body = buildPatchBody(flags);
    expect(body).toEqual({ logged_at: "2026-06-15" });
  });
});

describe("command reference (single source of truth)", () => {
  it("covers every spec-listed command group", () => {
    const groups = COMMAND_GROUPS.map((g) => g.group);
    expect(groups).toEqual(["Entries", "Inventory", "Receipts", "Recipes", "Products & lexicon"]);
  });

  it("renders the reference as text and markdown from the same source", () => {
    expect(commandReferenceText()).toContain("entries patch <ulid>");
    expect(commandReferenceMarkdown()).toContain("scripts/kitchen-axi entries list");
  });

  it("splices the generated region and errors when the markers are missing", () => {
    const doc = "before\n<!-- BEGIN GENERATED: command-reference -->\nold\n<!-- END GENERATED: command-reference -->\nafter";
    const out = spliceGeneratedRegions(doc);
    expect(out).toContain("scripts/kitchen-axi entries list");
    expect(out.startsWith("before")).toBe(true);
    expect(out.trimEnd().endsWith("after")).toBe(true);
    expect(() => spliceGeneratedRegions("no markers here")).toThrow();
  });
});
