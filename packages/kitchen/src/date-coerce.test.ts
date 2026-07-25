/**
 * Bare-date → local-noon coercion (specs/modules/kitchen.md § Logged-at
 * backdating — "Bare-date coercion → local noon").
 *
 * DETERMINISM: these tests pin the machine zone to US-Eastern via TZ so the
 * "buckets on the intended day, not the day before" assertions are stable
 * regardless of the runner's ambient zone. Bun re-reads process.env.TZ on each
 * Date construction, so setting it here (before any Date is built) is enough.
 * Expectations are written against the concrete Eastern offsets (EDT -04:00 in
 * summer, EST -05:00 in winter) rather than the ambient zone.
 */
process.env.TZ = "America/New_York";

import { describe, expect, it } from "bun:test";
import { coerceBareDateToLocalNoon } from "./date-coerce.js";
import { normalizeNewEntry } from "./store.js";
import { buildLogEntryFields, buildPatchBody } from "./axi/commands/entries.js";
import { validateDate } from "./axi/args.js";

describe("coerceBareDateToLocalNoon — the shared choke-point helper", () => {
  it("coerces a bare YYYY-MM-DD to local noon WITH the dated day's offset (EDT)", () => {
    // 2026-07-24 is summer → EDT (-04:00). Noon local, never midnight UTC.
    expect(coerceBareDateToLocalNoon("2026-07-24")).toBe("2026-07-24T12:00:00-04:00");
  });

  it("the coerced instant buckets on the intended Eastern day, not the day before", () => {
    // The bug this fixes: new Date('2026-07-24') is midnight UTC = 23rd 20:00
    // Eastern, so a bare date logged for the 24th lands on the 23rd. getDate()
    // reads the Eastern day here (TZ pinned above).
    const buggy = new Date("2026-07-24"); // naive parse — UTC midnight
    expect(buggy.getDate()).toBe(23); // demonstrates the day-early bug

    const coerced = new Date(coerceBareDateToLocalNoon("2026-07-24"));
    expect(coerced.getDate()).toBe(24); // the fix: lands on the intended day
    expect(coerced.getHours()).toBe(12); // at local noon
  });

  it("passes a full ISO timestamp through unchanged (with offset, Z, or no offset)", () => {
    expect(coerceBareDateToLocalNoon("2026-07-24T15:00:00-04:00")).toBe("2026-07-24T15:00:00-04:00");
    expect(coerceBareDateToLocalNoon("2026-07-24T15:00:00Z")).toBe("2026-07-24T15:00:00Z");
    expect(coerceBareDateToLocalNoon("2026-07-24T15:00:00")).toBe("2026-07-24T15:00:00");
    expect(coerceBareDateToLocalNoon("2026-07-24T00:00:00-04:00")).toBe("2026-07-24T00:00:00-04:00");
  });

  it("uses the dated day's offset across the DST boundary (winter EST vs summer EDT)", () => {
    // Winter date → EST (-05:00); summer date → EDT (-04:00). The offset tracks
    // the DATED day, not today, so DST is honored per-date.
    expect(coerceBareDateToLocalNoon("2026-01-15")).toBe("2026-01-15T12:00:00-05:00");
    expect(coerceBareDateToLocalNoon("2026-07-15")).toBe("2026-07-15T12:00:00-04:00");
  });

  it("lands on the intended day at a DST-transition boundary (spring forward, fall back)", () => {
    // US DST 2026: starts Sun Mar 8 (spring forward at 02:00), ends Sun Nov 1
    // (fall back at 02:00). Noon is safely past either 02:00 transition, so the
    // day is unambiguous.
    const springForward = new Date(coerceBareDateToLocalNoon("2026-03-08"));
    expect(springForward.getMonth()).toBe(2); // March
    expect(springForward.getDate()).toBe(8);
    expect(springForward.getHours()).toBe(12);
    expect(coerceBareDateToLocalNoon("2026-03-08")).toBe("2026-03-08T12:00:00-04:00"); // already EDT at noon

    const fallBack = new Date(coerceBareDateToLocalNoon("2026-11-01"));
    expect(fallBack.getMonth()).toBe(10); // November
    expect(fallBack.getDate()).toBe(1);
    expect(fallBack.getHours()).toBe(12);
    expect(coerceBareDateToLocalNoon("2026-11-01")).toBe("2026-11-01T12:00:00-05:00"); // EST at noon
  });

  it("lands on the intended day at a month boundary (first of the month, not the last of the prior)", () => {
    const firstOfMonth = new Date(coerceBareDateToLocalNoon("2026-07-01"));
    expect(firstOfMonth.getMonth()).toBe(6); // July
    expect(firstOfMonth.getDate()).toBe(1); // not June 30
  });
});

describe("CLI --at coercion at every site (validateDate + the entries builders)", () => {
  it("validateDate coerces a bare date and passes a full timestamp through — this is the expenditure-log site", () => {
    // `expenditure log --at` calls validateDate(flags.at, ...) directly, so this
    // covers the third --at site (entries log / entries patch are below).
    expect(validateDate("2026-07-24", "--at", "usage")).toBe("2026-07-24T12:00:00-04:00");
    expect(validateDate("2026-07-24T15:00:00-04:00", "--at", "usage")).toBe("2026-07-24T15:00:00-04:00");
  });

  it("validateDate still rejects a malformed date (coercion does not loosen validation)", () => {
    expect(() => validateDate("2026-13-99", "--at", "usage")).toThrow();
    expect(() => validateDate("not-a-date", "--at", "usage")).toThrow();
  });

  it("entries log --at: bare date → local noon; full timestamp verbatim", () => {
    const bare = buildLogEntryFields(["party", "dish"], { at: "2026-07-24" }, []);
    expect(bare.logged_at).toBe("2026-07-24T12:00:00-04:00");

    const full = buildLogEntryFields(["party", "dish"], { at: "2026-07-24T15:00:00-04:00" }, []);
    expect(full.logged_at).toBe("2026-07-24T15:00:00-04:00");
  });

  it("entries patch --at: bare date → local noon; full timestamp verbatim", () => {
    const bare = buildPatchBody({ at: "2026-07-24" });
    expect(bare.logged_at).toBe("2026-07-24T12:00:00-04:00");

    const full = buildPatchBody({ at: "2026-07-24T15:00:00-04:00" });
    expect(full.logged_at).toBe("2026-07-24T15:00:00-04:00");
  });
});

describe("server-side ingest coercion (normalizeNewEntry)", () => {
  it("coerces a bare-date logged_at to local noon on the intended Eastern day", () => {
    const e = normalizeNewEntry({ ulid: "01ABC", logged_at: "2026-07-24" });
    expect(e.logged_at.getDate()).toBe(24); // Eastern day, not the 23rd
    expect(e.logged_at.getHours()).toBe(12); // local noon
    expect(e.logged_at.toISOString()).toBe("2026-07-24T16:00:00.000Z"); // noon EDT == 16:00Z
  });

  it("preserves a full timestamp verbatim", () => {
    const e = normalizeNewEntry({ ulid: "01ABC", logged_at: "2026-07-24T15:00:00-04:00" });
    expect(e.logged_at.toISOString()).toBe("2026-07-24T19:00:00.000Z");
  });

  it("defaults to now (unchanged) when logged_at is omitted", () => {
    const now = new Date("2026-07-24T18:30:00Z");
    const e = normalizeNewEntry({ ulid: "01ABC" }, now);
    expect(e.logged_at).toBe(now);
  });
});
