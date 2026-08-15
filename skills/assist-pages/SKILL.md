---
name: assist-pages
description: >-
  Publish interactive pages and worksheets to stable URLs and collect structured
  responses, via the bundled pages-axi CLI. Use whenever a human needs to act on
  something that outlives the current turn — a decision queue, a review-and-annotate
  artifact, an option picker — and ALWAYS when collecting quantities a human must
  physically measure. Triggers: "prep sheet", "worksheet", "publish a page", "collect
  weights", "make me a form", "send me something to fill in", "what came back from
  that page", "review page", "check responses".
---

# assist-pages

Publish self-contained pages and worksheets, and collect structured responses, via the
bundled **`pages-axi`** CLI — a script in this skill's `scripts/` directory (not on
`PATH`). Invoke it by its path relative to this skill's base directory:

```bash
scripts/pages-axi                       # home: active pages + response backlog
scripts/pages-axi --help                # full command list
```

Output is TOON (compact tables). The server defaults to `http://localhost:2529`;
override with `CLAUDE_ASSIST_SERVER`.

## Choosing the right surface

**This is the most important decision, and the one most often gotten wrong.**

| What you need | Use |
| --- | --- |
| The human states **measured quantities** and you need computed totals | **`publish-worksheet`** |
| The human reviews, annotates, picks, or approves | `publish` (authored HTML) |
| Anything they'll finish later, on a phone, with no session running | either — that's what a page is *for* |
| A conversation | not a page |

### A sheet that PRESCRIBES quantities is not a collection surface

If the artifact's purpose is to learn **what actually happened**, it must have inputs.
Handing over planned numbers in a document — chat, markdown, PDF — and then recording
the result produces totals nobody measured. That is an invented total wearing the
costume of a measurement.

**Never substitute a static document for a worksheet because the tool seems
unavailable.** If you genuinely cannot publish, say so plainly, say what you are
handing over instead, and call it a plan — never a "sheet".

## Worksheets

A worksheet is one typed pattern: **weighable components with per-basis reference
values → named numeric totals.** You publish a *definition* (data, not HTML); the
module renders the one canonical document and, on submit, **computes the totals
server-side** from that same definition.

This matters because the alternative — hand-authored HTML with bespoke client-side
arithmetic — re-implements the same math per page, posts a payload whose shape is
convention rather than contract, and lets the client state its own results.

```jsonc
{
  "kind": "worksheet", "version": 1,
  "heading": "Prep — a grain bowl",
  "intro": "Weigh each component and correct the numbers below.",
  "basis": 100,                            // per-N reference basis
  "unit": "g",
  "fields":     [ { "key": "calories", "label": "Calories", "precision": 0 } ],
  "components": [ { "label": "cooked grain", "quantity": 200,
                    "per_basis": { "calories": 130 }, "note": "weigh it" } ],
  "steps": ["Anything the human must do, in order"],
  "submit_label": "Ate it — log this"
}
```

- **Planned quantities are defaults, not claims.** Pre-fill what you expect; the human
  corrects as they build.
- **A component that omits a field contributes *unknown* to it**, never zero. The
  total is null only when no component carried that field.
- Republishing a slug adds a version; a submission validates against the definition
  currently *served*.

### Get the reference values from the owning system, never from memory

`per_basis` blocks are reference data that some system of record already holds.
Transcribing them by hand reintroduces exactly the recall-instead-of-lookup error the
worksheet exists to eliminate — and a hand-built definition can silently disagree with
the catalog it was copied from. **Prefer a domain wrapper that builds the definition
from its own records** (e.g. the kitchen module's `prep publish`) over assembling JSON
yourself. Reach for `publish-worksheet` directly only when no domain owns the numbers.

## Cook mode — when submitting IS the write

A worksheet may declare `cook_mode`, and then the human's submit performs the domain
write directly, with no agent in the loop.

**Prefer it over a submission that waits for an agent.** That wait is where records
die: a real sheet went unsubmitted, nobody noticed, and the record had to be
reconstructed from memory days later. A loop that depends on a second actor showing up
is a loop that sometimes doesn't close.

**`cook_mode` is opaque to this CLI.** It is passed through inside the definition, and
`pages-axi` has no flags for it and no knowledge of what a disposition means — that
vocabulary belongs to the module that consumes it. Read the consuming module's spec
(and prefer its wrapper command) to build one.

## Reading what came back

- `responses <slug> --unprocessed` — the queue for one page.
- `mark-processed <slug> <id> --by <name>` — after you handle one. Append-only: the
  payload is never altered.
- A cook-mode submission arrives **already processed** (the write happened) — its
  `processed_by` records which sink handled it, so don't re-log it by hand. Doing so
  double-counts.

## Commands

<!-- BEGIN GENERATED: command-reference -->

### Publish

- `scripts/pages-axi publish <file> --slug <slug> [--title <title>] [--digest-optin]` — publish (or republish) a self-contained HTML file; prints the stable URL. Republishing a slug adds a version at the same URL. --title defaults to the file's <title>, then the slug
- `scripts/pages-axi publish-worksheet <definition.json> --slug <slug> [--title <title>] [--digest-optin]` — publish a WORKSHEET — weighable components whose real quantities the human states, with totals computed server-side. Use this for anything that collects measured amounts; a hand-authored HTML form re-implements arithmetic the module already owns. Pass `-` to read the definition from stdin
- `scripts/pages-axi archive <slug>` — remove a page from the index (all storage retained; republishing revives it)

### Collect

- `scripts/pages-axi list` — active pages, newest first, with their response backlog
- `scripts/pages-axi responses <slug> [--since <iso>] [--unprocessed]` — read a page's response queue (oldest first)
- `scripts/pages-axi mark-processed <slug> <id> --by <name>` — mark one response handled (append-only: never alters the payload)

<!-- END GENERATED: command-reference -->

## Notes

- Pages are served only on the instance's own reachable interface — never publicly —
  which is what makes a page a legitimate home for content that could not be shared
  more broadly.
- Nothing is destroyed: a republish adds a version, a response is immutable but for
  its processed marker, and archive is a soft flag.
- Publishing a worksheet creates **nothing** in any domain ledger. A definition is a
  form awaiting a real event.
