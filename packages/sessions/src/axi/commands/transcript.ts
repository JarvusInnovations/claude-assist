import { AxiError } from "axi-sdk-js";
import { api } from "../client.js";
import { parseArgs, validateDate } from "../args.js";

export const TRANSCRIPT_HELP = `sessions-axi transcript <session-id> [flags]      # one session
sessions-axi transcript --after DATE --before DATE [flags]   # cross-session, a time range

  Compact, token-efficient transcript text ([U] user, [A] assistant, [T] tool).
  With a session id → that session. Without one → every session overlapping the
  given window (the primary tool for "what did I work on <when>?").

  --after DATE             start of window (ISO 8601 / YYYY-MM-DD; required when no id)
  --before DATE            end of window (ISO 8601 / YYYY-MM-DD; required when no id)
  --group project|time     cross-session grouping (default project)
  --project PATH           cross-session: filter to a project path (substring)
  --min-user-messages N    cross-session: hide subagent sessions (default 2)
  --include-tools          include [T] tool-call lines (excluded by default)`;

export async function transcriptCommand(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["include-tools"]);
  const id = positionals[0];

  const after = typeof flags.after === "string" ? validateDate(flags.after, "--after", TRANSCRIPT_HELP) : undefined;
  const before = typeof flags.before === "string" ? validateDate(flags.before, "--before", TRANSCRIPT_HELP) : undefined;
  const includeTools = flags["include-tools"] ? "true" : undefined;

  let text: string;
  if (id) {
    text = await api.getText(`/api/sessions/${encodeURIComponent(id)}/transcript`, {
      after,
      before,
      include_tools: includeTools,
    });
  } else {
    if (!after || !before) {
      throw new AxiError("Cross-session transcript needs both --after and --before", "VALIDATION_ERROR", [
        TRANSCRIPT_HELP,
      ]);
    }
    const group = typeof flags.group === "string" ? flags.group : undefined;
    if (group && group !== "project" && group !== "time") {
      throw new AxiError(`--group must be project or time (got ${group})`, "VALIDATION_ERROR", [TRANSCRIPT_HELP]);
    }
    text = await api.getText("/api/sessions/transcript", {
      after,
      before,
      group,
      project: typeof flags.project === "string" ? flags.project : undefined,
      min_user_messages: typeof flags["min-user-messages"] === "string" ? flags["min-user-messages"] : undefined,
      include_tools: includeTools,
    });
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return id
      ? "transcript: empty (no messages in range, or unknown session)"
      : "transcript: no sessions found overlapping that window";
  }
  return trimmed;
}
