import { describe, expect, it } from "bun:test";
import { AxiError } from "axi-sdk-js";
import { DEFAULT_SERVER, resolveServer, buildMultipartForm } from "./client.js";
import { parseArgs, collectFlag, parseNumberFlag, splitCsv } from "./args.js";
import { sumEffective, effectiveMacro, targetLine, nestedSugarLine } from "./format.js";
import { commandReferenceText, COMMAND_GROUPS, MACRO_PANEL_FLAGS, MACRO_PANEL_FLAG_NAMES } from "./reference.js";
import { spliceGeneratedRegions, commandReferenceMarkdown } from "./skill.js";
import { buildLogEntryFields, buildPatchBody } from "./commands/entries.js";
import {
  assertConvertShelfLifeClass,
  assertEventType,
  buildDismissBody,
  INVENTORY_HELP,
} from "./commands/inventory.js";
import { buildProductWriteBody } from "./commands/products.js";
import { ensureExplicitOffset } from "./commands/weigh-ins.js";

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

describe("daily-target lines (§ Daily targets — direction-aware remaining)", () => {
  it("renders a max as logged / target with what's left, or the overrun", () => {
    expect(targetLine(60, { max: 100 })).toBe("60 / 100 max (40 left)");
    expect(targetLine(100, { max: 100 })).toBe("100 / 100 max (0 left)");
    // A max exceeded is a breach — say so, never a negative "left".
    expect(targetLine(142, { max: 100 })).toBe("142 / 100 max (42 over)");
  });

  it("renders a min as to-go until reached, then met — a met floor is success, not an overrun", () => {
    expect(targetLine(10, { min: 42 })).toBe("10 / 42 min (32 to go)");
    expect(targetLine(42, { min: 42 })).toBe("42 / 42 min (met)");
    expect(targetLine(50, { min: 42 })).toBe("50 / 42 min (met)");
  });
});

describe("nested sugar figure (§ Display: one nested bar, not two)", () => {
  it("shows a fruit-and-dairy day as high total sugar with NO over verdict", () => {
    // The exact false alarm this split retires: a day of fruit, milk, and plain
    // yogurt carries a big TOTAL sugar number and almost no added sugar. The
    // total must read as a bare quantity — no threshold, no breach language —
    // while the verdict belongs solely to the added portion.
    const line = nestedSugarLine(62.4, 1.2, { max: 36 });
    expect(line).toBe("62.4 total, added 1.2 / 36 max (34.8 left)");
    expect(line).not.toContain("over");
  });

  it("puts the verdict on the ADDED portion when that is what breached", () => {
    const line = nestedSugarLine(70, 48, { max: 36 });
    expect(line).toBe("70 total, added 48 / 36 max (12 over)");
    // Still one figure, and the overrun is measured against the added ceiling —
    // never against the total, which has no line to cross.
    expect(line).not.toContain("70 / ");
  });

  it("renders a missing added portion as unknown, never as a clean 0", () => {
    // A day (typically a historical one, never backfilled) where no entry
    // carried added sugar is UNKNOWN. Reporting 0 there would invent a verified
    // clean day out of missing data.
    expect(nestedSugarLine(48, null, { max: 36 })).toBe("48 total, added unknown");
    expect(nestedSugarLine(48, null)).toBe("48 total, added unknown");
  });

  it("keeps the pair in ONE figure when no ceiling is configured", () => {
    expect(nestedSugarLine(30, 5)).toBe("30 total, added 5");
    expect(nestedSugarLine(null, null)).toBe("unknown total, added unknown");
  });

  it("shows an asserted zero as zero — a whole-food day is 0 added, not unknown", () => {
    expect(nestedSugarLine(41, 0, { max: 36 })).toBe("41 total, added 0 / 36 max (36 left)");
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

  it("buildLogEntryFields coerces a date-only --at to local noon and omits logged_at when absent", () => {
    // A bare YYYY-MM-DD now backstops to local noon (specs/modules/kitchen.md
    // § Logged-at backdating). Zone-independent assertion: local noon, that day.
    const withAt = parseArgs(["snack", "--at", "2026-07-18"], ["json"], ["recipe", "component", "at"]);
    const loggedAt = buildLogEntryFields(withAt.positionals, withAt.flags, []).logged_at as string;
    const d = new Date(loggedAt);
    expect(d.getHours()).toBe(12); // local noon, never midnight UTC
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6); // July
    expect(d.getDate()).toBe(18);

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
    // Only logged_at is present, and the bare date coerces to local noon that
    // day (specs/modules/kitchen.md § Logged-at backdating). Zone-independent.
    expect(Object.keys(body)).toEqual(["logged_at"]);
    const d = new Date(body.logged_at as string);
    expect(d.getHours()).toBe(12);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5); // June
    expect(d.getDate()).toBe(15);
  });
});

