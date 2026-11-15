import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { MemoryEntryStore, MemoryExpenditureStore, MemoryRecipeStore } from "../memory-store.js";
import { registerExpenditureRoutes } from "../routes/expenditures.js";
import { registerKitchenRoutes } from "../routes/kitchen.js";
import { KitchenPipeline } from "../services/pipeline.js";
import { resolveOwnerTz } from "../zoned.js";
import { generateUlid } from "../ulid.js";
import { AxiError } from "axi-sdk-js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS } from "./cli.js";
import { daysCommand } from "./commands/days.js";
import { homeCommand } from "./commands/home.js";

/**
 * End-to-end CLI render tests for the per-day rollup: a live in-process server
 * (America/New_York) mounted under /api, driven through the real HTTP client.
 * Confirms `days` renders one row per owner-local day and `home` derives "today"
 * server-side (specs/modules/kitchen.md § Timezone & local-day bucketing).
 */
describe("kitchen-axi days / home render (§ Timezone & local-day bucketing)", () => {
  let server: FastifyInstance;
  let entries: MemoryEntryStore;
  let prevEnv: string | undefined;
  let prevTmp: string | undefined;
  let scratch: string;

  const seedEntry = async (loggedAt: string, calories: number, protein: number) => {
    const ulid = generateUlid();
    await entries.insertIfAbsent({ ulid, logged_at: new Date(loggedAt), note: "meal", recipe_ulid: null, component_quantities: null, notes_reviewed: true });
    await entries.applyEstimate(
      ulid,
      "Meal",
      { calories, protein_g: protein, fat_g: null, sat_fat_g: null, carbs_g: null, sugar_g: null, fiber_g: null, sodium_mg: null, confidence: 0.9, portion_basis: "plate" },
      "model",
      "estimated"
    );
    return ulid;
  };

  beforeAll(async () => {
    server = Fastify({ logger: false });
    entries = new MemoryEntryStore();
    const expStore = new MemoryExpenditureStore();
    const ownerTz = resolveOwnerTz("America/New_York");
    const pipeline = new KitchenPipeline(entries, new MemoryRecipeStore(), null, server.log);
    // Mount under /api so the CLI client's /api/kitchen/* paths resolve.
    await server.register(
      async (api) => {
        await api.register(registerKitchenRoutes, { pipeline, ownerTz });
        await api.register(registerExpenditureRoutes, { store: expStore, entries, tdeeBase: 2300, ownerTz });
        // Minimal inventory stubs the home view also fetches.
        api.get("/kitchen/inventory", async () => ({ items: [] }));
        api.get("/kitchen/inventory/questions", async () => ({ count: 0 }));
      },
      { prefix: "/api" }
    );

    // Two late-evening (local) meals that fall on the NEXT UTC day.
    await seedEntry("2026-06-02T01:30:00Z", 100, 10); // Jun 1 local
    await seedEntry("2026-06-03T02:00:00Z", 200, 20); // Jun 2 local

    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    prevEnv = process.env.CLAUDE_ASSIST_SERVER;
    // A bare --json-out writes under <tmpdir>/kitchen-axi; keep that in a scratch dir.
    prevTmp = process.env.TMPDIR;
    scratch = mkdtempSync(join(tmpdir(), "kitchen-axi-test-"));
    process.env.TMPDIR = scratch;
    process.env.CLAUDE_ASSIST_SERVER = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (prevEnv === undefined) delete process.env.CLAUDE_ASSIST_SERVER;
    else process.env.CLAUDE_ASSIST_SERVER = prevEnv;
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
    rmSync(scratch, { recursive: true, force: true });
    await server.close();
  });

  it("days renders one TOON row per owner-local day (bucketed server-side)", async () => {
    const out = await daysCommand(["--since", "2026-05-30"]);
    // Owner-zone days, not the UTC 2nd/3rd.
    expect(out).toContain("2026-06-01");
    expect(out).toContain("2026-06-02");
    expect(out).not.toContain("2026-06-03"); // that would be the UTC mis-bucket
    // The net line is present (TDEE base configured).
    expect(out).toContain("net");
    // A configured zone stays quiet (no fallback note).
    expect(out).not.toContain("unset");
  });

  it("days --json-out writes the raw grouped payload to a file and leaves the view as it was", async () => {
    const plain = await COMMANDS.days!(["--since", "2026-05-30"], undefined) as string;
    const out = await COMMANDS.days!(["--since", "2026-05-30", "--json-out"], undefined) as string;

    const wrote = /^wrote: (\S+) \(1 object, \d+ keys\)$/m.exec(out);
    expect(wrote).not.toBeNull();
    const path = wrote![1]!;
    expect(path.startsWith(join(scratch, "kitchen-axi") + "/")).toBe(true);
    expect(path).toMatch(/-days\.json$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.group).toBe("day");
    expect(raw.tz).toBe("America/New_York");
    expect(typeof raw.today).toBe("string");
    expect(Array.isArray(raw.days)).toBe(true);

    // Stdout is the same view plus wrote:, columns: and one more help line.
    const added = out.split("\n").filter((line) => !plain.split("\n").includes(line));
    expect(added).toHaveLength(4);
    expect(added[0]).toMatch(/^wrote: /);
    expect(added[1]).toMatch(/^columns: .*days\[\d+\]\{day,/);
    expect(added[2]).toMatch(/^help\[\d+\]:$/);
    expect(added[3]).toBe(`  Run \`jq '.days[]' ${path}\` to process the full result`);
    const rows = (text: string) => text.slice(text.indexOf("days["), text.indexOf("help["));
    expect(rows(out).replace(/wrote: .*\ncolumns: .*\n/, "")).toBe(rows(plain));

    // Every column in the table is a key of the rows in the file, so the first
    // jq expression an agent writes from the table works.
    const header = /^days\[\d+\]\{([^}]+)\}:$/m.exec(out)![1]!.split(",");
    expect(header).toContain("calories");
    expect(header).toContain("protein_g");
    for (const column of header) expect(Object.keys(raw.days[0])).toContain(column);

    // The printed hint runs as printed.
    const jq = spawnSync("sh", ["-c", `jq -c '.days[] | .day' ${path}`], { encoding: "utf8" });
    expect(jq.status).toBe(0);
    expect(jq.stdout).toContain("2026-06-01");
  });

  it("days --json is refused with the --json-out hint, before any request", async () => {
    const err = await COMMANDS.days!(["--json", "--since", "10"], undefined).then(
      () => undefined,
      (e: unknown) => e as AxiError,
    );
    expect(err?.code).toBe("UNKNOWN_FLAG");
    expect(err?.suggestions[0]).toContain("use --json-out");
  });

  it("home derives today server-side and suggests the days trend", async () => {
    const out = await homeCommand([]);
    // The home view points at `days` for the multi-day trend (contextual disclosure).
    expect(out).toContain("days");
    // A real configured zone ⇒ no UTC-fallback note on the home view.
    expect(out).not.toContain("KITCHEN_OWNER_TZ unset");
  });
});
