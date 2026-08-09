---
status: in-progress
depends: []
specs:
  - specs/principles.md
  - specs/architecture.md
issues: []
---

# Plan: Genericization pass — this is a toolkit, not one person's server

## Scope

Close the remaining gap between what this repo *is* (a public toolkit that many
people deploy their own instance of) and how parts of it still *read* (one
person's running server). A prior pass externalized the big items — seed rules,
the interest spec, rosters, several env aliases — so what remains is a tail:
instance names in plan prose, a private host in a test fixture, private CLI
names hardcoded where a config seam belongs, personal defaults in the env
schema, a deploy guide that documents one specific machine, and a README that
never says any of this out loud.

**Out of scope**: renaming the published packages, and any behavior change
beyond what a config seam requires. Every rename keeps a back-compatible alias.

## Implements

- **specs/principles.md § The toolkit is generic; the instance is private**.
- **specs/architecture.md § Shape** — the toolkit/instance split stated where a
  reader will actually find it.

## Approach

- **Names**: scrub the assistant's name, the owner's name, the companion app,
  and private plan filenames out of `plans/` prose; replace a private host in a
  notify test with an example host; replace a private codename that shipped as a
  compiled-in default with a neutral example.
- **Seams, not deletions**: private CLI names that are hardcoded (an outbound
  action-classification rule set, a calendar source binary) move behind config
  with the current value as a documented example, so an instance keeps working
  unchanged.
- **Env naming**: finish the aliasing already begun — an instance-named variable
  keeps working with a deprecation warning while the generic name becomes
  canonical.
- **Personal defaults**: a timezone default is a personal fact. Follow the
  pattern one module already gets right — no default, an explicit UTC fallback,
  and a documented variable — rather than baking one city into the schema.
- **Deploy docs**: rewrite the systemd guide as an install procedure with
  substitutable paths instead of a narrative about one host's service topology.
- **README**: lead with the toolkit/instance framing, fix the stale module and
  endpoint lists, and point at `specs/` and `docs/`.

## Validation

- [ ] No personal name, assistant name, private host, private codename, or
      private plan filename in any tracked file.
- [ ] Private CLI names appear only as documented example values of config, not
      as hardcoded behavior.
- [ ] Instance-named env vars have generic canonical names with back-compatible
      aliases and boot-time deprecation warnings.
- [ ] No personal timezone as a schema default.
- [ ] `deploy/` reads as an install guide, not as a description of one machine.
- [ ] README opens with the toolkit-vs-instance framing and lists the modules
      that actually ship.
- [ ] `bun test` green — every rename is back-compatible.

## Risks / unknowns

- **Silent breakage for an existing instance** — a renamed variable that stops
  being read breaks a live deployment quietly. Every rename keeps the old name
  working and warns; none is removed in this pass.
- **Over-scrubbing** — the publishing organization's name and package scope are
  not instance data and stay. The line is person/host/private-system, not
  "anything specific".

## Notes

(populated at closeout)

## Follow-ups

(populated at closeout)
