# claude-assist

Public toolkit: generic modules (capture, diet, briefing, sessions, …) for an
individual agent's instance. **Repo boundary: no instance data, hostnames, or
personal content in any git surface — code, specs, plans, PR bodies, or
history.** Records enter an instance only through module APIs at runtime.

## Spec-driven development (specops)

This project uses spec-driven development. `specs/` is the source of truth for
what *should be true*; `plans/` is the work-in-flight DAG that bridges specs to
merged code. The **specops** skill carries the full methodology — invoke it
(the skill triggers on "spec", "plan", starting a feature, etc.) before writing
specs, planning, or building.

- **Specs lead.** Before changing behavior, change the spec; bring code into
  conformance after. Spec↔code drift is a bug, not debt. Specs merge
  implemented-or-planned; a spec still being designed rides a draft planning
  PR, not the main branch.
- **`plans/` is the planning system — not your built-in plan mode.** Every
  chunk of work lands as a file in `plans/` that freezes to `done` as the
  durable record of what got built. Don't skip it for "small" changes.
- **When to author a plan depends on intent:** mapping a batch of specs →
  finish the batch first, then propose a *set* of plans; speccing one bounded
  feature → draft the spec change and its plan in tandem; unclear → ask.
- **A spec change ripples to its plans.** After editing a spec, review the
  plans that implement it (`grep -l '<spec-path>' plans/*.md`) and offer to
  update them.

Query the DAG: `.agents/skills/specops/scripts/specops next` and
`.agents/skills/specops/scripts/specops dag`.

Existing modules predate `specs/` — back-spec opportunistically when touching
them; new modules start spec-first.
