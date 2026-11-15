/**
 * The CLI sites of bare-date coercion (specs/modules/kitchen.md § Logged-at
 * backdating — "Bare-date coercion → local noon"): every `--at` flag, and the
 * inventory flags that name a calendar day and must NOT be coerced.
 *
 * The helper itself and the server-side ingest are covered in
 * `../date-coerce.test.ts`, which also explains why these assertions use
 * concrete Eastern offsets and where the zone is pinned (bunfig.toml).
 */

import { describe, expect, it } from "bun:test";
import { buildLogEntryFields, buildPatchBody } from "./commands/entries.js";
import { validateCalendarDate, validateDate } from "./args.js";

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

describe("validateCalendarDate — inventory flags name a day, not an instant", () => {
  it("passes a bare YYYY-MM-DD through verbatim where validateDate would coerce it", () => {
    expect(validateCalendarDate("2026-07-24", "--at", "usage")).toBe("2026-07-24");
    expect(validateDate("2026-07-24", "--at", "usage")).toBe("2026-07-24T12:00:00-04:00");
  });

  it("keeps the waste window in the shape its route accepts", () => {
    // The route pins since/until to ^\d{4}-\d{2}-\d{2}$ and compares them
    // against bare toss dates as strings. An instant is not merely redundant
    // there — it is rejected, and before that it excluded same-day tosses.
    const routePattern = /^\d{4}-\d{2}-\d{2}$/;
    expect(routePattern.test(validateCalendarDate("2026-07-24", "--since", "usage"))).toBe(true);
    expect(routePattern.test(validateDate("2026-07-24", "--since", "usage"))).toBe(false);
  });

  it("still passes a full timestamp through, and still rejects nonsense", () => {
    expect(validateCalendarDate("2026-07-24T15:00:00-04:00", "--at", "usage")).toBe("2026-07-24T15:00:00-04:00");
    expect(() => validateCalendarDate("not-a-date", "--at", "usage")).toThrow(/Invalid date for --at/);
    expect(() => validateCalendarDate("2026-13-45", "--at", "usage")).toThrow(/Invalid date for --at/);
  });
});