describe("entries log — directly-stated panel wiring", () => {
  const LOG_FLAGS = ["recipe", "component", "at", "label", ...MACRO_PANEL_FLAG_NAMES];

  it("builds a macros panel from per-field flags (mirrors patch macro flags)", () => {
    const { positionals, flags } = parseArgs(
      ["--calories", "620", "--protein", "41", "--fat", "22", "--sat-fat", "7", "--carbs", "58", "--sugar", "12", "--added-sugar", "4", "--fiber", "9", "--sodium", "880", "--label", "test bowl"],
      ["json"],
      LOG_FLAGS,
    );
    const entry = buildLogEntryFields(positionals, flags, []);
    expect(entry.macros).toEqual({
      calories: 620,
      protein_g: 41,
      fat_g: 22,
      sat_fat_g: 7,
      carbs_g: 58,
      sugar_g: 12,
      added_sugar_g: 4,
      fiber_g: 9,
      sodium_mg: 880,
    });
    expect(entry.label).toBe("test bowl");
    // A directly-stated panel is not a note/recipe entry.
    expect(entry.note).toBeUndefined();
    expect(entry.recipe_ulid).toBeUndefined();
  });

  it("omits unstated panel fields (server stores them null, never 0)", () => {
    const { positionals, flags } = parseArgs(["--calories", "200", "--protein", "15"], ["json"], LOG_FLAGS);
    const entry = buildLogEntryFields(positionals, flags, []);
    expect(entry.macros).toEqual({ calories: 200, protein_g: 15 });
  });

  it("rejects a directly-stated panel combined with --recipe or --component", () => {
    const withRecipe = parseArgs(["--calories", "200", "--recipe", "01ABC"], ["json"], LOG_FLAGS);
    expect(() => buildLogEntryFields(withRecipe.positionals, withRecipe.flags, [])).toThrow(AxiError);

    const withComponent = parseArgs(["--calories", "200"], ["json"], LOG_FLAGS);
    expect(() => buildLogEntryFields(withComponent.positionals, withComponent.flags, [{ label: "rice", quantity_g: 100 }])).toThrow(AxiError);
  });

  it("rejects --label sent without a panel", () => {
    const { positionals, flags } = parseArgs(["chicken", "salad", "--label", "nope"], ["json"], LOG_FLAGS);
    expect(() => buildLogEntryFields(positionals, flags, [])).toThrow(AxiError);
  });

  it("rejects a non-numeric macro flag before any network call", () => {
    const { positionals, flags } = parseArgs(["--calories", "lots"], ["json"], LOG_FLAGS);
    expect(() => buildLogEntryFields(positionals, flags, [])).toThrow(AxiError);
  });

  it("still requires a note, recipe, or panel", () => {
    const { positionals, flags } = parseArgs([], ["json"], LOG_FLAGS);
    expect(() => buildLogEntryFields(positionals, flags, [])).toThrow(AxiError);
  });
});

describe("macro-panel flag parity between entries log and entries patch", () => {
  const PATCH_FLAGS = ["note", "label", "portion-basis", ...MACRO_PANEL_FLAG_NAMES, "multiplier", "at"];

  it("names the full nine-field panel in one place", () => {
    expect(MACRO_PANEL_FLAG_NAMES).toEqual([
      "calories",
      "protein",
      "fat",
      "sat-fat",
      "carbs",
      "sugar",
      "added-sugar",
      "fiber",
      "sodium",
    ]);
  });

  it("patch maps every panel flag to its server field — added sugar included", () => {
    const args = MACRO_PANEL_FLAGS.flatMap(([flag], i) => [`--${flag}`, String(i + 1)]);
    const { flags } = parseArgs(args, ["json"], PATCH_FLAGS);
    const body = buildPatchBody(flags);
    expect(body).toEqual({
      calories: 1,
      protein_g: 2,
      fat_g: 3,
      sat_fat_g: 4,
      carbs_g: 5,
      sugar_g: 6,
      added_sugar_g: 7,
      fiber_g: 8,
      sodium_mg: 9,
    });
  });

  it("patches sugar or fiber alone (the correction path that had no flag documented)", () => {
    expect(buildPatchBody(parseArgs(["--fiber", "12"], ["json"], PATCH_FLAGS).flags)).toEqual({ fiber_g: 12 });
    expect(buildPatchBody(parseArgs(["--sugar", "3.5"], ["json"], PATCH_FLAGS).flags)).toEqual({ sugar_g: 3.5 });
  });

  it("patches added sugar alone — correcting it in place, never delete + re-log", () => {
    // The entry keeps its ULID (and everything referencing it) while the one
    // wrong number is fixed; a whole-food entry the estimator left null becomes
    // an asserted 0 this way.
    expect(buildPatchBody(parseArgs(["--added-sugar", "4.5"], ["json"], PATCH_FLAGS).flags)).toEqual({
      added_sugar_g: 4.5,
    });
    expect(buildPatchBody(parseArgs(["--added-sugar", "0"], ["json"], PATCH_FLAGS).flags)).toEqual({
      added_sugar_g: 0,
    });
  });

  it("documents every panel flag on BOTH usage lines (parity can't drift)", () => {
    const entries = COMMAND_GROUPS.find((g) => g.group === "Entries")!.commands;
    const log = entries.find((c) => c.usage.startsWith("entries log"))!.usage;
    const patch = entries.find((c) => c.usage.startsWith("entries patch"))!.usage;
    for (const flag of MACRO_PANEL_FLAG_NAMES) {
      expect(log).toContain(`--${flag} `);
      expect(patch).toContain(`--${flag} `);
    }
  });
});

