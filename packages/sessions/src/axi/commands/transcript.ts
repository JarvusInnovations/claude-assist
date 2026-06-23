import { AxiError } from "axi-sdk-js";
import { api } from "../client.js";
import { parseArgs, rawJson, validateDate } from "../args.js";
import { cliInvocation } from "../invocation.js";

export const TRANSCRIPT_HELP = `sessions-axi transcript <session-id> [flags]                 # one session
sessions-axi transcript --after DATE --before DATE [flags]   # cross-session, a time range
sessions-axi transcript <session-id> --around <uuid> [--before N] [--after M]   # explore around an anchor

  Compact, token-efficient transcript text ([U] user, [A] assistant, [T] tool).
  With a session id → that session. Without one → every session overlapping the
  given window (the primary tool for "what did I work on <when>?").

  --after DATE             start of window (ISO 8601 / YYYY-MM-DD; required when no id)
  --before DATE            end of window (ISO 8601 / YYYY-MM-DD; required when no id)
  --group project|time     cross-session grouping (default project)
  --project PATH           cross-session: filter to a project path (substring)
  --min-user-messages N    cross-session: hide subagent sessions (default 2)
  --include-tools          include [T] tool-call lines (excluded by default)

  Anchor exploration (the follow-up to a \`grep\` match):
  --around <uuid>          read a window of messages around this message uuid
  --before N / --after M   in --around mode these are message COUNTS (not dates);
                           the result lists head/tail anchors + how much remains,
                           so you can keep walking outward. --json for raw.`;

export async function transcriptCommand(args: string[]): Promise<string> {
  const { positionals, flags } = parseArgs(args, ["include-tools", "json"]);
  const id = positionals[0];

  // Anchor-exploration mode (#48): read a variable range around a message uuid.
  // Here --before/--after are message counts, not dates.
  if (typeof flags.around === "string") {
    if (!id) {
      throw new AxiError("--around needs a <session-id>", "VALIDATION_ERROR", [TRANSCRIPT_HELP]);
    }
    const window = await api.get(`/api/sessions/${encodeURIComponent(id)}/transcript`, {
      around: flags.around,
      before: typeof flags.before === "string" ? flags.before : undefined,
      after: typeof flags.after === "string" ? flags.after : undefined,
    });
    if (flags.json) return rawJson(window);
    const cli = cliInvocation();
    const out: string[] = [
      `around ${flags.around}:`,
      ...(window.lines ?? []),
      `↕ ${window.more_before} before · ${window.more_after} after${window.truncated ? " · window truncated" : ""}`,
    ];
    if (window.more_before > 0) {
      out.push(`extend back:    ${cli} transcript ${id} --around ${window.head} --before 30 --after 0`);
    }
    if (window.more_after > 0) {
      out.push(`extend forward: ${cli} transcript ${id} --around ${window.tail} --before 0 --after 30`);
    }
    return out.join("\n");
  }

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
