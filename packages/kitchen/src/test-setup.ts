/**
 * Package-wide test setup, wired via `bunfig.toml` `[test] preload`.
 *
 * Pins the machine zone for EVERY suite in this package. Several of them assert
 * concrete local offsets (bare-date → local-noon coercion, owner-timezone day
 * bucketing, weigh-in offset capture). Those assertions are deliberate — an
 * offset tracking the *dated* day across a DST boundary is exactly the bug class
 * they guard — but they need a known zone to be stable.
 *
 * This used to live as `process.env.TZ = ...` at the top of date-coerce.test.ts.
 * Bun shares one process across a package's test files, so that mutation leaked
 * into every other suite and made their correctness depend on FILE LOAD ORDER:
 * a suite importing after date-coerce ran in Eastern, the same suite run alone
 * ran in the runner's ambient zone. That's how a weigh-ins offset assertion came
 * to pass only incidentally (comparing -0 against 0 under Object.is), then fail
 * the moment it ran without date-coerce loaded.
 *
 * A preload makes the zone an explicit package-wide invariant: every suite gets
 * it, no suite establishes it, and none of them care who loads first. Bun
 * re-reads process.env.TZ on each Date construction, so setting it here — before
 * any test file is imported — is sufficient. (`[test] env` in bunfig is NOT:
 * it lands too late to affect Date.)
 */
process.env.TZ = "America/New_York";