describe("command reference (single source of truth)", () => {
  it("covers every spec-listed command group", () => {
    const groups = COMMAND_GROUPS.map((g) => g.group);
    expect(groups).toEqual(["Entries", "Daily rollup", "Expenditure", "Weigh-ins", "Inventory", "Receipts", "Recipes", "Products & lexicon"]);
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

describe("weigh-ins --at offset handling", () => {
  it("ensureExplicitOffset passes explicit offsets through untouched", () => {
    expect(ensureExplicitOffset("2026-01-15T08:30:00Z")).toBe("2026-01-15T08:30:00Z");
    expect(ensureExplicitOffset("2026-01-15T08:30:00-05:00")).toBe("2026-01-15T08:30:00-05:00");
    expect(ensureExplicitOffset("2026-01-15T08:30:00+0530")).toBe("2026-01-15T08:30:00+0530");
  });

  it("attaches the machine's local offset (for THAT date) to a naive timestamp", () => {
    // The server 400s zone-naive occurred_at; the CLI knows its own zone and
    // attaches it. Zone-independent assertion: whatever machine runs this,
    // the attached offset must equal the local offset in effect on the date.
    const out = ensureExplicitOffset("2026-01-15T08:30:00");
    expect(out.startsWith("2026-01-15T08:30:00")).toBe(true);
    const match = /([+-])(\d{2}):(\d{2})$/.exec(out);
    expect(match).not.toBeNull();
    const attached = (match![1] === "-" ? -1 : 1) * (Number(match![2]) * 60 + Number(match![3]));
    // `+ 0` normalizes -0: on a UTC-offset-0 machine the negated
    // getTimezoneOffset() is -0, and Object.is(-0, 0) is false, so a bare toBe
    // failed there. (It only ever passed because a sibling test file sets
    // process.env.TZ at import time — true isolation exposed it.)
    const expected = -new Date(2026, 0, 15, 8, 30, 0).getTimezoneOffset() + 0;
    expect(attached).toBe(expected);
    // Round-trip: the string parses to the same instant the naive local time meant.
    expect(new Date(out).getTime()).toBe(new Date(2026, 0, 15, 8, 30, 0).getTime());
  });
});

describe("convert made-food shelf-life guard (CLI)", () => {
  // § Shelf-life classes — the CLI blocks a package-durable `--to`
  // shelf_life_class before the network call, surfacing a structured AXI error
  // that names the valid made-food set (mirrors the server's 400).
  it("rejects each package-durable class with a structured AxiError naming the made-food set", () => {
    for (const badClass of ["pantry", "fridge_long", "fridge_short"]) {
      let thrown: unknown;
      try {
        assertConvertShelfLifeClass(badClass);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AxiError);
      expect((thrown as AxiError).code).toBe("VALIDATION_ERROR");
      expect((thrown as AxiError).message).toContain("prepared, produce, very_perishable, frozen");
      expect((thrown as AxiError).message).toContain(badClass);
    }
  });

  it("passes made-food classes and an omitted class (server defaults to prepared)", () => {
    for (const okClass of ["prepared", "produce", "very_perishable", "frozen"]) {
      expect(() => assertConvertShelfLifeClass(okClass)).not.toThrow();
    }
    expect(() => assertConvertShelfLifeClass(undefined)).not.toThrow();
  });
});

describe("product write body (§ Product corrections)", () => {
  it("sends ONLY the supplied flags, so `products update` is genuinely partial", () => {
    // The whole point of the PATCH door: an absent flag must not reach the wire
    // as null, or every correction would clobber the fields it didn't mention.
    const body = buildProductWriteBody({ nutrition: '{"sodium_mg": 120}' });
    expect(Object.keys(body)).toEqual(["nutrition_per_100g"]);
    expect(body.nutrition_per_100g).toEqual({ sodium_mg: 120 });
  });

  it("treats an empty-string flag as an explicit clear (null on the wire)", () => {
    const body = buildProductWriteBody({ "package-size": "", ingredients: "", nutrition: "" });
    expect(body).toEqual({ package_size: null, ingredients: null, nutrition_per_100g: null });
  });

  it("maps --negligible / --no-negligible to the boolean either way", () => {
    expect(buildProductWriteBody({ negligible: true })).toEqual({ nutrition_negligible: true });
    expect(buildProductWriteBody({ "no-negligible": true })).toEqual({ nutrition_negligible: false });
    expect(buildProductWriteBody({})).toEqual({});
  });

  it("validates the enums it forwards rather than letting the server guess", () => {
    expect(() => buildProductWriteBody({ "shelf-life": "cupboard" })).toThrow(AxiError);
    expect(() => buildProductWriteBody({ "unit-model": "sealed" })).toThrow(AxiError);
    expect(buildProductWriteBody({ "unit-model": "counted" })).toEqual({ unit_model_hint: "counted" });
  });
});

describe("inventory retirement + merge are reachable and discoverable", () => {
  it("documents dismiss, merge, and recount in the generated reference", () => {
    // The whole defect this closes: `dismiss` shipped server-side but appeared
    // in neither the CLI's command list nor the event enum, so the only
    // retirement an agent could FIND was `event finished` — a consumption that
    // never happened. A verb absent from the reference is a verb agents fall
    // back from.
    const text = commandReferenceText();
    for (const usage of ["inventory dismiss <ulid>", "inventory merge <ulid> --into <ulid>", "inventory recount <ulid>"]) {
      expect(text).toContain(usage);
    }
  });

  it("enumerates every reachable state, and the verb for each, in the inventory help", () => {
    for (const state of ["stocked", "open", "finished", "tossed", "dismissed"]) {
      expect(INVENTORY_HELP).toContain(state);
    }
    // Not just the names — how each is reached, including the way back out.
    expect(INVENTORY_HELP).toContain("inventory dismiss <ulid>");
    expect(INVENTORY_HELP).toContain("recount --state stocked|open");
  });

  it("redirects `event … dismissed` to the real verb instead of refusing flatly", () => {
    expect(() => assertEventType("dismissed", "01ABC")).toThrow(AxiError);
    try {
      assertEventType("dismissed", "01ABC");
      throw new Error("should have thrown");
    } catch (err) {
      const suggestions = (err as AxiError).suggestions.join(" ");
      expect(suggestions).toContain("inventory dismiss 01ABC");
      expect(suggestions).toContain("--non-inventory");
    }
    // A genuinely unknown type still names the enum — and still points at the
    // fifth state's verb, so the enum is never a dead end.
    try {
      assertEventType("archived");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as AxiError).message).toContain("finished-unit");
      expect((err as AxiError).message).toContain("inventory dismiss");
    }
    for (const ok of ["opened", "finished", "finished-unit", "tossed"]) {
      expect(() => assertEventType(ok)).not.toThrow();
    }
  });

  it("sends non_inventory only when asked (a one-off phantom must not teach the parser a rule)", () => {
    expect(buildDismissBody({})).toEqual({});
    expect(buildDismissBody({ "non-inventory": true })).toEqual({ non_inventory: true });
    // `--at` goes through the same bare-date coercion every other verb uses
    // (local noon, never midnight UTC — which would land on the wrong day).
    expect(String(buildDismissBody({ at: "2026-07-19" }).at)).toStartWith("2026-07-19T12:00:00");
  });
});

describe("command reference covers every product write door", () => {
  it("documents update, merge, and archive alongside add", () => {
    // A verb the CLI accepts but the reference omits is a verb agents fall back
    // from — the delete-and-re-add reflex the upsert exists to remove.
    const text = commandReferenceText();
    for (const usage of ["products add", "products update", "products merge", "products archive"]) {
      expect(text).toContain(usage);
    }
    expect(text).toContain("--negligible");
  });
});
