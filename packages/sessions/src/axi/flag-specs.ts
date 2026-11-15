import type { FlagSpec } from "../../../core/src/axi/flags.js";

/**
 * Every command's declared arguments, in one table
 * (specs/behaviors/axi-cli-arguments-and-export.md § Declared arguments). The
 * parser rejects anything not listed here, and the tests walk this table: each
 * command is run with a bogus flag, and each declared flag must appear in that
 * command's `--help`.
 */
export const FLAG_SPECS = {
  home: { value: ["project", "recent"], boolean: ["all"], jsonOut: true },
  search: {
    value: [
      "query",
      "project",
      "days",
      "since",
      "until",
      "tools",
      "files-read",
      "files-written",
      "machine",
      "min-user-messages",
      "limit",
      "offset",
    ],
    boolean: ["forever", "include-empty"],
    jsonOut: true,
  },
  grep: {
    value: ["tool", "match", "in", "context", "limit", "after", "before", "project", "days"],
    boolean: ["include-sidechain"],
    positionals: 1,
    usage: "sessions-axi grep [<session-id>] --tool SUBSTR | --match SUBSTR [flags]",
    jsonOut: true,
  },
  transcript: {
    value: ["after", "before", "group", "project", "min-user-messages", "around"],
    boolean: ["include-tools"],
    positionals: 1,
    usage: "sessions-axi transcript [<session-id>] [flags]",
    // Offered in --around mode only; the handler refuses it for plain text.
    jsonOut: true,
  },
  details: {
    boolean: ["raw"],
    positionals: 1,
    usage: "sessions-axi details <session-id> [--raw --json-out[=path]]",
    jsonOut: true,
  },
  activity: { value: ["days"], jsonOut: true },
  engagement: {
    value: ["from", "to", "tz", "block-minutes", "gap-minutes", "day-start"],
    boolean: ["sessions", "blocks"],
    jsonOut: true,
  },
  stats: { value: ["days", "machine"], jsonOut: true },
  machines: { jsonOut: true },
  outlines: { positionals: "many", jsonOut: true },
  sync: { boolean: ["force"], jsonOut: true },
  share: { positionals: 1, usage: "sessions-axi share <session-id>", jsonOut: true },
} satisfies Record<string, FlagSpec>;

export type CommandName = keyof typeof FLAG_SPECS;
