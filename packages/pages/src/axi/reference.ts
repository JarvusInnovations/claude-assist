/**
 * Single source of truth for the tool description and the command surface. Used
 * by `--help` (`bin.ts`) and the static SKILL.md generator (`skill.ts`), so the
 * skill's command reference can never drift from the CLI.
 *
 * Every command is a thin veneer over one documented `/api/pages` endpoint
 * (specs/modules/pages.md § API surface) — the CLI adds no semantics the API
 * lacks, and per § The CLI carries no domain vocabulary it never learns what a
 * cook-mode disposition means.
 */

export const DESCRIPTION =
  "Publish self-contained HTML pages and worksheets to stable URLs, and collect " +
  "structured responses back from them.";

export interface CommandRef {
  usage: string;
  summary: string;
}

export interface CommandGroup {
  group: string;
  commands: CommandRef[];
}

export const COMMAND_GROUPS: CommandGroup[] = [
  {
    group: "Publish",
    commands: [
      {
        usage: "publish <file> --slug <slug> [--title <title>] [--digest-optin]",
        summary:
          "publish (or republish) a self-contained HTML file; prints the stable URL. " +
          "Republishing a slug adds a version at the same URL. --title defaults to the " +
          "file's <title>, then the slug",
      },
      {
        usage: "publish-worksheet <definition.json> --slug <slug> [--title <title>] [--digest-optin]",
        summary:
          "publish a WORKSHEET — weighable components whose real quantities the human " +
          "states, with totals computed server-side. Use this for anything that collects " +
          "measured amounts; a hand-authored HTML form re-implements arithmetic the module " +
          "already owns. Pass `-` to read the definition from stdin",
      },
      {
        usage: "archive <slug>",
        summary: "remove a page from the index (all storage retained; republishing revives it)",
      },
    ],
  },
  {
    group: "Collect",
    commands: [
      {
        usage: "list",
        summary: "active pages, newest first, with their response backlog",
      },
      {
        usage: "responses <slug> [--since <iso>] [--unprocessed]",
        summary: "read a page's response queue (oldest first)",
      },
      {
        usage: "mark-processed <slug> <id> --by <name>",
        summary: "mark one response handled (append-only: never alters the payload)",
      },
    ],
  },
];

/**
 * The worksheet definition's shape, quoted in `--help` so an author does not
 * have to open the spec to build one. Deliberately terse — the authoritative
 * contract is specs/modules/pages.md § The worksheet definition.
 *
 * `cook_mode` is listed but NOT explained here: it is opaque pass-through data
 * whose meaning belongs to the domain module that consumes it.
 */
export const WORKSHEET_SHAPE = `{
  "kind": "worksheet", "version": 1,
  "heading": "…", "intro": "…",          // optional
  "basis": 100, "unit": "g",              // per-N reference basis, quantity unit
  "fields":     [ { "key": "calories", "label": "Calories", "precision": 0 } ],
  "components": [ { "label": "…", "quantity": 200,
                    "per_basis": { "calories": 130 }, "note": "…" } ],
  "steps": ["…"],                         // optional instructions
  "submit_label": "…",                    // optional
  "cook_mode": { … }                      // optional; opaque to this CLI —
}                                         //   see the consuming module's spec`;
