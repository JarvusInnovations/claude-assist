# Behavior: AXI CLI arguments and machine output

## Rule

The agent-facing CLIs bundled in this repo's skills hold three rules about what
they accept and what they print:

1. **Every argument is declared.** A flag or positional a command does not
   declare fails the command before any network call or file write. Nothing is
   silently dropped.
2. **Stdout is always the TOON view.** There is no JSON mode on stdout. The full
   JSON payload goes to a file, on request, through `--json-out[=path]`.
3. **A column name is a data key.** A column an agent reads in a TOON table works
   as a key in a `jq` expression against the exported file.

## Applies To

`sessions-axi` and `kitchen-axi` conform. `gmail-axi`, `google-axi` and
`pages-axi` predate the rule and still print `--json` to stdout; each conforms
when it is next touched, using the same shared modules.

The house style these rules come from is vendored at
`.agents/skills/jarvus-axi/` (`references/flags.md`,
`references/machine-output.md`).

## Details

### Declared arguments

Each command or subcommand has one declaration: its value flags, its switches,
its repeatable flags, how many positionals it takes, and whether it offers a
JSON export. One parser, shared by the conforming CLIs, checks every invocation
against it.

| Input | Code | The error says |
| --- | --- | --- |
| Unknown flag | `UNKNOWN_FLAG` | the command's valid flags |
| A retired or commonly guessed flag (`--json`) | `UNKNOWN_FLAG` | the flag to use instead |
| Value flag with no value | `USAGE` | which flag |
| Switch given a value | `USAGE` | that it takes none |
| A non-repeatable flag given twice | `USAGE` | which flag |
| More positionals than the command takes | `USAGE` | the count it takes and its usage line |

All of these exit `2`, as `VALIDATION_ERROR` does.

Lexical rules:

- `--flag value` and `--flag=value` both work. `--json-out` is the exception: it
  takes its path only with `=`.
- Only `--<letter>` starts a flag. Free text that leads with a dash (`- item`,
  `---`) and negative numbers are values. A lone `-x` is rejected as a short
  flag, which these CLIs do not have.
- A value flag followed by another flag is a missing value. A value that really
  does begin with `--` is passed with `=`.
- `--` ends flag parsing.
- `--help` is valid on every command.

`--json` must parse bare, so that it reaches its hint and does not fail first as
a flag missing its value.

### `--json-out[=path]`

- **Bare flag:** the file is `<tmpdir>/<tool>/<UTC timestamp>-<command>.json`.
  The directory is `0700` and the file `0600`, each set explicitly after
  creation because a creation mode is subject to the umask. The directory must
  be a real directory owned by the caller; otherwise the export is refused. The
  file is created exclusively, and a name clash gets `-2`, `-3`.
- **`=path`:** written where the caller says, `0600`. The parent directory must
  exist. A symlink, a directory or another non-regular file at the path is
  refused. Replacing an existing file is reported as `overwrote:`.
- **The space form is an error.** `--json-out out.json` fails and names the `=`
  form, so a following positional is never taken for a path.
- **The path is checked before any work**: before the API call, and so before a
  mutation is sent.
- **The file is the API's own body**, complete, in the shape the server returned
  it. Where a view is assembled from several calls (the home views), the file is
  the assembled object.
- **A failed write keeps the view.** The command prints its normal output, adds
  an `export_error:` line, removes any partial file and exits `1`.

Stdout with the flag is the same view as without it, plus:

```
wrote: /tmp/kitchen-axi/2026-01-05T14-02-11-123Z-days.json (1 object, 4 keys)
columns: group, today, tz, days[7]{day,calories,protein_g,…}
help[1]:
  Run `jq '.days[]' /tmp/kitchen-axi/2026-01-05T14-02-11-123Z-days.json` to process the full result
```

- `wrote:` gives the path and the size: rows and columns for an array of
  records, keys for an object.
- `columns:` gives the keys. For an object, a key holding records is shown as
  `key[n]{…}` with the record keys inside, and a key holding an object as
  `key{…}`.
- The hint is a runnable `jq` command against that exact path. When the view
  already ends in a `help[]` block, the hint joins it as its last line.

A command with no JSON form refuses the flag and says why. `sessions-axi
transcript` prints text, so it offers the export only in `--around` mode.

`sessions-axi details --raw` and `engagement --blocks` add data that has no TOON
form (the raw message array, the merged blocks). They add it to the export, so
each requires `--json-out` and fails without it.

### Column names

A plain column carries the data key it reads: `product_name`, not `name`;
`days_until_eat_by`, not `days_left`. The value may still be formatted for
reading (a relative time, a count of an array, a truncated string).

Two kinds of column are not data keys, and are named so they cannot be mistaken
for one:

- **Computed columns**, which hold a value the file does not: `eff_kcal`
  (base × multiplier), `range`, `last_activity`, and `project` in
  `sessions-axi search` (the last segment of `project_path`).
- **Flattened references**, which collapse several keys into one cell: `title`
  (`title`, else `session_name`), `project` in `activity` and `engagement`
  (`project_name`, else `project_path`).

The entry detail view keeps `base_*` names for the stored macros
(`base_kcal` for `calories`). They sit beside the `eff_*` columns, and the
prefix is what stops a reader taking a base figure for what was eaten
(`specs/modules/kitchen.md` § Portion multiplier).
